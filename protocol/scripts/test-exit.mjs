import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';
const rpc = readFileSync('../.env.local','utf8').match(/SEPOLIA_RPC_URL=(.*)/)[1].trim();
const p = new ethers.JsonRpcProvider(rpc, 11155111, { staticNetwork: true });
const cfg = JSON.parse(readFileSync('../batch-config.json','utf8'));
const w = new ethers.Wallet('0xc2a59729499cfe1d9cdc72a9b9bce3e24b016ddac264669a3926f7b2045a149f', p);
const fhevm = await createInstance({ ...SepoliaConfig, network: rpc });
const batch = new ethers.Contract(cfg.batch, ['function exit(uint8,bytes32,bytes)'], w);
const veth = new ethers.Contract(cfg.tokenB, ['function balanceOf(address) view returns (uint256)'], p);
const before = await veth.balanceOf(w.address);
const enc = await fhevm.createEncryptedInput(cfg.batch, w.address).add64(5n * 10n ** 6n).encrypt();
await (await batch.exit(1, enc.handles[0], enc.inputProof)).wait();
console.log('exit(1, 5 c-vETH) submitted ✓ — waiting for keeper finalize…');
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 15000));
  const now = await veth.balanceOf(w.address);
  if (now > before) { console.log('plain vETH received:', ethers.formatUnits(now - before, 18), '✓'); process.exit(0); }
}
console.log('no payout after 5 min');
