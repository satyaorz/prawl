/**
 * Deploys the full Veil batch-swap stack to Sepolia from Node (no MetaMask):
 *   vUSD, vETH (demo ERC20s) → V4 pool (1:1, seeded liquidity)
 *   → c-vUSD, c-vETH (ERC-7984 wrappers) → VeilBatchSwap
 *
 * Keys come from protocol/.env (PROTOCOL_PRIVATE_KEY). Run:
 *   cd protocol && node scripts/deploy-stack.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

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
if (!RPC) throw new Error('Set SEPOLIA_RPC_URL in .env.local');
if (!process.env.PROTOCOL_PRIVATE_KEY) throw new Error('Set PROTOCOL_PRIVATE_KEY in protocol/.env');

const SEPOLIA = {
  chainId: 11155111,
  poolManager: '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543',
  universalRouter: '0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  poolModifyLiquidityTest: '0x0c478023803a644c94c4ce1c1e7b9a087e411b0a',
};

const provider = new ethers.JsonRpcProvider(RPC, 11155111, { staticNetwork: true });
const keeper = new ethers.Wallet(process.env.PROTOCOL_PRIVATE_KEY, provider);
const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

async function wait(hash, label) {
  log(`${label}: ${hash}`);
  const receipt = await provider.waitForTransaction(hash, 1, 180_000);
  if (receipt.status !== 1) throw new Error(`${label} reverted: ${hash}`);
  log(`${label}: mined block ${receipt.blockNumber} gas=${receipt.gasUsed}`);
  return receipt;
}

async function deployArtifact(artifactPath, args, label) {
  const { abi, bytecode } = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const factory = new ethers.ContractFactory(abi, bytecode, keeper);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const deploymentReceipt = await contract.deploymentTransaction().wait();
  const address = await contract.getAddress();
  log(`${label}: ${address}`);
  return { address, abi, deployedBlock: deploymentReceipt.blockNumber };
}

// ---- PoolKey ABI encoding (v4-core order: currency0, currency1, fee, tickSpacing, hooks) ----
const addr = (a) => ethers.zeroPadValue(a.toLowerCase(), 32);
const poolKeyEncoding = (pk) => addr(pk.currency0) + addr(pk.currency1)
  + ethers.zeroPadValue(ethers.toBeHex(pk.fee), 32).slice(2)
  + ethers.zeroPadValue(ethers.toBeHex(BigInt.asIntN(24, pk.tickSpacing)), 32).slice(2)
  + addr(pk.hooks);

const STATE_PATH = resolve(here, '../deployments/state.json');
mkdirSync(resolve(here, '../deployments'), { recursive: true });
const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};
const saveState = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

async function main() {
  const balance = await provider.getBalance(keeper.address);
  log(`keeper ${keeper.address} balance ${ethers.formatEther(balance)} ETH`);
  if (balance < ethers.parseEther('0.02')) throw new Error('Keeper needs ≥0.02 Sepolia ETH — fund it from a faucet or your MetaMask.');

  const minRoundSeconds = Number(process.env.VEIL_MIN_ROUND_SECONDS || 60);
  const minUsers = Number(process.env.VEIL_MIN_USERS || 2);

  // 1. Demo tokens (MockERC20 — open mint, from the main project's artifact)
  const mockBin = readFileSync(resolve(root, 'public/artifacts/MockERC20.bin'), 'utf8').trim().replace(/^0x/i, '');
  const mockAbi = JSON.parse(readFileSync(resolve(root, 'public/artifacts/MockERC20.abi'), 'utf8'));
  const deploySimple = async (name, symbol) => {
    const factory = new ethers.ContractFactory(mockAbi, `0x${mockBin}`, keeper);
    const c = await factory.deploy(name, symbol);
    await c.waitForDeployment();
    return { address: await c.getAddress(), abi: mockAbi };
  };
  let vusd, veth;
  if (state.tokens) {
    vusd = { address: state.tokens.vusd, abi: mockAbi };
    veth = { address: state.tokens.veth, abi: mockAbi };
    log(`resuming with vUSD ${vusd.address} · vETH ${veth.address}`);
  } else {
    vusd = await deploySimple('Veil Demo Dollar', 'vUSD');
    veth = await deploySimple('Veil Demo Ether', 'vETH');
    state.tokens = { vusd: vusd.address, veth: veth.address };
    saveState();
    log(`vUSD ${vusd.address} · vETH ${veth.address}`);
  }

  if (!state.minted) {
    for (const token of [vusd, veth]) {
      const c = new ethers.Contract(token.address, mockAbi, keeper);
      await wait((await c.mint(keeper.address, 1_000_000n * 10n ** 18n)).hash, `mint 1M ${token === vusd ? 'vUSD' : 'vETH'}`);
    }
    state.minted = true;
    saveState();
  }

  // 2. Uniswap v4 pool: initialize at 1:1, seed liquidity
  const [currency0, currency1] = [vusd.address, veth.address]
    .map(a => a.toLowerCase())
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const poolKey = { currency0, currency1, fee: 3000, tickSpacing: 60, hooks: ethers.ZeroAddress };

  const manager = new ethers.Contract(SEPOLIA.poolManager, [
    'function initialize((address,address,uint24,int24,address) calldata key, uint160 sqrtPriceX96) external returns (int24)',
  ], keeper);
  // PoolKey struct encoding for ethers: pass as array in declaration order.
  if (!state.poolInitialized) {
    await wait((await manager.initialize(
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
      1n << 96n,
    )).hash, 'initialize V4 pool');
    state.poolInitialized = true;
    saveState();
  }

  // poolModifyLiquidityTest helper: modifyLiquidity(PoolKey,(int24,int24,int256,bytes),bytes)
  const helper = new ethers.Contract(SEPOLIA.poolModifyLiquidityTest, [
    'function modifyLiquidity((address,address,uint24,int24,address) calldata key, (int24,int24,int256,bytes32) calldata params, bytes calldata hookData) external returns (int256)',
  ], keeper);
  if (!state.liquidityAdded) {
    for (const token of [vusd, veth]) {
      const c = new ethers.Contract(token.address, mockAbi, keeper);
      await wait((await c.approve(SEPOLIA.poolModifyLiquidityTest, 2n ** 256n - 1n)).hash, `approve ${token === vusd ? 'vUSD' : 'vETH'} for liquidity helper`);
    }
    await wait((await helper.modifyLiquidity(
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
      [-600, 600, 10_000n * 10n ** 18n, '0x' + '0'.repeat(64)], // salt = bytes32(0)
      '0x',
    )).hash, 'add 1:1 liquidity');
    state.liquidityAdded = true;
    saveState();
  }

  // 3. Confidential wrappers + batcher
  const artDir = resolve(here, '../artifacts/contracts');
  let wrapper, wrapperB, batch;
  let batchDeployedBlock;
  const redeployBatch = process.env.VEIL_REDEPLOY_BATCH === '1';
  if (state.stack) {
    ({ cTokenA: wrapper, cTokenB: wrapperB } = state.stack);
    batchDeployedBlock = state.stack.deployedBlock ?? null;
    wrapper = { address: wrapper };
    wrapperB = { address: wrapperB };
    if (!redeployBatch) {
      batch = { address: state.stack.batch };
      log(`resuming with wrappers ${wrapper.address} / ${wrapperB.address} and batch ${batch.address}`);
    } else {
      log(`reusing wrappers ${wrapper.address} / ${wrapperB.address}; deploying one new batcher`);
    }
  } else {
    wrapper = await deployArtifact(resolve(artDir, 'VeilConfidentialWrapper.sol/VeilConfidentialWrapper.json'), [vusd.address], 'c-vUSD wrapper');
    wrapperB = await deployArtifact(resolve(artDir, 'VeilConfidentialWrapper.sol/VeilConfidentialWrapper.json'), [veth.address], 'c-vETH wrapper');
  }
  if (!state.stack || redeployBatch) {
    batch = await deployArtifact(resolve(artDir, 'VeilBatchSwap.sol/VeilBatchSwap.json'), [
      SEPOLIA.universalRouter,
      SEPOLIA.permit2,
      wrapper.address,
      wrapperB.address,
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
      minRoundSeconds,
      minUsers,
      keeper.address,
    ], redeployBatch ? 'VeilBatchSwap (redeploy)' : 'VeilBatchSwap');
    batchDeployedBlock = batch.deployedBlock;
    state.stack = { cTokenA: wrapper.address, cTokenB: wrapperB.address, batch: batch.address, deployedBlock: batchDeployedBlock };
    saveState();
  }

  const config = {
    chainId: 11155111,
    deployed: true,
    protocolVersion: 2,
    batch: batch.address,
    cTokenA: wrapper.address,
    cTokenB: wrapperB.address,
    tokenA: vusd.address,
    tokenB: veth.address,
    poolKey,
    deployedBy: keeper.address,
    settler: keeper.address,
    deployedBlock: batchDeployedBlock,
    deployedAt: new Date().toISOString(),
    minRoundSeconds,
    minUsers,
  };

  mkdirSync(resolve(here, '../deployments'), { recursive: true });
  writeFileSync(resolve(here, '../deployments/sepolia.json'), JSON.stringify(config, null, 2));
  writeFileSync(resolve(root, 'batch-config.json'), JSON.stringify(config, null, 2));
  log('Deployment saved → protocol/deployments/sepolia.json + batch-config.json');
  log(JSON.stringify(config, null, 2));
}

main().catch((error) => {
  console.error('DEPLOY FAILED:', error.message);
  process.exit(1);
});
