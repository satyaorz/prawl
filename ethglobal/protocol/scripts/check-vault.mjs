import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';
const rpc = readFileSync('../.env.local','utf8').match(/SEPOLIA_RPC_URL=(.*)/)[1].trim();
const p = new ethers.JsonRpcProvider(rpc, 11155111, { staticNetwork: true });
const cfg = JSON.parse(readFileSync('../batch-config.json','utf8'));
const w = new ethers.Wallet('0xc2a59729499cfe1d9cdc72a9b9bce3e24b016ddac264669a3926f7b2045a149f', p);
const fhevm = await createInstance({ ...SepoliaConfig, network: rpc });
const batch = new ethers.Contract(cfg.batch, ['function fundedBalance(address,uint8) view returns (bytes32)'], w);
const kp = fhevm.generateKeypair();
const ctAddrs = [cfg.batch, cfg.cTokenA, cfg.cTokenB];
const ts = Math.floor(Date.now()/1000);
const eip712 = fhevm.createEIP712(kp.publicKey, ctAddrs, ts, 365);
const sig = await w.signTypedData(eip712.domain, { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification }, eip712.message);
for (const asset of [0, 1]) {
  const h = await batch.fundedBalance(w.address, asset);
  const v = (await fhevm.userDecrypt([{ handle: ethers.hexlify(h), contractAddress: cfg.batch }], kp.privateKey, kp.publicKey, sig, ctAddrs, w.address, ts, 365))[ethers.hexlify(h)];
  console.log(`vault asset ${asset}:`, Number(v) / 1e6, 'c-units');
}
