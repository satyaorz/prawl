import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';
const root = '/home/sahilkaushik/study_material/blockchain/ethglobal';
for (const f of ['.env.local', 'protocol/.env']) {
  try { for (const line of readFileSync(`${root}/${f}`,'utf8').split('\n')) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2]; } } catch {}
}
const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL, 11155111, { staticNetwork: true });
const alice = new ethers.Wallet(process.env.DEMO_KEY_ALICE, provider);
const bob = new ethers.Wallet(process.env.DEMO_KEY_BOB, provider);
const cfg = JSON.parse(readFileSync(`${root}/batch-config.json`,'utf8'));
const art = JSON.parse(readFileSync(`${root}/protocol/artifacts/contracts/VeilBatchSwap.sol/VeilBatchSwap.json`,'utf8'));
const batch = new ethers.Contract(cfg.batch, art.abi, provider);
const W = new ethers.Contract(cfg.cTokenA, ['function confidentialBalanceOf(address) view returns (bytes32)'], provider);
const W2 = new ethers.Contract(cfg.cTokenB, ['function confidentialBalanceOf(address) view returns (bytes32)'], provider);
const fhevm = await createInstance({ ...SepoliaConfig, network: process.env.SEPOLIA_RPC_URL });
const kp = fhevm.generateKeypair();
const start = Math.floor(Date.now() / 1000);
const eip712 = fhevm.createEIP712(kp.publicKey, [cfg.batch, cfg.cTokenA, cfg.cTokenB], start, 1);
const sig = async (w) => ethers.Signature.from(await w.signTypedData(eip712.domain, { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification }, eip712.message)).serialized;
const dec = async (wallet, handle, contractAddress) => (await fhevm.userDecrypt([{ handle, contractAddress }], kp.privateKey, kp.publicKey, await sig(wallet), [cfg.batch, cfg.cTokenA, cfg.cTokenB], wallet.address, start, 1))[handle];
const round = await batch.rounds(2);
console.log(`Round 2: matched=${round.matched} netSwapped=${round.netSwapped} swapOutput=${round.swapOutput} surplus=${round.aWasSurplus ? 'A' : 'B'} executed=${round.executed}`);
const hA = ethers.hexlify(await W2.confidentialBalanceOf(alice.address)); // alice holds c-vETH (cTokenB)
const aCveth = await dec(alice, hA, cfg.cTokenB);
const hB = ethers.hexlify(await W.confidentialBalanceOf(bob.address)); // bob holds c-vUSD (cTokenA)
const bCvusd = await dec(bob, hB, cfg.cTokenA);
console.log(`alice c-vETH balance: ${aCveth}`);
console.log(`bob   c-vUSD balance: ${bCvusd}`);
