import { Connection, PublicKey } from '@solana/web3.js';
import { namespaceAddress, readTorquePreview, scopeFor } from './torque.js';

async function main() {
  const [namespaceText, authorityText, project, reference, name, amount, startDate] = process.argv.slice(2);
  if (!namespaceText || !authorityText || !project || !reference || !name || !amount || !startDate || process.argv.length !== 9) {
    throw new Error('usage: npm run torque:preview -- NAMESPACE AUTHORITY PROJECT REFERENCE NAME SOL_AMOUNT START_DATE');
  }
  const namespace = new PublicKey(namespaceText);
  const authority = new PublicKey(authorityText);
  const scope = scopeFor(project, reference);
  if (!namespaceAddress(authority, scope).equals(namespace)) throw new Error('namespace does not match authority/project/reference');
  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:18999';
  const preview = await readTorquePreview(new Connection(rpcUrl), { namespace, authority, scope, name, amount, startDate, project, reference });
  process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
}

main().catch(() => {
  process.stderr.write('Torque preview failed. Check arguments, finalized RPC state and account data.\n');
  process.exitCode = 1;
});
