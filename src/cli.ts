import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { checkWalletForSgt } from './sgt.js';

async function main(): Promise<void> {
  const address = process.argv[2];
  if (!address || process.argv.length !== 3) {
    console.error('Usage: npm run sgt -- <public-wallet-address>');
    process.exitCode = 2;
    return;
  }

  let wallet: PublicKey;
  try {
    wallet = new PublicKey(address);
  } catch {
    console.error('Invalid public wallet address');
    process.exitCode = 2;
    return;
  }

  try {
    const rpc = new Connection(process.env.SOLANA_RPC_URL || clusterApiUrl('mainnet-beta'), 'confirmed');
    console.log(JSON.stringify(await checkWalletForSgt(rpc, wallet)));
  } catch {
    // RPC URLs can contain credentials. Keep both URL and upstream errors out of output.
    console.error('SGT verification unavailable: RPC request failed.');
    process.exitCode = 1;
  }
}

void main();
