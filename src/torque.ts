import { createHash } from 'node:crypto';
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY, type AccountInfo } from '@solana/web3.js';

export const PROGRAM_ID = new PublicKey('B3mxNzFAtqWt14m6rr6ExRYeWw29V4vU8bvv9q17xR7N');
const disc = (name: string) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
const namespaceDisc = disc('Namespace');
const eligibilityDisc = disc('EligibilityReceipt');
const namespaceSize = 81;
const eligibilitySize = 112;
export type ChainAccount = { pubkey: PublicKey; account: AccountInfo<Buffer> };

export function scopeFor(project: string, reference: string): Buffer {
  if (!project || !reference) throw new Error('project and reference are required');
  const parts = [project, reference].map((s) => Buffer.from(s, 'utf8'));
  if (parts.some((p) => p.length > 65535)) throw new Error('scope field too long');
  const hash = createHash('sha256').update('onephone:torque:namespace:v1\0');
  for (const part of parts) {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(part.length);
    hash.update(length).update(part);
  }
  return hash.digest();
}

export function namespaceAddress(authority: PublicKey, scope: Buffer): PublicKey {
  if (scope.length !== 32 || scope.equals(Buffer.alloc(32))) throw new Error('invalid scope');
  return PublicKey.findProgramAddressSync([Buffer.from('namespace'), authority.toBuffer(), scope], PROGRAM_ID)[0];
}

export function eligibilityAddress(namespace: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('eligibility'), namespace.toBuffer(), mint.toBuffer()], PROGRAM_ID)[0];
}

function amountNumber(decimal: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(decimal)) throw new Error('amount must be a positive SOL decimal with at most 9 places');
  const [whole, fraction = ''] = decimal.split('.');
  const lamports = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
  if (lamports < 1n || lamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('amount is outside safe lamport range');
  const result = Number(lamports) / 1_000_000_000;
  if (BigInt(Math.round(result * 1_000_000_000)) !== lamports) throw new Error('amount loses lamport precision');
  return result;
}

export function buildTorquePreview(input: {
  namespace: PublicKey; authority: PublicKey; scope: Buffer; clockTimestamp: bigint; slot: number;
  accounts: readonly ChainAccount[]; name: string; amount: string; startDate: string; project?: string; reference?: string;
}) {
  if (!input.name.trim()) throw new Error('name is required');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.startDate)) throw new Error('startDate must include timezone');
  const startDate = new Date(input.startDate);
  if (!Number.isFinite(startDate.getTime()) || startDate.getTime() <= Number(input.clockTimestamp) * 1000) throw new Error('startDate must be after finalized chain time');
  const expected = namespaceAddress(input.authority, input.scope);
  if (!expected.equals(input.namespace)) throw new Error('namespace PDA mismatch');
  const nsRecords = input.accounts.filter((item) => item.pubkey.equals(input.namespace));
  if (nsRecords.length !== 1) throw new Error('namespace account missing or duplicated');
  const ns = nsRecords[0].account;
  if (!ns.owner.equals(PROGRAM_ID) || ns.data.length !== namespaceSize || !ns.data.subarray(0, 8).equals(namespaceDisc)) throw new Error('invalid namespace account');
  if (!new PublicKey(ns.data.subarray(8, 40)).equals(input.authority) || !ns.data.subarray(40, 72).equals(input.scope)) throw new Error('namespace fields mismatch');
  const [derived, bump] = PublicKey.findProgramAddressSync([Buffer.from('namespace'), input.authority.toBuffer(), input.scope], PROGRAM_ID);
  if (!derived.equals(input.namespace) || ns.data[80] !== bump) throw new Error('namespace bump mismatch');
  const deadline = ns.data.readBigInt64LE(72);
  if (input.clockTimestamp < deadline) throw new Error('namespace registration is still open');
  const wallets = new Set<string>();
  const mints = new Set<string>();
  let receiptCount = 0;
  for (const item of input.accounts) {
    if (item.pubkey.equals(input.namespace)) continue;
    if (!item.account.owner.equals(PROGRAM_ID)) throw new Error('account owner mismatch');
    const data = item.account.data;
    if (data.length !== eligibilitySize) throw new Error('malformed eligibility receipt');
    if (!data.subarray(0, 8).equals(eligibilityDisc)) throw new Error('unexpected account type');
    const namespace = new PublicKey(data.subarray(8, 40));
    if (!namespace.equals(input.namespace)) throw new Error('eligibility namespace mismatch');
    const mint = new PublicKey(data.subarray(40, 72));
    const holder = new PublicKey(data.subarray(72, 104));
    if (!item.pubkey.equals(eligibilityAddress(namespace, mint))) throw new Error('eligibility receipt PDA mismatch');
    const timestamp = data.readBigInt64LE(104);
    if (timestamp <= 0n || timestamp >= deadline) throw new Error('eligibility timestamp outside namespace window');
    const mintAddress = mint.toBase58();
    if (mints.has(mintAddress)) throw new Error('duplicate SGT mint');
    mints.add(mintAddress);
    wallets.add(holder.toBase58());
    receiptCount++;
  }
  if (!wallets.size) throw new Error('no eligible wallets');
  const amount = amountNumber(input.amount);
  return {
    audit: { namespace: input.namespace.toBase58(), authority: input.authority.toBase58(), scope: input.scope.toString('hex'), project: input.project, reference: input.reference, programId: PROGRAM_ID.toBase58(), finalizedContext: { slot: input.slot, clockTimestamp: input.clockTimestamp.toString() }, receiptCount, walletCount: wallets.size },
    torqueTool: 'create_recurring_incentive' as const,
    arguments: { name: input.name, type: 'direct' as const, emissionType: 'SOL' as const, allocations: [...wallets].sort().map((address) => ({ address, amount })), startDate: startDate.toISOString(), evalDurationDays: 1, maxIterations: 1, confirmed: false as const },
  };
}

export async function readTorquePreview(connection: Connection, args: { namespace: PublicKey; authority: PublicKey; scope: Buffer; name: string; amount: string; startDate: string; project?: string; reference?: string }) {
  const snapshot = await connection.getMultipleAccountsInfoAndContext([SYSVAR_CLOCK_PUBKEY, args.namespace], 'finalized');
  const [clock, namespaceAccount] = snapshot.value;
  if (!clock || clock.data.length < 40) throw new Error('finalized Clock unavailable');
  if (!namespaceAccount) throw new Error('namespace unavailable');
  const timestamp = clock.data.readBigInt64LE(32);
  const response = await connection.getProgramAccounts(PROGRAM_ID, {
    commitment: 'finalized', minContextSlot: snapshot.context.slot, withContext: true,
    filters: [{ dataSize: eligibilitySize }, { memcmp: { offset: 8, bytes: args.namespace.toBase58() } }],
  });
  if (response.context.slot < snapshot.context.slot) throw new Error('stale account snapshot');
  return buildTorquePreview({ ...args, clockTimestamp: timestamp, slot: response.context.slot, accounts: [{ pubkey: args.namespace, account: namespaceAccount }, ...response.value] });
}
