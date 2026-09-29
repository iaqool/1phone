import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import {
  Connection, Keypair, PublicKey, SendTransactionError, sendAndConfirmTransaction,
  SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY, SystemProgram, Transaction, TransactionInstruction,
} from '@solana/web3.js';
import {
  createAccount, createMint, freezeAccount, getAccount, mintTo,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { eligibilityAddress, namespaceAddress, readTorquePreview, scopeFor } from '../src/torque.js';
import { buildConsumeInstruction, readEligibilityState } from '../src/eligibility.js';

// Integration tests run only against the local validator started with synthetic genesis accounts.
const RPC = 'http://127.0.0.1:18999';
const rpc = new Connection(RPC, 'confirmed');
const programId = new PublicKey((await readFile('program-id.txt', 'utf8')).trim());
const keys = JSON.parse(await readFile('.local/fixture-keys.json', 'utf8')) as Record<string, number[]>;
const manifest = JSON.parse(await readFile('.local/fixture-manifest.json', 'utf8')) as {
  synthetic: boolean;
  fixtures: Record<string, { mint: string; token: string }>;
};
assert(manifest.synthetic);
const signer = (name: string) => Keypair.fromSecretKey(Uint8Array.from(keys[name]));
const organizer = signer('organizer');
const holder = signer('holder');
const secondHolder = signer('secondHolder');
const outsider = signer('outsider');
const fixture = (name: string) => ({
  mint: new PublicKey(manifest.fixtures[name].mint),
  token: new PublicKey(manifest.fixtures[name].token),
});

function discriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function campaignAddress(id: Buffer) {
  return PublicKey.findProgramAddressSync([Buffer.from('campaign'), organizer.publicKey.toBuffer(), id], programId)[0];
}
function vaultAddress(campaign: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('vault'), campaign.toBuffer()], programId)[0];
}
function receiptAddress(campaign: PublicKey, mint: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('receipt'), campaign.toBuffer(), mint.toBuffer()], programId)[0];
}

function registerNamespaceInstruction(scope: Buffer, deadline: number): TransactionInstruction {
  const data = Buffer.alloc(48);
  discriminator('register_namespace').copy(data);
  scope.copy(data, 8);
  data.writeBigInt64LE(BigInt(deadline), 40);
  return new TransactionInstruction({ programId, data, keys: [
    { pubkey: organizer.publicKey, isSigner: true, isWritable: true },
    { pubkey: namespaceAddress(organizer.publicKey, scope), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ] });
}

function consumeInstruction(namespace: PublicKey, claimant: Keypair, sgt: { mint: PublicKey; token: PublicKey }): TransactionInstruction {
  return buildConsumeInstruction(programId, namespace, claimant.publicKey, sgt.mint, sgt.token);
}

type Campaign = { id: Buffer; address: PublicKey; vault: PublicKey; rewardMint: PublicKey; source: PublicKey; amount: bigint; max: number; deadline: number };
function initInstruction(c: Campaign, id: Buffer): TransactionInstruction {
  const data = Buffer.alloc(8 + 32 + 8 + 4 + 8);
  discriminator('init_campaign').copy(data);
  id.copy(data, 8);
  data.writeBigUInt64LE(c.amount, 40);
  data.writeUInt32LE(c.max, 48);
  data.writeBigInt64LE(BigInt(c.deadline), 52);
  return new TransactionInstruction({ programId, data, keys: [
    { pubkey: organizer.publicKey, isSigner: true, isWritable: true },
    { pubkey: c.address, isSigner: false, isWritable: true },
    { pubkey: c.rewardMint, isSigner: false, isWritable: false },
    { pubkey: c.source, isSigner: false, isWritable: true },
    { pubkey: c.vault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ] });
}

function claimInstruction(c: Campaign, claimant: Keypair, sgt: { mint: PublicKey; token: PublicKey }, destination: PublicKey, overrides: Partial<{ vault: PublicKey; rewardMint: PublicKey; destination: PublicKey }> = {}): TransactionInstruction {
  return new TransactionInstruction({ programId, data: discriminator('claim'), keys: [
    { pubkey: claimant.publicKey, isSigner: true, isWritable: true },
    { pubkey: c.address, isSigner: false, isWritable: true },
    { pubkey: receiptAddress(c.address, sgt.mint), isSigner: false, isWritable: true },
    { pubkey: sgt.mint, isSigner: false, isWritable: false },
    { pubkey: sgt.token, isSigner: false, isWritable: false },
    { pubkey: overrides.rewardMint ?? c.rewardMint, isSigner: false, isWritable: false },
    { pubkey: overrides.vault ?? c.vault, isSigner: false, isWritable: true },
    { pubkey: overrides.destination ?? destination, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ] });
}

function closeInstruction(c: Campaign, authority: Keypair, refund: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId, data: discriminator('close_campaign'), keys: [
    { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    { pubkey: c.address, isSigner: false, isWritable: true },
    { pubkey: c.rewardMint, isSigner: false, isWritable: false },
    { pubkey: c.vault, isSigner: false, isWritable: true },
    { pubkey: refund, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ] });
}

async function send(ix: TransactionInstruction, payer: Keypair): Promise<string> {
  return sendAndConfirmTransaction(rpc, new Transaction().add(ix), [payer], { commitment: 'confirmed' });
}

async function rejected(ix: TransactionInstruction, payer: Keypair, expected: RegExp): Promise<void> {
  await assert.rejects(async () => send(ix, payer), (error: unknown) => {
    const e = error as { message?: string; logs?: string[]; transactionLogs?: string[] };
    const details = [e.message, ...(e.logs ?? []), ...(e.transactionLogs ?? [])].join('\n');
    assert.match(details, expected, details);
    return true;
  });
}

async function rejectedOnChain(ix: TransactionInstruction, payer: Keypair, expected: RegExp): Promise<void> {
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(ix);
  tx.sign(payer);
  const signature = await rpc.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const confirmation = await rpc.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  assert(confirmation.value.err, 'transaction unexpectedly succeeded');
  let logs: string[] | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    logs = (await rpc.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))?.meta?.logMessages ?? undefined;
    if (logs) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(logs, 'confirmed failed transaction has no retrievable logs');
  assert.match(logs.join('\n'), expected);
}

async function waitForChainDeadline(deadline: number): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const clock = await rpc.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
    assert(clock && clock.data.length >= 40, 'validator Clock sysvar unavailable');
    if (clock.data.readBigInt64LE(32) >= BigInt(deadline)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail('validator did not reach the campaign deadline within 30 seconds');
}

async function campaign(amount = 10n, max = 2, deadline = Math.floor(Date.now() / 1000) + 3600): Promise<Campaign> {
  const id = randomBytes(32);
  const rewardMint = await createMint(rpc, organizer, organizer.publicKey, organizer.publicKey, 0);
  const source = await createAccount(rpc, organizer, rewardMint, organizer.publicKey);
  await mintTo(rpc, organizer, rewardMint, source, organizer, amount * BigInt(max));
  const address = campaignAddress(id);
  const c = { id, address, vault: vaultAddress(address), rewardMint, source, amount, max, deadline };
  await send(initInstruction(c, id), organizer);
  assert.equal((await getAccount(rpc, c.vault)).amount, amount * BigInt(max));
  return c;
}

async function snapshot(c: Campaign, destination: PublicKey, sgt: { mint: PublicKey }) {
  const state = await rpc.getAccountInfo(c.address);
  assert(state);
  return {
    claims: state.data.readUInt32LE(8 + 32 + 32 + 32 + 8 + 4),
    closed: state.data.readUInt8(8 + 32 + 32 + 32 + 8 + 4 + 4 + 8 + 32) === 1,
    vault: (await getAccount(rpc, c.vault)).amount,
    destination: (await getAccount(rpc, destination)).amount,
    receipt: Boolean(await rpc.getAccountInfo(receiptAddress(c.address, sgt.mint))),
  };
}

test('local validator executes campaign, SGT claim, rejection, rollback, and close', async (t) => {
  assert.equal((await rpc.getAccountInfo(fixture('valid').mint))?.owner.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  for (const key of [organizer, holder, secondHolder, outsider]) {
    const signature = await rpc.requestAirdrop(key.publicKey, 2_000_000_000);
    await rpc.confirmTransaction(signature, 'confirmed');
  }
  const c = await campaign();
  const destination = await createAccount(rpc, organizer, c.rewardMint, holder.publicKey);
  const secondDestination = await createAccount(rpc, organizer, c.rewardMint, secondHolder.publicKey);
  const refund = await createAccount(rpc, organizer, c.rewardMint, organizer.publicKey, Keypair.generate());
  const good = fixture('valid');

  await t.test('early and unauthorized close reject with unchanged campaign', async () => {
    await rejected(closeInstruction(c, organizer, refund), organizer, /TooEarly|0x1776/);
    await rejected(closeInstruction(c, outsider, refund), outsider, /ConstraintHasOne/);
    assert.equal((await snapshot(c, destination, good)).vault, 20n);
  });

  await t.test('spoofed fields and invalid holder accounts reject without receipt or transfer', async () => {
    for (const name of ['mintAuthority', 'pointerAuthority', 'metadataAddress', 'group', 'memberMint', 'noPointer', 'noMember', 'wrongMintProgram', 'oldHolder', 'wrongOwner', 'wrongProgram']) {
      const sgt = fixture(name);
      const before = await snapshot(c, destination, sgt);
      await rejected(claimInstruction(c, holder, sgt, destination), holder, /InvalidSgt|0x1772/);
      assert.deepEqual(await snapshot(c, destination, sgt), before, name);
    }
    const mismatch = { mint: good.mint, token: fixture('valid2').token };
    const before = await snapshot(c, destination, mismatch);
    await rejected(claimInstruction(c, holder, mismatch, destination), holder, /InvalidSgt|0x1772/);
    assert.deepEqual(await snapshot(c, destination, mismatch), before);
  });

  await t.test('vault, mint, destination constraints reject', async () => {
    const otherMint = await createMint(rpc, organizer, organizer.publicKey, null, 0);
    const otherVault = await createAccount(rpc, organizer, c.rewardMint, organizer.publicKey, Keypair.generate());
    const wrongDestination = await createAccount(rpc, organizer, c.rewardMint, outsider.publicKey);
    await rejected(claimInstruction(c, holder, good, destination, { vault: otherVault }), holder, /ConstraintHasOne/);
    await rejected(claimInstruction(c, holder, good, destination, { rewardMint: otherMint }), holder, /ConstraintHasOne/);
    await rejected(claimInstruction(c, holder, good, destination, { destination: wrongDestination }), holder, /ConstraintTokenOwner/);
    const noHolderSignature = claimInstruction(c, holder, good, destination);
    noHolderSignature.keys[0].isSigner = false;
    await rejected(noHolderSignature, organizer, /AccountNotSigner|0xbc2/);
    assert.deepEqual(await snapshot(c, destination, good), { claims: 0, closed: false, vault: 20n, destination: 0n, receipt: false });
  });

  await t.test('first claim succeeds, duplicate and new wallet with same mint fail', async () => {
    await send(claimInstruction(c, holder, good, destination), holder);
    assert.deepEqual(await snapshot(c, destination, good), { claims: 1, closed: false, vault: 10n, destination: 10n, receipt: true });
    await rejected(claimInstruction(c, holder, good, destination), holder, /already in use|0x0/);
    await rejected(claimInstruction(c, secondHolder, fixture('secondHolder'), secondDestination), secondHolder, /already in use|0x0/);
    assert.deepEqual(await snapshot(c, destination, good), { claims: 1, closed: false, vault: 10n, destination: 10n, receipt: true });
    assert.equal((await getAccount(rpc, secondDestination)).amount, 0n);
  });

  await t.test('two concurrent claims for one mint yield at most one payout', async () => {
    const race = await campaign(6n, 2);
    const firstTo = await createAccount(rpc, organizer, race.rewardMint, holder.publicKey);
    const secondTo = await createAccount(rpc, organizer, race.rewardMint, secondHolder.publicKey);
    const results = await Promise.allSettled([
      send(claimInstruction(race, holder, good, firstTo), holder),
      send(claimInstruction(race, secondHolder, fixture('secondHolder'), secondTo), secondHolder),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1, JSON.stringify(results));
    const failed = results.find((result) => result.status === 'rejected');
    assert(failed && failed.status === 'rejected');
    assert(failed.reason instanceof SendTransactionError);
    let failureLogs: string[] | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { failureLogs = await failed.reason.getLogs(rpc); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    assert(failureLogs, 'rejected concurrent transaction has no program logs');
    assert.match(failureLogs.join('\n'), /already in use/);
    assert.equal((await snapshot(race, firstTo, good)).claims, 1);
    assert.equal((await getAccount(rpc, firstTo)).amount + (await getAccount(rpc, secondTo)).amount, 6n);
  });

  await t.test('remaining capacity accepts different mint; exhausted cap blocks a third', async () => {
    const another = fixture('valid2');
    await send(claimInstruction(c, holder, another, destination), holder);
    assert.equal((await snapshot(c, destination, another)).claims, 2);
    const cap = await campaign(5n, 1);
    const capDestination = await createAccount(rpc, organizer, cap.rewardMint, holder.publicKey);
    await send(claimInstruction(cap, holder, good, capDestination), holder);
    const before = await snapshot(cap, capDestination, another);
    await rejected(claimInstruction(cap, holder, another, capDestination), holder, /ClaimLimit|0x1775/);
    assert.deepEqual(await snapshot(cap, capDestination, another), before);
  });

  await t.test('transfer failure rolls back receipt, count and vault', async () => {
    const broken = await campaign(7n, 1);
    const frozenDestination = await createAccount(rpc, organizer, broken.rewardMint, holder.publicKey);
    await freezeAccount(rpc, organizer, frozenDestination, broken.rewardMint, organizer);
    const before = await snapshot(broken, frozenDestination, good);
    await rejectedOnChain(claimInstruction(broken, holder, good, frozenDestination), holder, /frozen|Frozen|0x11/i);
    assert.deepEqual(await snapshot(broken, frozenDestination, good), before);
  });

  await t.test('expired campaign rejects claim; authority refunds and closes permanently', async () => {
    const deadline = Math.floor(Date.now() / 1000) + 12;
    const expiring = await campaign(9n, 1, deadline);
    const claimTo = await createAccount(rpc, organizer, expiring.rewardMint, holder.publicKey);
    const refundTo = await createAccount(rpc, organizer, expiring.rewardMint, organizer.publicKey, Keypair.generate());
    await waitForChainDeadline(deadline);
    const before = await snapshot(expiring, claimTo, good);
    await rejected(claimInstruction(expiring, holder, good, claimTo), holder, /Expired|0x1774/);
    assert.deepEqual(await snapshot(expiring, claimTo, good), before);
    await send(closeInstruction(expiring, organizer, refundTo), organizer);
    assert.equal((await snapshot(expiring, claimTo, good)).closed, true);
    assert.equal((await getAccount(rpc, expiring.vault)).amount, 0n);
    assert.equal((await getAccount(rpc, refundTo)).amount, 9n);
    await rejected(closeInstruction(expiring, organizer, refundTo), organizer, /CampaignClosed|0x1773/);
    await rejected(initInstruction(expiring, expiring.id), organizer, /already in use|0x0/);
    assert.equal((await snapshot(expiring, claimTo, good)).closed, true);
  });

  await t.test('initialization requires full funding and checked arithmetic', async () => {
    const mint = await createMint(rpc, organizer, organizer.publicKey, null, 0);
    const source = await createAccount(rpc, organizer, mint, organizer.publicKey);
    await mintTo(rpc, organizer, mint, source, organizer, 9n);
    const id = randomBytes(32);
    const address = campaignAddress(id);
    const unfunded: Campaign = { id, address, vault: vaultAddress(address), rewardMint: mint, source, amount: 10n, max: 1, deadline: Math.floor(Date.now() / 1000) + 3600 };
    await rejectedOnChain(initInstruction(unfunded, id), organizer, /insufficient funds|0x1/i);
    assert.equal(await rpc.getAccountInfo(address), null);
    assert.equal(await rpc.getAccountInfo(unfunded.vault), null);

    const overflowId = randomBytes(32);
    const overflowAddress = campaignAddress(overflowId);
    const overflow: Campaign = { ...unfunded, id: overflowId, address: overflowAddress, vault: vaultAddress(overflowAddress), amount: 0xffff_ffff_ffff_ffffn, max: 2 };
    await rejected(initInstruction(overflow, overflowId), organizer, /ArithmeticOverflow|0x1771/);
    assert.equal(await rpc.getAccountInfo(overflowAddress), null);
  });

  await t.test('Torque eligibility registration and read-only direct preview', async () => {
    const project = 'local-torque';
    const reference = randomBytes(8).toString('hex');
    const scope = scopeFor(project, reference);
    const namespace = namespaceAddress(organizer.publicKey, scope);
    const deadline = Math.floor(Date.now() / 1000) + 12;
    await send(registerNamespaceInstruction(scope, deadline), organizer);
    const valid = fixture('valid');
    assert.equal((await readEligibilityState(rpc, programId, namespace, valid.mint, holder.publicKey)).kind, 'ready');
    await send(consumeInstruction(namespace, holder, valid), holder);
    assert.equal((await readEligibilityState(rpc, programId, namespace, valid.mint, holder.publicKey)).kind, 'registered');
    assert.equal((await readEligibilityState(rpc, programId, namespace, valid.mint, secondHolder.publicKey)).kind, 'used');
    const eligibility = await rpc.getAccountInfo(eligibilityAddress(namespace, valid.mint));
    assert(eligibility);
    assert.equal(eligibility.data.length, 112);
    assert.equal(new PublicKey(eligibility.data.subarray(8, 40)).toBase58(), namespace.toBase58());
    assert.equal(new PublicKey(eligibility.data.subarray(40, 72)).toBase58(), valid.mint.toBase58());
    assert.equal(new PublicKey(eligibility.data.subarray(72, 104)).toBase58(), holder.publicKey.toBase58());
    await rejected(consumeInstruction(namespace, holder, valid), holder, /already in use|0x0/);
    await rejected(consumeInstruction(namespace, secondHolder, fixture('secondHolder')), secondHolder, /already in use|0x0/);
    await rejected(consumeInstruction(namespace, outsider, fixture('valid2')), outsider, /InvalidSgt|0x1772/);
    await rejected(consumeInstruction(namespace, holder, fixture('mintAuthority')), holder, /InvalidSgt|0x1772/);
    const unsigned = consumeInstruction(namespace, holder, fixture('valid2'));
    unsigned.keys[0].isSigner = false;
    await rejected(unsigned, organizer, /AccountNotSigner|0xbc2/);
    const otherScope = scopeFor(project, `${reference}-other`);
    const otherNamespace = namespaceAddress(organizer.publicKey, otherScope);
    await send(registerNamespaceInstruction(otherScope, Math.floor(Date.now() / 1000) + 3600), organizer);
    await send(consumeInstruction(otherNamespace, holder, valid), holder);
    const raceScope = scopeFor(project, `${reference}-race`);
    const raceNamespace = namespaceAddress(organizer.publicKey, raceScope);
    await send(registerNamespaceInstruction(raceScope, Math.floor(Date.now() / 1000) + 3600), organizer);
    const race = await Promise.allSettled([
      send(consumeInstruction(raceNamespace, holder, valid), holder),
      send(consumeInstruction(raceNamespace, secondHolder, fixture('secondHolder')), secondHolder),
    ]);
    assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
    assert(await rpc.getAccountInfo(eligibilityAddress(raceNamespace, valid.mint)));
    await waitForChainDeadline(deadline);
    await rejected(consumeInstruction(namespace, holder, fixture('valid2')), holder, /Expired|0x1774/);
    let preview;
    const startDate = new Date(Date.now() + 86_400_000).toISOString();
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        preview = await readTorquePreview(rpc, { namespace, authority: organizer.publicKey, scope, project, reference, name: 'test', amount: '0.1', startDate });
        break;
      } catch (error) {
        if (!(error instanceof Error) || !/still open|Minimum context slot|namespace unavailable/.test(error.message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    assert(preview, 'finalized preview unavailable after 60 seconds');
    assert.equal(preview.audit.namespace, namespace.toBase58());
    assert.deepEqual(preview.arguments.allocations, [{ address: holder.publicKey.toBase58(), amount: 0.1 }]);
    await writeFile('.local/torque-preview.json', `${JSON.stringify(preview, null, 2)}\n`);
  });
});
