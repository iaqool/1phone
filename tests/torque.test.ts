import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Connection, Keypair, PublicKey, type AccountInfo } from '@solana/web3.js';
import { buildTorquePreview, eligibilityAddress, namespaceAddress, PROGRAM_ID, readTorquePreview, scopeFor, type ChainAccount } from '../src/torque.js';

const authority = Keypair.generate().publicKey;
const scope = scopeFor('project', 'campaign');
const namespace = namespaceAddress(authority, scope);
const deadline = 1000n;
const discriminator = (name: string) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
function account(pubkey: PublicKey, data: Buffer, owner = PROGRAM_ID): ChainAccount {
  return { pubkey, account: { data, owner, executable: false, lamports: 1, rentEpoch: 0 } as AccountInfo<Buffer> };
}
function ns(): ChainAccount {
  const data = Buffer.alloc(81);
  discriminator('Namespace').copy(data);
  authority.toBuffer().copy(data, 8);
  scope.copy(data, 40);
  data.writeBigInt64LE(deadline, 72);
  data[80] = PublicKey.findProgramAddressSync([Buffer.from('namespace'), authority.toBuffer(), scope], PROGRAM_ID)[1];
  return account(namespace, data);
}
function receipt(mint: PublicKey, holder: PublicKey): ChainAccount {
  const data = Buffer.alloc(112);
  discriminator('EligibilityReceipt').copy(data);
  namespace.toBuffer().copy(data, 8);
  mint.toBuffer().copy(data, 40);
  holder.toBuffer().copy(data, 72);
  data.writeBigInt64LE(999n, 104);
  return account(eligibilityAddress(namespace, mint), data);
}
const mint = Keypair.generate().publicKey;
const holder = Keypair.generate().publicKey;
const base = () => ({ namespace, authority, scope, clockTimestamp: 1000n, slot: 42, accounts: [ns(), receipt(mint, holder)], name: 'OnePhone', amount: '0.1', startDate: '2026-10-01T00:00:00Z' });

test('scope encoding separates ambiguous inputs', () => {
  assert.notDeepEqual(scopeFor('ab', 'c'), scopeFor('a', 'bc'));
  assert.notDeepEqual(scopeFor('p', 'r'), scopeFor('r', 'p'));
});

test('preview uses eligibility receipts and one allocation per wallet', () => {
  const secondMint = Keypair.generate().publicKey;
  const result = buildTorquePreview({ ...base(), accounts: [ns(), receipt(mint, holder), receipt(secondMint, holder)] });
  assert.equal(result.audit.receiptCount, 2);
  assert.equal(result.arguments.allocations.length, 1);
  assert.deepEqual(result.arguments.allocations[0], { address: holder.toBase58(), amount: 0.1 });
  assert.equal(result.arguments.confirmed, false);
});

test('rejects open namespace, wrong owner/type/PDA, malformed and duplicate receipts', () => {
  assert.throws(() => buildTorquePreview({ ...base(), clockTimestamp: 999n }), /still open/);
  assert.throws(() => buildTorquePreview({ ...base(), accounts: [account(namespace, ns().account.data, holder), receipt(mint, holder)] }), /invalid namespace/);
  const wrongType = ns(); wrongType.account.data = Buffer.from(wrongType.account.data); discriminator('Receipt').copy(wrongType.account.data);
  assert.throws(() => buildTorquePreview({ ...base(), accounts: [wrongType, receipt(mint, holder)] }), /invalid namespace/);
  const wrongPda = receipt(mint, holder); wrongPda.pubkey = Keypair.generate().publicKey;
  assert.throws(() => buildTorquePreview({ ...base(), accounts: [ns(), wrongPda] }), /PDA mismatch/);
  const malformed = receipt(mint, holder); malformed.account.data = malformed.account.data.subarray(0, 111);
  assert.throws(() => buildTorquePreview({ ...base(), accounts: [ns(), malformed] }), /malformed/);
  assert.throws(() => buildTorquePreview({ ...base(), accounts: [ns(), receipt(mint, holder), receipt(mint, holder)] }), /duplicate/);
  const payout = account(Keypair.generate().publicKey, Buffer.concat([discriminator('Receipt'), Buffer.alloc(104)]));
  assert.throws(() => buildTorquePreview({ ...base(), accounts: [ns(), payout] }), /unexpected account type/);
});

test('rejects changed namespace, bad amounts and empty output', () => {
  const other = Keypair.generate().publicKey;
  assert.throws(() => buildTorquePreview({ ...base(), namespace: other }), /PDA mismatch/);
  const wrong = receipt(mint, holder); wrong.account.data = Buffer.from(wrong.account.data); other.toBuffer().copy(wrong.account.data, 8);
  assert.throws(() => buildTorquePreview({ ...base(), accounts: [ns(), wrong] }), /namespace mismatch/);
  assert.throws(() => buildTorquePreview({ ...base(), accounts: [ns()] }), /no eligible wallets/);
  for (const amount of ['NaN', '0', '-1', '0.0000000001', '9007199.254740992']) {
    assert.throws(() => buildTorquePreview({ ...base(), amount }), /amount/);
  }
  for (const startDate of ['2026-10-01T00:00:00', '1970-01-01T00:00:00Z', 'nonsense']) {
    assert.throws(() => buildTorquePreview({ ...base(), startDate }), /startDate/);
  }
  assert.equal(buildTorquePreview({ ...base(), startDate: '2026-10-01T02:00:00+02:00' }).arguments.startDate, '2026-10-01T00:00:00.000Z');
});

test('RPC exporter requires finalized clock and scoped account snapshot', async () => {
  const clock = Buffer.alloc(40); clock.writeBigInt64LE(1000n, 32);
  const calls: unknown[] = [];
  const fake = {
    async getMultipleAccountsInfoAndContext(keys: PublicKey[], commitment: string) {
      calls.push({ keys: keys.map((key) => key.toBase58()), commitment });
      return { context: { slot: 50 }, value: [account(Keypair.generate().publicKey, clock).account, ns().account] };
    },
    async getProgramAccounts(program: PublicKey, config: { commitment: string; minContextSlot: number; withContext: boolean; filters: unknown[] }) {
      calls.push({ program: program.toBase58(), config });
      return { context: { slot: 49 }, value: [receipt(mint, holder)] };
    },
  } as unknown as Connection;
  await assert.rejects(() => readTorquePreview(fake, base()), /stale account snapshot/);
  assert.equal((calls[0] as { commitment: string }).commitment, 'finalized');
  const query = calls[1] as { config: { commitment: string; minContextSlot: number; withContext: boolean; filters: unknown[] } };
  assert.equal(query.config.commitment, 'finalized');
  assert.equal(query.config.minContextSlot, 50);
  assert.equal(query.config.withContext, true);
  assert.deepEqual(query.config.filters, [{ dataSize: 112 }, { memcmp: { offset: 8, bytes: namespace.toBase58() } }]);
});
