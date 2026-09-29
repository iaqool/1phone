import {
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  TransactionInstruction,
  type Connection,
} from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, unpackAccount } from '@solana/spl-token';

// Anchor discriminators for the audited OnePhone program in programs/onephone/src/lib.rs.
const namespaceDisc = '29374d133c5edf6b';
const eligibilityDisc = '992881fd93786f13';
const consumeDisc = Buffer.from('41b28d0d5f394c9a', 'hex');

export type EligibilityState =
  | { kind: 'ready'; deadline: bigint; receipt: PublicKey }
  | { kind: 'registered'; deadline: bigint; receipt: PublicKey }
  | { kind: 'used'; deadline: bigint; receipt: PublicKey }
  | { kind: 'closed'; deadline: bigint; receipt: PublicKey };

export function eligibilityAddress(programId: PublicKey, namespace: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('eligibility'), namespace.toBuffer(), mint.toBuffer()], programId)[0];
}

export async function readEligibilityState(
  connection: Connection,
  programId: PublicKey,
  namespace: PublicKey,
  mint: PublicKey,
  holder: PublicKey,
): Promise<EligibilityState> {
  const [namespaceInfo, clock] = await connection.getMultipleAccountsInfo([namespace, SYSVAR_CLOCK_PUBKEY], 'confirmed');
  if (!namespaceInfo) throw new Error('Кампания не найдена в сети');
  if (!namespaceInfo.owner.equals(programId) || namespaceInfo.data.length !== 81 ||
      namespaceInfo.data.subarray(0, 8).toString('hex') !== namespaceDisc) throw new Error('Некорректная кампания');
  const authority = new PublicKey(namespaceInfo.data.subarray(8, 40));
  const scope = namespaceInfo.data.subarray(40, 72);
  const [expected, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('namespace'), authority.toBuffer(), scope], programId,
  );
  if (!expected.equals(namespace) || namespaceInfo.data[80] !== bump) throw new Error('Некорректный адрес кампании');
  if (!clock || clock.data.length < 40) throw new Error('Время сети недоступно');
  const deadline = namespaceInfo.data.readBigInt64LE(72);
  const chainTime = clock.data.readBigInt64LE(32);
  const receipt = eligibilityAddress(programId, namespace, mint);
  const receiptInfo = await connection.getAccountInfo(receipt, 'confirmed');
  if (receiptInfo) {
    if (!receiptInfo.owner.equals(programId) || receiptInfo.data.length !== 112 ||
        receiptInfo.data.subarray(0, 8).toString('hex') !== eligibilityDisc ||
        !new PublicKey(receiptInfo.data.subarray(8, 40)).equals(namespace) ||
        !new PublicKey(receiptInfo.data.subarray(40, 72)).equals(mint)) {
      throw new Error('Некорректная запись участия');
    }
    const registeredHolder = new PublicKey(receiptInfo.data.subarray(72, 104));
    return { kind: registeredHolder.equals(holder) ? 'registered' : 'used', deadline, receipt };
  }
  return { kind: chainTime < deadline ? 'ready' : 'closed', deadline, receipt };
}

export async function findHeldSgtToken(connection: Connection, holder: PublicKey, mint: PublicKey): Promise<PublicKey> {
  const { value } = await connection.getTokenAccountsByOwner(holder, { programId: TOKEN_2022_PROGRAM_ID }, 'confirmed');
  for (const entry of value) {
    try {
      const token = unpackAccount(entry.pubkey, entry.account, TOKEN_2022_PROGRAM_ID);
      if (token.isInitialized && token.owner.equals(holder) && token.mint.equals(mint) && token.amount === 1n) {
        return entry.pubkey;
      }
    } catch {
      // Ignore unrelated or malformed token accounts; the program repeats every check.
    }
  }
  throw new Error('SGT больше не находится в подключённом кошельке');
}

export function buildConsumeInstruction(
  programId: PublicKey,
  namespace: PublicKey,
  holder: PublicKey,
  mint: PublicKey,
  token: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    data: consumeDisc,
    keys: [
      { pubkey: holder, isSigner: true, isWritable: true },
      { pubkey: namespace, isSigner: false, isWritable: false },
      { pubkey: eligibilityAddress(programId, namespace, mint), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: token, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}
