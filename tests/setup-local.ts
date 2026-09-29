import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountState,
  ExtensionType,
  MetadataPointerLayout,
  MINT_SIZE,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { packTokenGroupMember } from '@solana/spl-token-group';

const authority = new PublicKey('GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4');
const group = new PublicKey('GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te');
const zero = PublicKey.default;
const root = join(process.cwd(), '.local');
const dir = join(root, 'validator-accounts');

function extension(type: ExtensionType, body: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(type, 0);
  header.writeUInt16LE(body.length, 2);
  return Buffer.concat([header, body]);
}

type Variation = 'valid' | 'valid2' | 'mintAuthority' | 'pointerAuthority' | 'metadataAddress' | 'group' | 'memberMint' | 'noPointer' | 'noMember' | 'wrongMintProgram';
function mintData(mint: PublicKey, variation: Variation): Buffer {
  const base = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({
    mintAuthorityOption: 1,
    mintAuthority: variation === 'mintAuthority' ? Keypair.generate().publicKey : authority,
    supply: 1n,
    decimals: 0,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: zero,
  }, base);
  const parts: Buffer[] = [];
  if (variation !== 'noPointer') {
    const pointer = Buffer.alloc(MetadataPointerLayout.span);
    MetadataPointerLayout.encode({
      authority: variation === 'pointerAuthority' ? Keypair.generate().publicKey : authority,
      metadataAddress: variation === 'metadataAddress' ? Keypair.generate().publicKey : group,
    }, pointer);
    parts.push(extension(ExtensionType.MetadataPointer, pointer));
  }
  if (variation !== 'noMember') {
    parts.push(extension(ExtensionType.TokenGroupMember, Buffer.from(packTokenGroupMember({
      mint: variation === 'memberMint' ? Keypair.generate().publicKey : mint,
      group: variation === 'group' ? Keypair.generate().publicKey : group,
      memberNumber: 1n,
    }))));
  }
  const padding = Buffer.alloc(ACCOUNT_SIZE - MINT_SIZE + 1);
  padding[ACCOUNT_SIZE - MINT_SIZE] = 1; // Token-2022 AccountType.Mint.
  return Buffer.concat([base, padding, ...parts]);
}

function tokenData(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({
    mint, owner, amount, delegateOption: 0, delegate: zero,
    state: AccountState.Frozen, isNativeOption: 0, isNative: 0n,
    delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: zero,
  }, data);
  return data;
}

async function saveAccount(key: PublicKey, owner: PublicKey, data: Buffer): Promise<void> {
  // Same JSON account shape produced by `solana account --output json`.
  const document = {
    pubkey: key.toBase58(),
    account: { lamports: 10_000_000, data: [data.toString('base64'), 'base64'], owner: owner.toBase58(), executable: false, rentEpoch: 0 },
  };
  await writeFile(join(dir, `${key.toBase58()}.json`), JSON.stringify(document));
}

await mkdir(dir, { recursive: true });
// Replace only this generator's public account dumps; unrelated files are untouched.
for (const file of await readdir(dir)) {
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}\.json$/.test(file)) await unlink(join(dir, file));
}
const organizer = Keypair.generate();
const holder = Keypair.generate();
const secondHolder = Keypair.generate();
const outsider = Keypair.generate();
const fixtures: Record<string, { mint: string; token: string }> = {};

for (const variation of ['valid', 'valid2', 'mintAuthority', 'pointerAuthority', 'metadataAddress', 'group', 'memberMint', 'noPointer', 'noMember', 'wrongMintProgram'] as Variation[]) {
  const mint = Keypair.generate().publicKey;
  const token = Keypair.generate().publicKey;
  fixtures[variation] = { mint: mint.toBase58(), token: token.toBase58() };
  await saveAccount(mint, variation === 'wrongMintProgram' ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID, mintData(mint, variation));
  await saveAccount(token, TOKEN_2022_PROGRAM_ID, tokenData(mint, holder.publicKey, 1n));
}

const validMint = new PublicKey(fixtures.valid.mint);
for (const [name, owner, amount, program] of [
  ['secondHolder', secondHolder.publicKey, 1n, TOKEN_2022_PROGRAM_ID],
  ['oldHolder', holder.publicKey, 0n, TOKEN_2022_PROGRAM_ID],
  ['wrongOwner', outsider.publicKey, 1n, TOKEN_2022_PROGRAM_ID],
  ['wrongProgram', holder.publicKey, 1n, TOKEN_PROGRAM_ID],
] as const) {
  const token = Keypair.generate().publicKey;
  fixtures[name] = { mint: validMint.toBase58(), token: token.toBase58() };
  await saveAccount(token, program, tokenData(validMint, owner, amount));
}

const secret = (pair: Keypair) => [...pair.secretKey];
await writeFile(join(root, 'fixture-keys.json'), JSON.stringify({
  organizer: secret(organizer), holder: secret(holder), secondHolder: secret(secondHolder), outsider: secret(outsider),
}));
await writeFile(join(root, 'fixture-manifest.json'), JSON.stringify({ synthetic: true, fixtures }, null, 2));
console.log(`Wrote ${Object.keys(fixtures).length} synthetic local fixture pairs to .local/validator-accounts`);
