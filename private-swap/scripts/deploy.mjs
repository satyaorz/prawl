/**
 * Deploy the Prawl confidential swap stack to Sepolia and emit the wallet
 * manifest consumed by `VITE_PRAWL_SWAP_DEPLOYMENT`.
 *
 * Stack, in order:
 *   1. PrawlToken (custom 18-dp ERC-20, fixed supply)         — tokenB
 *   2. WETH  (Sepolia canonical WETH9)                        — tokenA
 *   3. c-WETH / c-PRAWL (ERC-7984 wrappers, 6-dp confidential units)
 *   4. Uniswap v4 pool (WETH/PRAWL) + seeded liquidity
 *   5. PoolLotPriceOracle  (reads this very pool's price) -> lot price
 *   6. VeilBatchSwap v4
 *
 * Usage:
 *   SEPOLIA_RPC_URL=... DEPLOYER_PRIVATE_KEY=... \
 *   node scripts/deploy.mjs
 *
 * No external price feed is required: the batch settles against one Uniswap v4
 * pool, so that pool's own price is the quote.
 *
 * Writes:
 *   deployments/sepolia.json   (human record)
 *   deployments/manifest.json  (the wallet's build-time manifest)
 *
 * Resumable: every finished step is recorded in deployments/state.json and is
 * skipped on a re-run. Nothing here hides or fakes a failure: a reverted
 * transaction aborts the run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function loadEnv(path) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {}
}
loadEnv(resolve(root, ".env.local"));
loadEnv(resolve(root, ".env"));

const RPC = process.env.SEPOLIA_RPC_URL;
const KEY = process.env.DEPLOYER_PRIVATE_KEY;
if (!RPC) throw new Error("Set SEPOLIA_RPC_URL");
if (!KEY) throw new Error("Set DEPLOYER_PRIVATE_KEY");

/** Sepolia addresses that the protocol depends on. Verified against the live chain before use. */
const SEPOLIA = {
  chainId: 11155111,
  weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  poolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
  universalRouter: "0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  poolModifyLiquidityTest: "0x0c478023803a644c94c4ce1c1e7b9a087e411b0a",
  stateView: "0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c",
};

/** Full range for a 60-tick spacing: the nearest multiples of the spacing inside Uniswap's tick bounds. */
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const usableTick = (tick, spacing) => Math.trunc(tick / spacing) * spacing;


const POOL_FEE = Number(process.env.PRAWL_POOL_FEE ?? 3000);
const TICK_SPACING = Number(process.env.PRAWL_TICK_SPACING ?? 60);
const MIN_ROUND_SECONDS = Number(process.env.PRAWL_MIN_ROUND_SECONDS ?? 60);
const MIN_USERS = Number(process.env.PRAWL_MIN_USERS ?? 2);
const REFUND_DELAY = Number(process.env.PRAWL_REFUND_DELAY ?? 3600);
const MAX_PRICE_AGE = Number(process.env.PRAWL_MAX_PRICE_AGE ?? 1800);
const SUPPLY = BigInt(process.env.PRAWL_TOKEN_SUPPLY ?? "100000000000000000000000000"); // 100M
// WETH put into the pool (with PRAWL at the starting price). One lot is the
// unit every order is a multiple of; keep it a small share of this depth so a
// residual does not move the price, or the 97% floor will refuse the trade.
const SEED_WETH = ethers.parseEther(process.env.PRAWL_SEED_WETH ?? "0.06");
// Extra WETH kept by the deployer for demo participants (the pool seed is separate).
const EXTRA_WETH = ethers.parseEther(process.env.PRAWL_EXTRA_WETH ?? "0.01");
const LOT_WETH = BigInt(process.env.PRAWL_LOT_WETH ?? "100000000000000"); // 0.0001 WETH

const provider = new ethers.JsonRpcProvider(RPC, SEPOLIA.chainId, { staticNetwork: true });
const deployer = new ethers.Wallet(KEY, provider);
// A deployment directory is explicit so one funded test key never resumes a
// partial stack owned by another key. Existing records remain untouched.
const deploymentDir = process.env.PRAWL_DEPLOYMENTS_DIR ?? "deployments";
if (!/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(deploymentDir)) throw new Error("Invalid PRAWL_DEPLOYMENTS_DIR");
const outDir = resolve(root, deploymentDir);
if (!outDir.startsWith(`${root}/`)) throw new Error("PRAWL_DEPLOYMENTS_DIR escapes the project");
const statePath = resolve(outDir, "state.json");
mkdirSync(outDir, { recursive: true });
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function wait(hash, label) {
  log(`${label}: ${hash}`);
  const receipt = await provider.waitForTransaction(hash, 1, 240_000);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} reverted: ${hash}`);
  log(`${label}: block ${receipt.blockNumber} gas=${receipt.gasUsed}`);
  return receipt;
}

function artifact(relative) {
  const path = resolve(root, "artifacts/contracts", relative);
  if (!existsSync(path)) throw new Error(`Missing artifact ${relative}; run npm run compile`);
  return JSON.parse(readFileSync(path, "utf8"));
}

async function deploy(relative, args, label) {
  const { abi, bytecode } = artifact(relative);
  if (!bytecode || bytecode === "0x") throw new Error(`${relative} has no bytecode`);
  const factory = new ethers.ContractFactory(abi, bytecode, deployer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const receipt = await contract.deploymentTransaction().wait();
  const address = await contract.getAddress();
  log(`${label}: ${address} (block ${receipt.blockNumber}, tx ${receipt.hash})`);
  return { address, abi, block: receipt.blockNumber, tx: receipt.hash };
}

const poolKeyArgs = (key) => [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];

async function main() {
  const balance = await provider.getBalance(deployer.address);
  log(`deployer ${deployer.address} has ${ethers.formatEther(balance)} ETH`);
  // Seed + spare WETH + gas for ~12 transactions; on a resume the seed is already spent, so only gas is needed.
  const needed = state.wrapped ? ethers.parseEther("0.02") : SEED_WETH + EXTRA_WETH + ethers.parseEther("0.04");
  if (balance < needed) throw new Error(`Deployer needs at least ${ethers.formatEther(needed)} Sepolia ETH (seed liquidity + gas)`);

  // Confirm the infrastructure addresses actually hold code on this chain.
  for (const [name, address] of Object.entries({
    weth: SEPOLIA.weth,
    poolManager: SEPOLIA.poolManager,
    universalRouter: SEPOLIA.universalRouter,
    permit2: SEPOLIA.permit2,
    liquidityHelper: SEPOLIA.poolModifyLiquidityTest,
    stateView: SEPOLIA.stateView,
  })) {
    const code = await provider.getCode(address);
    if (code === "0x") throw new Error(`${name} at ${address} has no code on chain ${SEPOLIA.chainId}`);
  }

  // 1. Custom token.
  if (!state.token) {
    state.token = await deploy("PrawlToken.sol/PrawlToken.json", ["Prawl", "PRAWL", deployer.address, SUPPLY], "PrawlToken");
    save();
  } else log(`resuming with PrawlToken ${state.token.address}`);

  // 2. Liquidity: keep enough WETH and PRAWL to seed the pool at a sane price.
  const tokenAbi = artifact("PrawlToken.sol/PrawlToken.json").abi;
  const wethAbi = ["function balanceOf(address) view returns (uint256)", "function deposit() payable", "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)"];
  const token = new ethers.Contract(state.token.address, tokenAbi, deployer);
  const weth = new ethers.Contract(SEPOLIA.weth, wethAbi, deployer);
  const existingWeth = await weth.balanceOf(deployer.address);
  const requiredWeth = SEED_WETH + EXTRA_WETH;
  if (!state.wrapped) {
    const toWrap = requiredWeth - existingWeth;
    await wait((await weth.deposit({ value: toWrap })).hash, `wrap ${ethers.formatEther(toWrap)} ETH to WETH`);
    state.wrapped = true;
    save();
  }

  // 3. Confidential wrappers (underlying amount is divided by rate = 1e12 for 18->6 dp).
  if (!state.wrapperWeth) {
    state.wrapperWeth = await deploy("VeilConfidentialWrapper.sol/VeilConfidentialWrapper.json", [SEPOLIA.weth], "c-WETH wrapper");
    save();
  } else log(`resuming with c-WETH ${state.wrapperWeth.address}`);
  if (!state.wrapperPrawl) {
    state.wrapperPrawl = await deploy("VeilConfidentialWrapper.sol/VeilConfidentialWrapper.json", [state.token.address], "c-PRAWL wrapper");
    save();
  } else log(`resuming with c-PRAWL ${state.wrapperPrawl.address}`);

  // 4. Pool. currency0 is the lower address (the protocol requires sorted currencies).
  const [currency0, currency1] = [SEPOLIA.weth, state.token.address]
    .map((a) => a.toLowerCase())
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const key = { currency0, currency1, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: ethers.ZeroAddress };

  const manager = new ethers.Contract(SEPOLIA.poolManager, [
    "function initialize((address,address,uint24,int24,address) key, uint160 sqrtPriceX96) external returns (int24)",
  ], deployer);
  if (!state.poolInitialized) {
    // The starting price is an explicit choice, not a side effect of whatever
    // balances happen to sit in the deployer. Deriving it from balances once
    // produced a pool at 500M PRAWL/WETH, which made a single WETH lot cost
    // 5e26 wei — impossible to trade. PRAWL_PER_WETH is the prototype rate.
    // Uniswap encodes price as token1 per token0. currency0 is the smaller
    // address; find which side that is and invert as needed so the *human*
    // rate (PRAWL_PER_WETH) is what the pool actually quotes.
    const prawlPerWeth = Number(process.env.PRAWL_PER_WETH ?? "100");
    if (!Number.isFinite(prawlPerWeth) || prawlPerWeth <= 0) throw new Error("PRAWL_PER_WETH must be a positive number");
    const token0IsPrawl = currency0 === state.token.address.toLowerCase();
    // token1/token0
    const poolPrice = token0IsPrawl ? 1 / prawlPerWeth : prawlPerWeth;
    const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(poolPrice) * 2 ** 96));
    await wait((await manager.initialize(poolKeyArgs(key), sqrtPriceX96)).hash, `initialize v4 pool at ${prawlPerWeth} PRAWL/WETH (raw token1/token0=${poolPrice})`);
    state.poolInitialized = true;
    state.pricePrawlPerWeth = prawlPerWeth;
    save();
  }

  const helper = new ethers.Contract(SEPOLIA.poolModifyLiquidityTest, [
    "function modifyLiquidity((address,address,uint24,int24,address) key, (int24,int24,int256,bytes32) params, bytes hookData) external returns (int256)",
  ], deployer);
  if (!state.liquidity) {
    // Full-range liquidity around the starting price. For a full-range
    // position at price P (token1 per token0, both 18 dp), the amounts it
    // holds are about L / sqrt(P) of token0 and L * sqrt(P) of token1, so the
    // largest L the balances allow is min(amount0 * sqrtP, amount1 / sqrtP).
    // (The earlier version used ticks -600..600, which only covers prices
    // within 6% of 1:1: at 100:1 the pool then had no liquidity at its price.)
    const prawlPerWeth = Number(state.pricePrawlPerWeth ?? process.env.PRAWL_PER_WETH ?? "100");
    const seedWeth = SEED_WETH;
    const seedPrawl = BigInt(Math.floor(Number(seedWeth) * prawlPerWeth));
    if (seedPrawl > (await token.balanceOf(deployer.address))) throw new Error("Not enough PRAWL to seed at the configured price");
    if (seedWeth > (await weth.balanceOf(deployer.address))) throw new Error("Not enough WETH to seed");
    for (const [contract, amount, label] of [[weth, seedWeth, "WETH"], [token, seedPrawl, "PRAWL"]]) {
      if ((await contract.allowance(deployer.address, SEPOLIA.poolModifyLiquidityTest)) < amount) {
        await wait((await contract.approve(SEPOLIA.poolModifyLiquidityTest, ethers.MaxUint256)).hash, `approve ${label} for liquidity helper`);
      }
    }
    const isWeth0 = currency0 === SEPOLIA.weth.toLowerCase();
    const [amount0, amount1] = isWeth0 ? [seedWeth, seedPrawl] : [seedPrawl, seedWeth];
    const price = isWeth0 ? prawlPerWeth : 1 / prawlPerWeth; // token1 per token0
    const sqrtP = Math.sqrt(price);
    // 5% margin so rounding in the position maths never asks for more than is held.
    const liquidity = BigInt(Math.floor(Math.min(Number(amount0) * sqrtP, Number(amount1) / sqrtP) * 0.95));
    if (liquidity <= 0n) throw new Error("Computed non-positive liquidity; check seeded amounts");
    const tickLower = usableTick(MIN_TICK, TICK_SPACING);
    const tickUpper = usableTick(MAX_TICK, TICK_SPACING);
    await wait((await helper.modifyLiquidity(poolKeyArgs(key), [tickLower, tickUpper, liquidity, ethers.ZeroHash], "0x")).hash, `seed pool liquidity (full range ${tickLower}..${tickUpper})`);
    log(`seeded about ${ethers.formatUnits(amount0, 18)} c0 and ${ethers.formatUnits(amount1, 18)} c1 (L=${liquidity})`);
    state.liquidity = true;
    save();
  }

  // The pool must now have liquidity AT its current price; otherwise the first
  // swap would cross an empty range (or fill nothing) and the round would fail.
  {
    const poolId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], poolKeyArgs(key)));
    const view = new ethers.Contract(SEPOLIA.stateView, [
      "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
      "function getLiquidity(bytes32 poolId) view returns (uint128)",
    ], provider);
    let liquidityNow = 0n, slot0;
    for (let attempt = 0; attempt < 12 && liquidityNow === 0n; ++attempt) {
      try { [slot0, liquidityNow] = await Promise.all([view.getSlot0(poolId), view.getLiquidity(poolId)]); } catch { /* node lag: retry */ }
      if (liquidityNow === 0n) await new Promise((r) => setTimeout(r, 2500));
    }
    if (liquidityNow === 0n) throw new Error(`Pool ${poolId} has no active liquidity at its current price`);
    state.poolId = poolId;
    log(`pool ${poolId}: tick ${slot0.tick}, active liquidity ${liquidityNow}`);
    save();
  }

  // 5. Price oracle. There is a single pool, so its own current price is the
  //    only quote that matters — no external feed, nothing to keep fresh or
  //    trust. lotA is one tokenA in 18-dp units; the oracle converts the pool
  //    price into confidential wrapper units itself.
  if (!state.oracle) {
    const tokenA = key.currency0 === SEPOLIA.weth.toLowerCase() ? SEPOLIA.weth : state.token.address;
    const wrapperA0 = key.currency0 === SEPOLIA.weth.toLowerCase() ? state.wrapperWeth.address : state.wrapperPrawl.address;
    const wrapperB0 = key.currency0 === SEPOLIA.weth.toLowerCase() ? state.wrapperPrawl.address : state.wrapperWeth.address;
    // The lot is defined in WETH terms (a small share of the pool's depth), so
    // it is the same real size whichever token sorts first. tokenA is currency0.
    const prawlPerWethNow = Number(state.pricePrawlPerWeth ?? process.env.PRAWL_PER_WETH ?? "100");
    const defaultLotA = key.currency0 === SEPOLIA.weth.toLowerCase() ? LOT_WETH : BigInt(Math.round(Number(LOT_WETH) * prawlPerWethNow));
    const lotAUnits = BigInt(process.env.PRAWL_LOT_A_UNITS ?? defaultLotA);
    state.oracle = await deploy("PoolLotPriceOracle.sol/PoolLotPriceOracle.json", [
      SEPOLIA.poolManager,
      wrapperA0,
      wrapperB0,
      poolKeyArgs(key),
      lotAUnits,
    ], "PoolLotPriceOracle");
    save(); // record it before anything can fail, so a re-run never deploys a second one
  } else log(`resuming with oracle ${state.oracle.address}`);
  {
    // Public RPC nodes can lag a block behind a deployment and return empty data: retry the readback.
    const oracleRead = new ethers.Contract(state.oracle.address, ["function latestLotPrice() view returns (uint64,uint64,uint256)"], provider);
    let quote;
    for (let attempt = 0; attempt < 12 && !quote; ++attempt) {
      try { quote = await oracleRead.latestLotPrice(); } catch { await new Promise((r) => setTimeout(r, 2500)); }
    }
    if (!quote) throw new Error("Could not read the oracle after retries");
    if (quote[0] === 0n || quote[1] === 0n) throw new Error("Oracle returned an unusable lot price; check the pool is seeded");
    log(`oracle lot: ${quote[0]} tokenA = ${quote[1]} tokenB (from the pool)`);
  }

  // 6. Batch swap. cTokenA pairs with whichever asset is currency0 in the pool.
  const wrapperA = key.currency0 === SEPOLIA.weth.toLowerCase() ? state.wrapperWeth.address : state.wrapperPrawl.address;
  const wrapperB = key.currency0 === SEPOLIA.weth.toLowerCase() ? state.wrapperPrawl.address : state.wrapperWeth.address;
  if (!state.batch) {
    state.batch = await deploy("VeilBatchSwap.sol/VeilBatchSwap.json", [
      SEPOLIA.universalRouter,
      SEPOLIA.permit2,
      wrapperA,
      wrapperB,
      poolKeyArgs(key),
      MIN_ROUND_SECONDS,
      MIN_USERS,
      REFUND_DELAY,
      state.oracle.address,
      MAX_PRICE_AGE,
    ], "VeilBatchSwap v5");
    save();
  } else log(`resuming with VeilBatchSwap ${state.batch.address}`);

  // Confirm the wiring the wallet will re-verify at runtime.
  const batch = new ethers.Contract(state.batch.address, [
    "function VERSION() view returns (uint256)", "function cTokenA() view returns (address)", "function cTokenB() view returns (address)",
    "function priceOracle() view returns (address)", "function router() view returns (address)", "function permit2() view returns (address)",
    "function poolKey() view returns (address,address,uint24,int24,address)",
  ], provider);
  // Public RPC endpoints are load-balanced and can briefly serve a node that has
  // not yet seen the deployment blocks, returning empty data for a live
  // contract. Retry the readback for a short while before declaring failure.
  const readWithRetry = async (label, fn) => {
    for (let attempt = 0; attempt < 12; ++attempt) {
      try {
        const v = await fn();
        if (v !== undefined && v !== null) return v;
      } catch (err) {
        if (attempt === 11) throw new Error(`${label} failed after retries: ${err instanceof Error ? err.message : err}`);
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    throw new Error(`${label} returned no data after retries`);
  };
  const version = await readWithRetry("batch VERSION()", () => batch.VERSION());
  if (version !== 5n) throw new Error(`unexpected batch version ${version}`);
  if ((await readWithRetry("batch cTokenA()", () => batch.cTokenA())).toLowerCase() !== wrapperA.toLowerCase()) throw new Error("batch cTokenA mismatch");
  if ((await readWithRetry("batch cTokenB()", () => batch.cTokenB())).toLowerCase() !== wrapperB.toLowerCase()) throw new Error("batch cTokenB mismatch");
  const onchainKey = await readWithRetry("batch poolKey()", () => batch.poolKey());
  if (onchainKey[0].toLowerCase() !== currency0 || onchainKey[1].toLowerCase() !== currency1) throw new Error("batch pool currency mismatch");

  // Build the wallet manifest: addresses pinned plus the code hashes the
  // wallet compares before it enables any swap control.
  const hashOf = async (address) => ethers.keccak256(await provider.getCode(address));
  // Token/wrapper positions are the batch's positions (currency0/currency1),
  // not a presentation preference. This is required because the custom token
  // address is not predictably above/below WETH.
  const tokenA = currency0;
  const tokenB = currency1;
  const manifest = {
    chainId: SEPOLIA.chainId,
    batch: state.batch.address,
    tokenA,
    tokenB,
    wrapperA,
    wrapperB,
    oracle: state.oracle.address,
    router: SEPOLIA.universalRouter,
    permit2: SEPOLIA.permit2,
    pool: { currency0, currency1, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: ethers.ZeroAddress },
    codeHashes: {
      batch: await hashOf(state.batch.address),
      tokenA: await hashOf(SEPOLIA.weth),
      tokenB: await hashOf(state.token.address),
      wrapperA: await hashOf(wrapperA),
      wrapperB: await hashOf(wrapperB),
      oracle: await hashOf(state.oracle.address),
      router: await hashOf(SEPOLIA.universalRouter),
      permit2: await hashOf(SEPOLIA.permit2),
    },
  };
  const record = {
    ...manifest,
    poolManager: SEPOLIA.poolManager,
    liquidityHelper: SEPOLIA.poolModifyLiquidityTest,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    poolId: state.poolId,
    txs: { token: state.token.tx, wrapperWeth: state.wrapperWeth.tx, wrapperPrawl: state.wrapperPrawl.tx, oracle: state.oracle.tx, batch: state.batch.tx },
    parameters: { minRoundSeconds: MIN_ROUND_SECONDS, minUsers: MIN_USERS, refundDelay: REFUND_DELAY, maxPriceAge: MAX_PRICE_AGE, tokenSupply: SUPPLY.toString() },
  };
  writeFileSync(resolve(outDir, "sepolia.json"), JSON.stringify(record, null, 2));
  writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  log("wrote deployments/sepolia.json and deployments/manifest.json");
  log("build the wallet with:");
  log(`  VITE_PRAWL_SWAP_DEPLOYMENT='${JSON.stringify(manifest)}' pnpm --filter @prawl/wallet build`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
