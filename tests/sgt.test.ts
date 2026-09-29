import assert from 'node:assert/strict';
import test from 'node:test';
import type { AccountInfo, PublicKey } from '@solana/web3.js';
import { Keypair, PublicKey as Key } from '@solana/web3.js';
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
import { checkWalletForSgt, heldMints, isSgtMint, type ReadonlySgtRpc } from '../src/sgt.js';

const AUTHORITY = new Key('GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4');
const GROUP = new Key('GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te');
const random = () => Keypair.generate().publicKey;
const ZERO = Key.default;

function info(data: Buffer, owner = TOKEN_2022_PROGRAM_ID): AccountInfo<Buffer> {
  return { data, owner, executable: false, lamports: 1, rentEpoch: 0 };
}

function extension(type: ExtensionType, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(type, 0);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
}

type MintOptions = {
  authority?: PublicKey;
  pointerAuthority?: PublicKey;
  metadataAddress?: PublicKey;
  group?: PublicKey;
  memberMint?: PublicKey;
  pointer?: boolean;
  member?: boolean;
  initialized?: boolean;
};

function mintInfo(address: PublicKey, options: MintOptions = {}): AccountInfo<Buffer> {
  const base = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({
    mintAuthorityOption: 1,
    mintAuthority: options.authority ?? AUTHORITY,
    supply: 1n,
    decimals: 0,
    isInitialized: options.initialized ?? true,
    freezeAuthorityOption: 0,
    freezeAuthority: ZERO,
  }, base);
  const extras: Buffer[] = [];
  if (options.pointer !== false) {
    const data = Buffer.alloc(MetadataPointerLayout.span);
    MetadataPointerLayout.encode({
      authority: options.pointerAuthority ?? AUTHORITY,
      metadataAddress: options.metadataAddress ?? GROUP,
    }, data);
    extras.push(extension(ExtensionType.MetadataPointer, data));
  }
  if (options.member !== false) {
    extras.push(extension(ExtensionType.TokenGroupMember, Buffer.from(packTokenGroupMember({
      mint: options.memberMint ?? address,
      group: options.group ?? GROUP,
      memberNumber: 1n,
    }))));
  }
  if (!extras.length) return info(base);
  const padding = Buffer.alloc(ACCOUNT_SIZE - MINT_SIZE + 1);
  padding[ACCOUNT_SIZE - MINT_SIZE] = 1; // SDK AccountType.Mint
  return info(Buffer.concat([base, padding, ...extras]));
}

function tokenInfo(wallet: PublicKey, mint: PublicKey, amount = 1n, state = AccountState.Initialized, program = TOKEN_2022_PROGRAM_ID): AccountInfo<Buffer> {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({
    mint, owner: wallet, amount, delegateOption: 0, delegate: ZERO,
    state, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n,
    closeAuthorityOption: 0, closeAuthority: ZERO,
  }, data);
  return info(data, program);
}

function rpc(wallet: PublicKey, tokens: { pubkey: PublicKey; account: AccountInfo<Buffer> }[], mints: Map<string, AccountInfo<Buffer>>, calls: number[] = []): ReadonlySgtRpc {
  return {
    getTokenAccountsByOwner: async (owner, filter) => {
      assert(owner.equals(wallet));
      assert('programId' in filter && filter.programId.equals(TOKEN_2022_PROGRAM_ID));
      return { context: { slot: 1 }, value: tokens };
    },
    getMultipleAccountsInfo: async (keys) => {
      calls.push(keys.length);
      return keys.map((key) => mints.get(key.toBase58()) ?? null);
    },
  } as ReadonlySgtRpc;
}

test('valid and frozen current holder pass with SDK serialized accounts', async () => {
  const wallet = random();
  const mint = random();
  for (const state of [AccountState.Initialized, AccountState.Frozen]) {
    const tokens = [{ pubkey: random(), account: tokenInfo(wallet, mint, 1n, state) }];
    assert.deepEqual(await checkWalletForSgt(rpc(wallet, tokens, new Map([[mint.toBase58(), mintInfo(mint)]])), wallet), {
      hasSGT: true, mintAddress: mint.toBase58(),
    });
  }
});

test('zero and non-NFT balances, old holder, wrong token program, uninitialized and malformed token accounts fail', async () => {
  const wallet = random();
  const mint = random();
  const bad = [
    tokenInfo(wallet, mint, 0n),
    tokenInfo(wallet, mint, 2n),
    tokenInfo(random(), mint),
    tokenInfo(wallet, mint, 1n, AccountState.Initialized, TOKEN_PROGRAM_ID),
    tokenInfo(wallet, mint, 1n, AccountState.Uninitialized),
    info(Buffer.alloc(2)),
  ];
  for (const account of bad) {
    assert.deepEqual(heldMints(wallet, [{ pubkey: random(), account }]), []);
    assert.deepEqual(await checkWalletForSgt(rpc(wallet, [{ pubkey: random(), account }], new Map([[mint.toBase58(), mintInfo(mint)]])), wallet), { hasSGT: false, mintAddress: null });
  }
});

test('each mint authenticity property, absent extensions, wrong owner, and malformed mint fail', () => {
  const mint = random();
  const fake = random();
  assert(isSgtMint(mint, mintInfo(mint)));
  const cases = [
    mintInfo(mint, { authority: fake }),
    mintInfo(mint, { pointerAuthority: fake }),
    mintInfo(mint, { metadataAddress: fake }),
    mintInfo(mint, { group: fake }),
    mintInfo(mint, { memberMint: fake }),
    mintInfo(mint, { pointer: false }),
    mintInfo(mint, { member: false }),
    mintInfo(mint, { initialized: false }),
    info(mintInfo(mint).data, TOKEN_PROGRAM_ID),
    info(Buffer.alloc(3)),
  ];
  for (const candidate of cases) assert.equal(isSgtMint(mint, candidate), false);
  assert.equal(isSgtMint(mint, null), false);
});

test('mint lookup is unique and batched at at most 100', async () => {
  const wallet = random();
  const keys = Array.from({ length: 201 }, random);
  const tokens = keys.map((mint) => ({ pubkey: random(), account: tokenInfo(wallet, mint) }));
  tokens.push({ pubkey: random(), account: tokenInfo(wallet, keys[0]) });
  const calls: number[] = [];
  const mints = new Map([[keys[200].toBase58(), mintInfo(keys[200])]]);
  const result = await checkWalletForSgt(rpc(wallet, tokens, mints, calls), wallet);
  assert.deepEqual(result, { hasSGT: true, mintAddress: keys[200].toBase58() });
  assert.deepEqual(calls, [100, 100, 1]);
});

test('RPC errors and incomplete mint responses remain errors', async () => {
  const wallet = random();
  const mint = random();
  await assert.rejects(() => checkWalletForSgt({
    getTokenAccountsByOwner: async () => { throw new Error('RPC offline'); },
    getMultipleAccountsInfo: async () => [],
  } as unknown as ReadonlySgtRpc, wallet), /RPC offline/);
  const incomplete = rpc(wallet, [{ pubkey: random(), account: tokenInfo(wallet, mint) }], new Map());
  incomplete.getMultipleAccountsInfo = async () => [];
  await assert.rejects(() => checkWalletForSgt(incomplete, wallet), /Incomplete RPC mint response/);
  const unavailable = rpc(wallet, [{ pubkey: random(), account: tokenInfo(wallet, mint) }], new Map());
  unavailable.getMultipleAccountsInfo = async () => { throw new Error('mint RPC offline'); };
  await assert.rejects(() => checkWalletForSgt(unavailable, wallet), /mint RPC offline/);
});
