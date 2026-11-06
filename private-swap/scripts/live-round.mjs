/**
 * Live round against the real Zama gateway on Sepolia.
 *
 * Everything here talks to the deployed contracts and the real relayer/KMS:
 * no mock coprocessor. It funds two confidential balances, submits two
 * encrypted orders in opposite directions, closes the round and decrypts the
 * public net through the gateway.
 *
 * Usage: node scripts/live-round.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { createRequire } from "node:module";
import { Keeper } from "./keeper.mjs";

const require = createRequire(import.meta.url);
const sdk = require("@zama-fhe/relayer-sdk/node");

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
if (!RPC || !KEY) throw new Error("Need SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY in .env");

const deploymentDir = process.env.PRAWL_DEPLOYMENTS_DIR ?? "deployments";
if (!/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(deploymentDir)) throw new Error("Invalid PRAWL_DEPLOYMENTS_DIR");
const manifest = JSON.parse(readFileSync(resolve(root, deploymentDir, "manifest.json"), "utf8"));
const provider = new ethers.JsonRpcProvider(RPC, manifest.chainId, { staticNetwork: true });
const wallet = new ethers.Wallet(KEY, provider);
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// A second, unprivileged signer for the other side of the trade.
const COUNTERPARTY_KEY = process.env.COUNTERPARTY_PRIVATE_KEY;
if (!COUNTERPARTY_KEY) throw new Error("Need COUNTERPARTY_PRIVATE_KEY in .env");
const counterparty = new ethers.Wallet(COUNTERPARTY_KEY, provider);

const BATCH_ABI = [
  "function currentRound() view returns (uint256)",
  "function closeRound()",
  "function submitOrder(bytes32, bytes, bytes32, bytes, bytes32, bytes)",
  "function prepareSettle(uint256, bytes, bytes)",
  "function executeSettle(uint256, uint64, bytes)",
  "function creditOrder(uint256, address)",
  "function refundOrder(uint256, address)",
  "function fundedBalance(address, uint8) view returns (bytes32)",
  "function orderStatus(uint256, address) view returns (bool submitted, bool credited, bool refunded)",
  "function rounds(uint256) view returns (bytes32 aToB, bytes32 bToA, bytes32 netEnc, bytes32 surplusEnc, bool closed, bool prepared, bool executed, uint64 netSwapped, uint8 surplusSide, uint256 minSwapOutput, bytes32 unwrapHandle, uint64 swapOutput)",
  "function minRoundDuration() view returns (uint256)",
  "function lastUpdateTime() view returns (uint256)",
  "function priceOracle() view returns (address)",
  "event RoundClosed(uint256 indexed roundId)",
  "event RoundSettled(uint256 indexed roundId, uint8 surplusSide, uint64 netSwapped, uint64 swapOutput)",
];
const WRAPPER_ABI = [
  "function rate() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function wrap(address, uint256) returns (uint256)",
  "function confidentialTransferAndCall(address, bytes32, bytes, bytes) returns (bytes32)",
  "function confidentialBalanceOf(address) view returns (bytes32)",
];
const ORACLE_ABI = ["function latestLotPrice() view returns (uint64, uint64, uint256)"];
const DIR_A_TO_B = 1;
const DIR_B_TO_A = 2;

async function main() {
  const batch = new ethers.Contract(manifest.batch, BATCH_ABI, wallet);
  const wA = new ethers.Contract(manifest.wrapperA, WRAPPER_ABI, wallet);
  const wB = new ethers.Contract(manifest.wrapperB, WRAPPER_ABI, wallet);
  const oracle = new ethers.Contract(manifest.oracle, ORACLE_ABI, provider);

  log("wallet", wallet.address, "counterparty", counterparty.address);
  log("batch", manifest.batch);
  const round = await batch.currentRound();
  log("current round", round.toString());

  // 1. Real gateway instance: this is the part the mock network never tested.
  log("creating FHE instance against the real relayer…");
  const instance = await sdk.createInstance({ ...sdk.SepoliaConfig, network: RPC });
  log("FHE instance ready; gateway chain", sdk.SepoliaConfig.gatewayChainId);

  // 2. Confidential units per lot, from the live pool quote.
  const [lotA, lotB] = await oracle.latestLotPrice();
  log("lot price: 1 lot =", lotA.toString(), "cA =", lotB.toString(), "cB");

  return { batch, wA, wB, oracle, instance, round, lotA, lotB };
}

const startBlock = (await provider.getBlockNumber()) - 5;
const ctx = await main();

/** Encrypt 3 values in one client-side input for `user`, bound to `contract`. */
async function encryptFor(instance, contract, user, amount, direction, minOutput) {
  const input = instance.createEncryptedInput(contract, user.address);
  input.add64(amount);
  input.add8(direction);
  input.add64(minOutput);
  return input.encrypt();
}

/**
 * A public Sepolia RPC is load-balanced: a node can answer from a block that
 * does not include the transaction we just mined, so a call that depends on it
 * (a wrap right after its approve) fails gas estimation with a bare revert.
 * Retry such steps a few times before giving up.
 */
async function retry(label, fn, attempts = 6) {
  for (let i = 0; ; ++i) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts - 1) throw e;
      log(`${label}: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 90)}; retrying (${i + 1}/${attempts - 1})`);
      await new Promise((r) => setTimeout(r, 6000));
    }
  }
}

/** Move `underlying` PRAWL/WETH into the confidential wrapper, then fund the batch. Skips a user who is already funded. */
async function fundConfidential(batch, wrapper, underlyingToken, user, units, asset) {
  if ((await batch.fundedBalance(user.address, asset)) !== ethers.ZeroHash) {
    log(`${user.address} already has a funded vault balance; skipping funding`);
    return;
  }
  const rate = await wrapper.rate();
  const underlying = units * rate;

  const bal = await underlyingToken.balanceOf(user.address);
  if (bal < underlying) throw new Error(`insufficient underlying for ${user.address}: have ${bal}, need ${underlying}`);
  const allowance = await underlyingToken.allowance(user.address, wrapper.target);
  if (allowance < underlying) {
    await (await underlyingToken.connect(user).approve(wrapper.target, underlying)).wait();
  }
  await retry("wrap", async () => (await wrapper.connect(user).wrap(user.address, underlying)).wait());

  const enc = await (await ctx.instance.createEncryptedInput(wrapper.target, user.address).add64(units).encrypt());
  await retry("fund vault", async () => (await wrapper.connect(user)["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
    batch.target, enc.handles[0], enc.inputProof, "0x00",
  )).wait());
}

async function submitOrder(batch, user, amount, direction, minOutput = 0n) {
  const enc = await encryptFor(ctx.instance, batch.target, user, amount, direction, minOutput);
  const tx = await batch.connect(user).submitOrder(
    enc.handles[0], enc.inputProof, enc.handles[1], enc.inputProof, enc.handles[2], enc.inputProof,
  );
  const receipt = await tx.wait();
  log(`order submitted by ${user.address} gas=${receipt.gasUsed}`);
  return receipt;
}

async function main2() {
  const { batch, wA, wB, lotA, lotB } = ctx;
  const erc20Abi = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"];
  const tokenA = new ethers.Contract(manifest.tokenA, erc20Abi, wallet);
  const tokenB = new ethers.Contract(manifest.tokenB, erc20Abi, wallet);

  // A resume is deliberately narrow: it may submit only missing orders. It
  // never repeats a wrapper deposit or confidential vault funding operation.
  // This makes an interrupted real-gateway run safe to continue.
  const resumeOnly = process.env.LIVE_RESUME === "1";
  if (resumeOnly) {
    log("resume mode: preserving existing confidential funding");
    const [deployerOrder, counterpartyOrder] = await Promise.all([
      batch.orderStatus(ctx.round, wallet.address),
      batch.orderStatus(ctx.round, counterparty.address),
    ]);
    if (!deployerOrder.submitted) await submitOrder(batch, wallet, lotA * 2n, DIR_A_TO_B);
    else log("deployer order already submitted; skipping");
    if (!counterpartyOrder.submitted) await submitOrder(batch, counterparty, lotB, DIR_B_TO_A);
    else log("counterparty order already submitted; skipping");
    log("all encrypted orders submitted or already present");
    return { round: ctx.round };
  }

  // The second orderer needs gas and the B-side underlying asset. Both are
  // funded by the test deployer; no third-party credentials are involved.
  if ((await provider.getBalance(counterparty.address)) < ethers.parseEther("0.002")) {
    await (await wallet.sendTransaction({ to: counterparty.address, value: ethers.parseEther("0.003") })).wait();
    log("funded counterparty gas");
  }

  // Two lots of A from the deployer, one lot of B from the counterparty.
  // Residual = one lot, which must hit the real pool.
  const unitsA = lotA * 2n;
  const unitsB = lotB * 1n;
  log("funding deployer cA", unitsA.toString(), "and counterparty cB", unitsB.toString());

  const rateA = await wA.rate();
  const rateB = await wB.rate();
  const requiredB = unitsB * rateB;
  if ((await tokenB.balanceOf(counterparty.address)) < requiredB && (await batch.fundedBalance(counterparty.address, 1)) === ethers.ZeroHash) {
    if ((await tokenB.balanceOf(wallet.address)) < requiredB) throw new Error("deployer lacks tokenB for the counterparty order");
    await (await tokenB.transfer(counterparty.address, requiredB)).wait();
    log("funded counterparty tokenB");
  }
  if ((await tokenA.balanceOf(wallet.address)) < unitsA * rateA) throw new Error("deployer lacks tokenA for A-side order");
  await fundConfidential(batch, wA, tokenA, wallet, unitsA, 0);
  log("deployer funded cA");
  await fundConfidential(batch, wB, tokenB, counterparty, unitsB, 1);
  log("counterparty funded cB");

  for (const [user, units, dir] of [[wallet, unitsA, DIR_A_TO_B], [counterparty, unitsB, DIR_B_TO_A]]) {
    if ((await batch.orderStatus(ctx.round, user.address)).submitted) log(`${user.address} already ordered; skipping`);
    else await retry("submit order", () => submitOrder(batch, user, units, dir));
  }
  log("both encrypted orders submitted");

  return { round: ctx.round };
}

const submitted = await main2();

async function waitForRound() {
  const duration = Number(await ctx.batch.minRoundDuration());
  const until = Number(await ctx.batch.lastUpdateTime()) + duration;
  while (Math.floor(Date.now() / 1000) < until) {
    const seconds = until - Math.floor(Date.now() / 1000);
    log(`waiting ${seconds}s for batch close`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(seconds, 5) * 1000));
  }
}

async function decryptBalance(user, handle) {
  if (handle === ethers.ZeroHash) return 0n;
  const keypair = ctx.instance.generateKeypair();
  const contracts = [manifest.batch, manifest.wrapperA, manifest.wrapperB];
  const start = Math.floor(Date.now() / 1000);
  const request = ctx.instance.createEIP712(keypair.publicKey, contracts, start, 1);
  const signature = await user.signTypedData(request.domain, { UserDecryptRequestVerification: request.types.UserDecryptRequestVerification }, request.message);
  const values = await ctx.instance.userDecrypt([{ handle, contractAddress: manifest.batch }], keypair.privateKey, keypair.publicKey, signature, contracts, user.address, start, 1);
  return BigInt(values[handle] ?? values[handle.toLowerCase()]);
}

async function settle() {
  const { batch, instance } = ctx;
  // The keeper drives close, prepare, settle and credit with permissionless
  // calls only; this script is just one of many parties that could run it.
  const keeper = new Keeper({ provider, signer: wallet, manifest, instance, fromBlock: startBlock, log });
  const deadline = Date.now() + 20 * 60_000;
  await waitForRound();
  for (;;) {
    await keeper.pass();
    const [d, c] = await Promise.all([batch.orderStatus(submitted.round, wallet.address), batch.orderStatus(submitted.round, counterparty.address)]);
    if (d.credited && c.credited) break;
    if (Date.now() > deadline) throw new Error("round did not settle within 20 minutes");
    await new Promise((r) => setTimeout(r, 8000));
  }
  const [aA, aB, bA, bB] = await Promise.all([
    batch.fundedBalance(wallet.address, 0), batch.fundedBalance(wallet.address, 1),
    batch.fundedBalance(counterparty.address, 0), batch.fundedBalance(counterparty.address, 1),
  ]);
  log(`deployer vault: A=${await decryptBalance(wallet, aA)} B=${await decryptBalance(wallet, aB)}`);
  log(`counterparty vault: A=${await decryptBalance(counterparty, bA)} B=${await decryptBalance(counterparty, bB)}`);

  // Optional: exit the counterparty's received tokens, to prove the unwrap path end to end.
  if (process.env.LIVE_EXIT === "1") {
    const received = await decryptBalance(counterparty, bA);
    if (received > 0n) {
      const token = new ethers.Contract(manifest.tokenA, ["function balanceOf(address) view returns (uint256)"], provider);
      const before = await token.balanceOf(counterparty.address);
      const enc = await instance.createEncryptedInput(manifest.batch, counterparty.address).add64(received).encrypt();
      await waitTx(await batch.connect(counterparty).exit(0, enc.handles[0], enc.inputProof), "exit counterparty A balance");
      for (let i = 0; i < 40; ++i) {
        await keeper.pass();
        const after = await token.balanceOf(counterparty.address);
        if (after > before) { log(`exit finalized: counterparty received ${after - before} (wei of tokenA)`); break; }
        await new Promise((r) => setTimeout(r, 8000));
      }
    }
  }
}

async function waitTx(tx, label) {
  log(`${label}: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${label} reverted`);
  log(`${label}: block ${receipt.blockNumber} gas=${receipt.gasUsed}`);
  return receipt;
}

await settle();
log("live round completed end to end");
