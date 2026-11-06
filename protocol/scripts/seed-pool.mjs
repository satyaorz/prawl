/**
 * Deepen the Uniswap v4 demo pool so batched swaps move the price less.
 *
 * Mints extra vUSD/vETH to the keeper (the mock tokens have an open mint),
 * approves the poolModifyLiquidityTest helper and adds liquidity across the
 * same ±6% tick band the pool was created with.
 *
 *   cd protocol && SEPOLIA_RPC_URL=… node scripts/seed-pool.mjs [multiplier]
 */
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { encodePoolModifyLiquidity } from '../../src/v4-encoding.js';

const root = new URL('../..', import.meta.url).pathname;
const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL, 11155111, { staticNetwork: true });
const keeper = new ethers.Wallet(process.env.PROTOCOL_PRIVATE_KEY, provider);
const cfg = JSON.parse(readFileSync(`${root}/batch-config.json`, 'utf8'));

const SEPOLIA = {
  poolModifyLiquidityTest: '0x0c478023803a644c94c4ce1c1e7b9a087e411b0a',
};
const POOL_KEY = cfg.poolKey;
const ERC20_ABI = [
  'function mint(address,uint256) returns ()',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
];
const TEST_ABI = ['function modifyLiquidity(bytes32,(address,address,uint24,int24,address),int24,int24,int256,bytes32,bytes)'];

const MULTIPLIER = BigInt(process.argv[2] || '10'); // 10x the original seeding
const BASE_LIQUIDITY = 10_000n * 10n ** 18n;
const EXTRA = BASE_LIQUIDITY * (MULTIPLIER - 1n);

const log = (m) => console.log(`[seed] ${m}`);
const waitTx = async (tx) => {
  log(`tx ${tx.hash}`);
  const r = await tx.wait();
  log(`mined block ${r.blockNumber} status ${r.status}`);
  return r;
};

async function main() {
  const tokens = [cfg.tokenA, cfg.tokenB];
  const test = new ethers.Contract(SEPOLIA.poolModifyLiquidityTest, TEST_ABI, keeper);
  log(`keeper ${keeper.address}, adding liquidity x${MULTIPLIER} (${ethers.formatUnits(EXTRA, 18)} units)`);

  for (const token of tokens) {
    const c = new ethers.Contract(token, ERC20_ABI, keeper);
    const symbol = await c.symbol();
    const bal = await c.balanceOf(keeper.address);
    if (bal < EXTRA) await waitTx(await c.mint(keeper.address, EXTRA - bal));
    log(`${symbol} balance ${ethers.formatUnits(await c.balanceOf(keeper.address), 18)}`);
    await waitTx(await c.approve(SEPOLIA.poolModifyLiquidityTest, EXTRA));
  }

  const data = encodePoolModifyLiquidity(POOL_KEY, {
    tickLower: -600,
    tickUpper: 600,
    liquidityDelta: EXTRA,
  });
  await waitTx(await test.modifyLiquidity(
    ethers.ZeroHash,
    POOL_KEY,
    -600,
    600,
    EXTRA,
    ethers.ZeroHash,
    '0x',
  ).catch(async (e) => {
    // Fallback: raw calldata if the typed overload mismatches.
    log(`typed call failed (${String(e.message).slice(0, 80)}…) — sending raw calldata`);
    const sent = await keeper.sendTransaction({ to: SEPOLIA.poolModifyLiquidityTest, data });
    const rec = await sent.wait();
    log(`raw tx mined block ${rec.blockNumber} status ${rec.status}`);
    return rec;
  }));

  log('done — pool liquidity deepened');
}

main().catch((e) => { console.error(e); process.exit(1); });
