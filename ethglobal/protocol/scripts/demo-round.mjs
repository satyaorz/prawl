/**
 * Runs one complete confidential batch round on Sepolia from Node:
 *
 *   mint → wrap (alice: vUSD→c-vUSD, bob: vETH→c-vETH)
 *   → encrypted deposits (FHE inputs, ZK proofs)
 *   → closeRound → Zama Gateway publicDecrypt → settleRound(minSwapOutput)
 *   → pro-rata withdraw for both → userDecrypt final balances
 *
 * Prints a transparency report of everything that is public on-chain.
 *
 *   cd protocol && node scripts/demo-round.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

function loadEnvFile(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
}
loadEnvFile(resolve(root, '.env.local'));
loadEnvFile(resolve(root, 'protocol/.env'));

const RPC = process.env.RPC_URL_SEPOLIA || process.env.SEPOLIA_RPC_URL;
const config = JSON.parse(readFileSync(resolve(root, 'batch-config.json'), 'utf8'));
if (!config?.deployed) throw new Error('No deployment found — run scripts/deploy-stack.mjs first.');

const provider = new ethers.JsonRpcProvider(RPC, 11155111, { staticNetwork: true });
const keeper = new ethers.Wallet(process.env.PROTOCOL_PRIVATE_KEY, provider);
const alice = new ethers.Wallet(process.env.DEMO_KEY_ALICE, provider);
const bob = new ethers.Wallet(process.env.DEMO_KEY_BOB, provider);
const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

const ERC20 = ['function mint(address,uint256)', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)'];
const WRAPPER_ABI = [
  ...ERC20,
  'function wrap(address to, uint256 amount)',
  'function unwrap(address from, address to, bytes32 encryptedAmount, bytes calldata inputProof)',
  'function confidentialTransferAndCall(address to, bytes32 encryptedAmount, bytes calldata inputProof, bytes calldata data)',
  'function confidentialBalanceOf(address) view returns (bytes32)',
  'function rate() view returns (uint256)',
  'function decimals() view returns (uint8)',
];
const BATCH_ABI = [
  'function currentRound() view returns (uint256)',
  'function rounds(uint256) view returns (bytes32 aToB, bytes32 bToA, bool closed, bool prepared, bool executed, bool aWasSurplus, uint64 totalAIn, uint64 totalBIn, uint64 matched, uint64 netSwapped, uint64 minSwapOutput, bytes32 unwrapHandle, uint64 swapOutput)',
  'function userDeposits(uint256,uint8,address) view returns (bytes32)',
  'function withdrawn(uint256,uint8,address) view returns (bool)',
  'function minRoundDuration() view returns (uint256)',
  'function minDistinctSubmitters() view returns (uint256)',
  'function settler() view returns (address)',
  'function lastUpdateTime() view returns (uint256)',
  'function closeRound()',
  'function prepareSettle(uint256 roundId, bytes clearValues, bytes decryptionProof, uint64 minSwapOutput)',
  'function executeSettle(uint256 roundId, uint64 unwrapCleartext, bytes decryptionProof)',
  'function withdraw(uint256 roundId, uint8 direction)',
  'event DepositSubmitted(uint256 indexed round, uint8 indexed direction, address indexed user)',
  'event RoundClosed(uint256 indexed round)',
  'event RoundSettled(uint256 indexed round, bool aWasSurplus, uint64 matched, uint64 netSwapped, uint64 swapOutput)',
];

const batch = new ethers.Contract(config.batch, BATCH_ABI, keeper);
const cA = new ethers.Contract(config.cTokenA, WRAPPER_ABI, provider);
const cB = new ethers.Contract(config.cTokenB, WRAPPER_ABI, provider);
const tA = new ethers.Contract(config.tokenA, ERC20, provider);
const tB = new ethers.Contract(config.tokenB, ERC20, provider);

const configuredSettler = await batch.settler();
if (configuredSettler.toLowerCase() !== keeper.address.toLowerCase()) {
  throw new Error(`Configured settler ${configuredSettler} does not match PROTOCOL_PRIVATE_KEY signer ${keeper.address}.`);
}

async function waitTx(wallet, contract, method, args, label) {
  const connected = contract.connect(wallet);
  const tx = await connected[method](...args);
  log(`${label}: ${tx.hash}`);
  const receipt = await tx.wait(1);
  if (receipt.status !== 1) throw new Error(`${label} reverted`);
  log(`${label}: ✓ block ${receipt.blockNumber} gas=${receipt.gasUsed}`);
  return receipt;
}

const DIRECTION = { A_TO_B: 1, B_TO_A: 2 };

let fhevmInstance;

async function settleTwoPhase(roundId, handleA, handleB, minSwapOutput) {
  let pre = await batch.rounds(roundId);
  let totalA;
  let totalB;
  let minOut = minSwapOutput;
  let totalsDecryption;
  if (!pre.prepared) {
    totalsDecryption = await fhevmInstance.publicDecrypt([handleA, handleB]);
    totalA = totalsDecryption.clearValues[handleA];
    totalB = totalsDecryption.clearValues[handleB];
    log(`Gateway decryption: totalAIn=${totalA} totalBIn=${totalB} (proof ${totalsDecryption.decryptionProof.slice(0, 20)}…)`);
  } else {
    totalA = pre.totalAIn;
    totalB = pre.totalBIn;
    log(`Round ${roundId} already prepared: totalAIn=${totalA} totalBIn=${totalB}`);
  }
  const net = totalA >= totalB ? totalA - totalB : totalB - totalA;
  // 1:1 demo pool ⇒ expect 1:1 out; require ≥95% to absorb rounding + fee
  if (minOut === 'AUTO') minOut = net > 0n ? (net * 9500n + 9999n) / 10000n : 0n;
  if (!pre.prepared) {
    await waitTx(keeper, batch, 'prepareSettle', [roundId, totalsDecryption.abiEncodedClearValues, totalsDecryption.decryptionProof, minOut], 'prepareSettle');
    pre = await batch.rounds(roundId);
  }
  if (!pre.executed) {
    if (net > 0n) {
      const unwrapHandle = ethers.hexlify(pre.unwrapHandle);
      const dec2 = await fhevmInstance.publicDecrypt([unwrapHandle]);
      const cleartext = dec2.clearValues[unwrapHandle];
      log(`Unwrap request decrypted: ${cleartext} (proof ${dec2.decryptionProof.slice(0, 20)}…)`);
      await waitTx(keeper, batch, 'executeSettle', [roundId, cleartext, dec2.decryptionProof], 'executeSettle (swap leg)');
    } else {
      await waitTx(keeper, batch, 'executeSettle', [roundId, 0, '0x'], 'executeSettle (fully matched)');
    }
  } else {
    log(`Round ${roundId} already executed — skipping settlement`);
  }
  return { totalA, totalB, net };
}

async function recoverPendingRound() {
  // If a previous run closed a round but settlement failed, recover it first:
  // settle (gateway decrypt + slippage guard) and withdraw for both demo users.
  const currentRound = Number(await batch.currentRound());
  const pending = currentRound - 1;
  if (pending < 1) return;
  const round = await batch.rounds(pending);
  if (!round.closed || round.executed) return;
  log(`recovering unsettled round ${pending}…`);
  const handleA = ethers.hexlify(round.aToB);
  const handleB = ethers.hexlify(round.bToA);
  await settleTwoPhase(pending, handleA, handleB, 'AUTO');
  for (const [wallet, direction] of [[alice, DIRECTION.A_TO_B], [bob, DIRECTION.B_TO_A]]) {
    if (!(await batch.withdrawn(pending, direction, wallet.address))) {
      await waitTx(wallet, batch, 'withdraw', [pending, direction], `withdraw r${pending} ${wallet.address === alice.address ? 'alice' : 'bob'}`);
    }
  }
}

async function main() {
  for (const [name, wallet] of [['keeper', keeper], ['alice', alice], ['bob', bob]]) {
    const bal = await provider.getBalance(wallet.address);
    log(`${name} ${wallet.address} ${ethers.formatEther(bal)} ETH`);
    if (bal < ethers.parseEther('0.005')) throw new Error(`${name} needs ≥0.005 Sepolia ETH`);
  }

  log('Initializing FHEVM instance (Sepolia)…');
  fhevmInstance = await createInstance({ ...SepoliaConfig, network: RPC });
  log('FHEVM instance ready');
  await recoverPendingRound();

  const AMOUNT_A = 150n * 10n ** 6n; // alice: 150 c-vUSD → wants vETH
  const AMOUNT_B = 100n * 10n ** 6n; // bob:   100 c-vETH → wants vUSD
  const rate = await cA.rate();
  const underlyingA = AMOUNT_A * rate; // wrap input in 18-dp underlying
  const underlyingB = AMOUNT_B * rate;

  // 1. Faucet + wrap
  await waitTx(alice, tA, 'mint', [alice.address, underlyingA], 'faucet vUSD → alice');
  await waitTx(bob, tB, 'mint', [bob.address, underlyingB], 'faucet vETH → bob');
  await waitTx(alice, tA, 'approve', [config.cTokenA, underlyingA], 'alice approves c-vUSD');
  await waitTx(bob, tB, 'approve', [config.cTokenB, underlyingB], 'bob approves c-vETH');
  await waitTx(alice, cA, 'wrap', [alice.address, underlyingA], 'alice wraps → c-vUSD');
  await waitTx(bob, cB, 'wrap', [bob.address, underlyingB], 'bob wraps → c-vETH');

  // 2. Encrypted deposits (direction byte packed in callback data)
  const roundBefore = Number(await batch.currentRound());
  log(`Depositing into round ${roundBefore}: alice 150 vUSD→vETH, bob 100 vETH→vUSD (amounts encrypted)`);
  for (const [wallet, wrapper, direction, amount] of [
    [alice, cA, DIRECTION.A_TO_B, AMOUNT_A],
    [bob, cB, DIRECTION.B_TO_A, AMOUNT_B],
  ]) {
    const enc = await fhevmInstance.createEncryptedInput(await wrapper.getAddress(), wallet.address).add64(amount).encrypt();
    log(`encrypted deposit handle ${ethers.hexlify(enc.handles[0]).slice(0, 18)}… (value hidden)`);
    await waitTx(wallet, wrapper, 'confidentialTransferAndCall', [
      config.batch, enc.handles[0], enc.inputProof, `0x0${direction}`,
    ], `deposit ${wallet.address === alice.address ? 'alice' : 'bob'} d${direction}`);
  }

  // 3. Close (time + threshold gated)
  const minRound = Number(await batch.minRoundDuration());
  const lastUpdate = Number(await batch.lastUpdateTime());
  const elapsed = Math.floor(Date.now() / 1000) - lastUpdate;
  if (elapsed < minRound) {
    log(`waiting ${minRound - elapsed}s for round window…`);
    await new Promise(r => setTimeout(r, (minRound - elapsed + 1) * 1000));
  }
  await waitTx(keeper, batch, 'closeRound', [], 'closeRound');

  // 4. Gateway decryption → settlement with slippage guard
  const round = await batch.rounds(roundBefore);
  const handleA = ethers.hexlify(round.aToB);
  const handleB = ethers.hexlify(round.bToA);
  log(`public handles: aToB=${handleA.slice(0, 18)}… bToA=${handleB.slice(0, 18)}…`);
  // Slippage guard is applied inside settleTwoPhase (95% of the decrypted net).
  await settleTwoPhase(roundBefore, handleA, handleB, 'AUTO');

  const settled = await batch.rounds(roundBefore);
  log(`Round ${roundBefore} settled: matched=${settled.matched} netSwapped=${settled.netSwapped} swapOutput=${settled.swapOutput} surplus=${settled.aWasSurplus ? 'A' : 'B'}`);

  // 5. Withdraw + decrypt final balances
  for (const [wallet, direction] of [[alice, DIRECTION.A_TO_B], [bob, DIRECTION.B_TO_A]]) {
    if (!(await batch.withdrawn(roundBefore, direction, wallet.address))) {
      await waitTx(wallet, batch, 'withdraw', [roundBefore, direction], `withdraw ${wallet.address === alice.address ? 'alice' : 'bob'}`);
    }
  }

  // userDecrypt both confidential balances
  const keypair = fhevmInstance.generateKeypair();
  const start = Math.floor(Date.now() / 1000);
  const eip712 = fhevmInstance.createEIP712(keypair.publicKey, [config.batch, config.cTokenA, config.cTokenB], start, 1);
  const sigFor = async (wallet) => ethers.Signature.from(await wallet.signTypedData(eip712.domain, { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification }, eip712.message)).serialized;
  const decrypt = async (wallet, handle, contractAddress) => {
    const results = await fhevmInstance.userDecrypt(
      [{ handle, contractAddress }],
      keypair.privateKey, keypair.publicKey, await sigFor(wallet),
      [config.batch, config.cTokenA, config.cTokenB], wallet.address, start, 1,
    );
    return results[handle];
  };

  const aliceOut = await decrypt(alice, ethers.hexlify(await cB.confidentialBalanceOf(alice.address)), config.cTokenB);
  const bobOut = await decrypt(bob, ethers.hexlify(await cA.confidentialBalanceOf(bob.address)), config.cTokenA);

  console.log('\n================ TRANSPARENCY REPORT ================');
  console.log(`Round ${roundBefore} on Sepolia (batcher ${config.batch})`);
  console.log(`  PUBLIC:  participants (DepositSubmitted events): alice d1, bob d2`);
  console.log(`  PUBLIC:  aggregate totals after close: aToB=${settled.totalAIn} bToA=${settled.totalBIn}`);
  console.log(`  PUBLIC:  matched=${settled.matched} netSwapped=${settled.netSwapped} swapOutput=${settled.swapOutput}`);
  console.log(`  PRIVATE: individual amounts — only decryptable by their owners:`);
  console.log(`    alice deposited ${AMOUNT_A} c-vUSD → received ${aliceOut} c-vETH`);
  console.log(`    bob deposited ${AMOUNT_B} c-vETH → received ${bobOut} c-vUSD`);
  console.log(`  Slippage guard required ≥ ${settled.netSwapped > 0n ? (settled.netSwapped * 95n) / 100n : 0n} swap output ✓`);
  console.log('=====================================================\n');
  log('Demo round complete ✓');
}

main().catch((error) => {
  console.error('DEMO FAILED:', error?.reason ?? error?.shortMessage ?? error.message);
  process.exit(1);
});
