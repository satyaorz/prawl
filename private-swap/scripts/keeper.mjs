/**
 * Keeper for the Prawl confidential batch swap (VeilBatchSwap v5).
 *
 * Every step that moves a round forward is permissionless: closing a round,
 * preparing and executing its settlement, crediting payouts, expiring and
 * refunding a stuck round, and finalizing exits. The keeper holds no secret
 * and no state: each pass re-derives what is pending from the chain, so it is
 * safe to stop and restart at any time, and to run several of them at once.
 * It only needs gas, and it can never move anyone's funds anywhere else:
 * credits and refunds always land in the order's own encrypted balance.
 *
 * Usage:
 *   node scripts/keeper.mjs            # loop forever (every KEEPER_INTERVAL_S, default 12)
 *   node scripts/keeper.mjs --once     # one pass, then exit
 *
 * Environment (also read from .env.local / .env):
 *   SEPOLIA_RPC_URL                       required
 *   KEEPER_PRIVATE_KEY | DEPLOYER_PRIVATE_KEY   pays gas, required
 *   PRAWL_DEPLOYMENTS_DIR                 default "deployments" (reads manifest.json)
 *   KEEPER_FROM_BLOCK                     first block to scan for events (default: the deployment block, else latest - 20000)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ethers } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

export function loadEnv(path) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {}
}

export const BATCH_ABI = [
  "function currentRound() view returns (uint256)",
  "function lastUpdateTime() view returns (uint256)",
  "function distinctSubmitters() view returns (uint256)",
  "function minRoundDuration() view returns (uint256)",
  "function minDistinctSubmitters() view returns (uint256)",
  "function refundDelay() view returns (uint256)",
  "function closedAt(uint256) view returns (uint256)",
  "function refundable(uint256) view returns (bool)",
  "function roundPrices(uint256) view returns (uint64 lotA, uint64 lotB, uint64 maxLots, uint256 validUntil)",
  "function rounds(uint256) view returns (bytes32 aToB, bytes32 bToA, bytes32 netEnc, bytes32 surplusEnc, bool closed, bool prepared, bool executed, uint64 netSwapped, uint8 surplusSide, uint256 minSwapOutput, bytes32 unwrapHandle, uint64 swapOutput)",
  "function orderStatus(uint256, address) view returns (bool submitted, bool credited, bool refunded)",
  "function closeRound()",
  "function prepareSettle(uint256, bytes, bytes)",
  "function executeSettle(uint256, uint64, bytes)",
  "function creditOrder(uint256, address)",
  "function expireRound(uint256, uint64, bytes)",
  "function refundOrder(uint256, address)",
  "event OrderSubmitted(uint256 indexed round, address indexed user)",
];
export const WRAPPER_ABI = [
  "function unwrapRequester(bytes32) view returns (address)",
  "function finalizeUnwrap(bytes32, uint64, bytes)",
  "event UnwrapRequested(address indexed receiver, bytes32 amount)",
];

/** The value the gateway decrypted for `handle`, as a bigint. */
export function clearValue(dec, handle) {
  const key = ethers.hexlify(handle).toLowerCase();
  const value = dec.clearValues?.[handle] ?? dec.clearValues?.[key];
  if (value === undefined) throw new Error(`decryption did not return ${key}`);
  return BigInt(value);
}

/** A fresh handle can take a few seconds to reach the gateway: retry the public decryption. */
export async function publicDecryptRetry(instance, handles, log, attempts = 10, delayMs = 4000) {
  let last;
  for (let i = 0; i < attempts; ++i) {
    try {
      return await instance.publicDecrypt(handles);
    } catch (e) {
      last = e;
      log?.(`  gateway not ready (${i + 1}/${attempts}): ${String(e?.message ?? e).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}

export class Keeper {
  constructor({ provider, signer, manifest, instance, fromBlock, log = console.log }) {
    this.provider = provider;
    this.signer = signer;
    this.manifest = manifest;
    this.instance = instance;
    this.log = log;
    this.batch = new ethers.Contract(manifest.batch, BATCH_ABI, signer);
    this.wrappers = [new ethers.Contract(manifest.wrapperA, WRAPPER_ABI, signer), new ethers.Contract(manifest.wrapperB, WRAPPER_ABI, signer)];
    this.cursor = fromBlock; // next block to scan for events
    this.orderers = new Map(); // round -> Set(address)
    this.exitHandles = new Map(); // handle -> wrapper index
  }

  /** Pull new OrderSubmitted and UnwrapRequested events since the last pass, in bounded chunks. */
  async scan() {
    const head = await this.provider.getBlockNumber();
    const CHUNK = 2000;
    while (this.cursor <= head) {
      const to = Math.min(head, this.cursor + CHUNK - 1);
      const orders = await this.batch.queryFilter(this.batch.filters.OrderSubmitted(), this.cursor, to);
      for (const e of orders) {
        const r = e.args[0].toString();
        if (!this.orderers.has(r)) this.orderers.set(r, new Set());
        this.orderers.get(r).add(ethers.getAddress(e.args[1]));
      }
      for (const [i, w] of this.wrappers.entries()) {
        for (const e of await w.queryFilter(w.filters.UnwrapRequested(), this.cursor, to)) {
          this.exitHandles.set(ethers.hexlify(e.args[1]), i);
        }
      }
      this.cursor = to + 1;
    }
  }

  async tx(label, fn) {
    try {
      const sent = await fn();
      const receipt = await sent.wait();
      this.log(`${label}: ${receipt.hash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
      return true;
    } catch (e) {
      this.log(`${label}: not done: ${String(e?.shortMessage ?? e?.reason ?? e?.message ?? e).slice(0, 220)}`);
      return false;
    }
  }

  async now() {
    return (await this.provider.getBlock("latest")).timestamp;
  }

  /** One pass over every round that can still need work, then pending exits. */
  async pass() {
    await this.scan();
    const current = Number(await this.batch.currentRound());
    const rounds = [...new Set([...this.orderers.keys(), String(current)])].map(Number).sort((a, b) => a - b);
    for (const r of rounds) await this.advance(r, current);
    await this.finalizeExits();
  }

  async advance(r, current) {
    const state = await this.batch.rounds(r);
    const price = await this.batch.roundPrices(r);
    const now = await this.now();
    const people = [...(this.orderers.get(String(r)) ?? [])];
    const refundable = await this.batch.refundable(r);

    // Open round: close it when it is old enough and has enough distinct orderers.
    if (!state.closed) {
      if (r !== current || people.length === 0) return;
      const last = Number(await this.batch.lastUpdateTime());
      const minDuration = Number(await this.batch.minRoundDuration());
      const min = Number(await this.batch.minDistinctSubmitters());
      const submitters = Number(await this.batch.distinctSubmitters());
      const validUntil = Number(price.validUntil);
      if (now > validUntil || now >= last + Number(await this.batch.refundDelay())) {
        this.log(`round ${r}: open past its deadline, expiring`);
        await this.tx(`expire round ${r}`, () => this.batch.expireRound(r, 0n, "0x"));
      } else if (submitters >= min && now >= last + minDuration) {
        await this.tx(`close round ${r}`, () => this.batch.closeRound());
      }
      return;
    }

    if (refundable) return this.refunds(r, people);

    const deadlinePassed = now > Number(price.validUntil) || now >= Number((await this.batch.closedAt(r))) + Number(await this.batch.refundDelay());
    if (state.executed) return this.credits(r, people);

    if (!state.prepared && !deadlinePassed) {
      const dec = await publicDecryptRetry(this.instance, [state.netEnc, state.surplusEnc], this.log);
      this.log(`round ${r}: net ${clearValue(dec, state.netEnc)} lots, surplus side ${clearValue(dec, state.surplusEnc)}`);
      await this.tx(`prepare round ${r}`, () => this.batch.prepareSettle(r, dec.abiEncodedClearValues, dec.decryptionProof));
      return;
    }
    if (state.prepared && !deadlinePassed) {
      if (state.netSwapped > 0n) {
        const dec = await publicDecryptRetry(this.instance, [state.unwrapHandle], this.log);
        await this.tx(`settle round ${r} on Uniswap`, () => this.batch.executeSettle(r, clearValue(dec, state.unwrapHandle), dec.decryptionProof));
      } else {
        await this.tx(`settle round ${r} (fully matched)`, () => this.batch.executeSettle(r, 0n, "0x"));
      }
      return;
    }
    if (deadlinePassed) {
      // Not settled in time (price moved, stale, gateway stalled): refund everyone.
      this.log(`round ${r}: not settled by its deadline, expiring`);
      if (state.prepared && state.netSwapped > 0n) {
        const dec = await publicDecryptRetry(this.instance, [state.unwrapHandle], this.log);
        await this.tx(`expire round ${r}`, () => this.batch.expireRound(r, clearValue(dec, state.unwrapHandle), dec.decryptionProof));
      } else {
        await this.tx(`expire round ${r}`, () => this.batch.expireRound(r, 0n, "0x"));
      }
    }
  }

  async credits(r, people) {
    for (const user of people) {
      const s = await this.batch.orderStatus(r, user);
      if (s.submitted && !s.credited) await this.tx(`credit ${user} (round ${r})`, () => this.batch.creditOrder(r, user));
    }
  }

  async refunds(r, people) {
    for (const user of people) {
      const s = await this.batch.orderStatus(r, user);
      if (s.submitted && !s.refunded) await this.tx(`refund ${user} (round ${r})`, () => this.batch.refundOrder(r, user));
    }
  }

  /** Exits are async unwraps anyone can finalize with the public decryption proof. */
  async finalizeExits() {
    for (const [handle, i] of this.exitHandles) {
      const w = this.wrappers[i];
      let requester;
      try {
        requester = await w.unwrapRequester(handle);
      } catch {
        continue;
      }
      if (requester === ethers.ZeroAddress) {
        this.exitHandles.delete(handle); // already finalized
        continue;
      }
      try {
        const dec = await publicDecryptRetry(this.instance, [handle], this.log, 3);
        await this.tx(`finalize exit to ${requester}`, () => w.finalizeUnwrap(handle, clearValue(dec, handle), dec.decryptionProof));
      } catch (e) {
        this.log(`exit ${handle.slice(0, 12)}…: gateway not ready yet`);
      }
    }
  }
}

export async function createKeeper(log = console.log) {
  loadEnv(resolve(root, ".env.local"));
  loadEnv(resolve(root, ".env"));
  const RPC = process.env.SEPOLIA_RPC_URL;
  const KEY = process.env.KEEPER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
  if (!RPC || !KEY) throw new Error("Need SEPOLIA_RPC_URL and KEEPER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY)");
  const dir = process.env.PRAWL_DEPLOYMENTS_DIR ?? "deployments";
  if (!/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(dir)) throw new Error("Invalid PRAWL_DEPLOYMENTS_DIR");
  const manifest = JSON.parse(readFileSync(resolve(root, dir, "manifest.json"), "utf8"));
  const provider = new ethers.JsonRpcProvider(RPC, manifest.chainId, { staticNetwork: true });
  const signer = new ethers.Wallet(KEY, provider);
  const sdk = createRequire(import.meta.url)("@zama-fhe/relayer-sdk/node");
  const instance = await sdk.createInstance({ ...sdk.SepoliaConfig, network: RPC });
  let fromBlock = Number(process.env.KEEPER_FROM_BLOCK ?? 0);
  if (!fromBlock) {
    const statePath = resolve(root, dir, "state.json");
    fromBlock = existsSync(statePath) ? Number(JSON.parse(readFileSync(statePath, "utf8")).batch?.block ?? 0) : 0;
    if (!fromBlock) fromBlock = Math.max(0, (await provider.getBlockNumber()) - 20000);
  }
  log(`keeper ${signer.address} for batch ${manifest.batch}, scanning from block ${fromBlock}`);
  return new Keeper({ provider, signer, manifest, instance, fromBlock, log });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
  const keeper = await createKeeper(log);
  const once = process.argv.includes("--once");
  const every = Number(process.env.KEEPER_INTERVAL_S ?? 12) * 1000;
  do {
    try {
      await keeper.pass();
    } catch (e) {
      log("pass failed:", String(e?.shortMessage ?? e?.message ?? e).slice(0, 240));
    }
    if (!once) await new Promise((r) => setTimeout(r, every));
  } while (!once);
}
