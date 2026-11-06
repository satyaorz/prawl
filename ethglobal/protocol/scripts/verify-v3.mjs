import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';

const rpc = readFileSync('../.env.local','utf8').match(/SEPOLIA_RPC_URL=(.*)/)[1].trim();
const p = new ethers.JsonRpcProvider(rpc, 11155111, { staticNetwork: true });
const cfg = JSON.parse(readFileSync('../batch-config.json','utf8'));
const key = '0xc2a59729499cfe1d9cdc72a9b9bce3e24b016ddac264669a3926f7b2045a149f';
const w = new ethers.Wallet(key, p);
console.log('user:', w.address);

const fhevm = await createInstance({ ...SepoliaConfig, network: rpc });
const cA = new ethers.Contract(cfg.cTokenA, ['function rate() view returns (uint256)','function wrap(address,uint256)','function confidentialTransferAndCall(address,bytes32,bytes,bytes)','function balanceOf(address) view returns (bytes32)'], w);
const batch = new ethers.Contract(cfg.batch, [
  'function VERSION() view returns (uint256)',
  'function fundedBalance(address,uint8) view returns (bytes32)',
  'function submitOrder(bytes32,bytes,bytes32,bytes)',
  'function currentRound() view returns (uint256)',
], w);
console.log('VERSION:', (await batch.VERSION()).toString());

// 1. fund 3 c-vUSD into the vault (public leg)
const rate = await cA.rate();
const uAmount = 3n * 10n ** 6n * rate;
const vusd = new ethers.Contract(cfg.tokenA, ['function mint(address,uint256)','function approve(address,uint256) returns (bool)'], w);
await (await vusd.mint(w.address, uAmount)).wait();
await (await vusd.approve(cfg.cTokenA, uAmount)).wait();
await (await cA.wrap(w.address, uAmount)).wait();
const encF = await fhevm.createEncryptedInput(cfg.cTokenA, w.address).add64(3n * 10n ** 6n).encrypt();
await (await cA.confidentialTransferAndCall(cfg.batch, encF.handles[0], encF.inputProof, '0x00')).wait();
console.log('funded 3 c-vUSD ✓');

// 2. submit an ENCRYPTED order: 2 c-units, direction vUSD→vETH (encrypted)
const encO = await fhevm.createEncryptedInput(cfg.batch, w.address).add64(2n * 10n ** 6n).add8(1).encrypt();
await (await batch.submitOrder(encO.handles[0], encO.inputProof, encO.handles[1], encO.inputProof)).wait();
console.log('encrypted order submitted ✓ (round', (await batch.currentRound()).toString() + ')');

// 3. read back our own funded balance (user decrypt)
const kp = fhevm.generateKeypair();
const ctAddrs = [cfg.batch, cfg.cTokenA, cfg.cTokenB];
const ts = Math.floor(Date.now()/1000);
const eip712 = fhevm.createEIP712(kp.publicKey, ctAddrs, ts, 365);
const sig = await w.signTypedData(eip712.domain, { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification }, eip712.message);
const hA = await batch.fundedBalance(w.address, 0);
const val = (await fhevm.userDecrypt([{ handle: ethers.hexlify(hA), contractAddress: cfg.batch }], kp.privateKey, kp.publicKey, sig, ctAddrs, w.address, ts, 365))[ethers.hexlify(hA)];
console.log('vault c-vUSD after order:', val.toString(), '(expect 1000000)');
