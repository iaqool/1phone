import type { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import { PublicKey as Key } from '@solana/web3.js';
import {
  getMetadataPointerState,
  getTokenGroupMemberState,
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token';

// Solana Mobile's published mainnet SGT identifiers.
const MINT_AUTHORITY = new Key('GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4');
const GROUP = new Key('GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te');
const BATCH_SIZE = 100;

export type ReadonlySgtRpc = Pick<Connection, 'getTokenAccountsByOwner' | 'getMultipleAccountsInfo'>;
export type SgtResult = { hasSGT: boolean; mintAddress: string | null };

export function isSgtMint(address: PublicKey, info: AccountInfo<Buffer> | null): boolean {
  if (!info) return false;
  try {
    const mint = unpackMint(address, info, TOKEN_2022_PROGRAM_ID);
    if (!mint.isInitialized || !mint.mintAuthority?.equals(MINT_AUTHORITY)) return false;
    const pointer = getMetadataPointerState(mint);
    const member = getTokenGroupMemberState(mint);
    return Boolean(
      pointer?.authority?.equals(MINT_AUTHORITY) &&
      pointer.metadataAddress?.equals(GROUP) &&
      member?.group?.equals(GROUP) &&
      member.mint?.equals(address),
    );
  } catch {
    // An invalid or unrelated account is not an SGT mint.
    return false;
  }
}

export function heldMints(wallet: PublicKey, accounts: readonly { pubkey: PublicKey; account: AccountInfo<Buffer> }[]): PublicKey[] {
  const mints = new Map<string, PublicKey>();
  for (const entry of accounts) {
    try {
      const account = unpackAccount(entry.pubkey, entry.account, TOKEN_2022_PROGRAM_ID);
      if (!account.isInitialized || !account.owner.equals(wallet) || account.amount !== 1n) continue;
      // Frozen is normal for a Seeker SGT.
      mints.set(account.mint.toBase58(), account.mint);
    } catch {
      // Malformed or wrong-program token accounts do not qualify.
    }
  }
  return [...mints.values()];
}

export async function checkWalletForSgt(rpc: ReadonlySgtRpc, wallet: PublicKey): Promise<SgtResult> {
  const { value } = await rpc.getTokenAccountsByOwner(wallet, { programId: TOKEN_2022_PROGRAM_ID }, 'confirmed');
  const mints = heldMints(wallet, value);
  for (let start = 0; start < mints.length; start += BATCH_SIZE) {
    const batch = mints.slice(start, start + BATCH_SIZE);
    const infos = await rpc.getMultipleAccountsInfo(batch, 'confirmed');
    if (infos.length !== batch.length) throw new Error('Incomplete RPC mint response');
    for (let index = 0; index < batch.length; index++) {
      if (isSgtMint(batch[index], infos[index])) {
        return { hasSGT: true, mintAddress: batch[index].toBase58() };
      }
    }
  }
  return { hasSGT: false, mintAddress: null };
}
