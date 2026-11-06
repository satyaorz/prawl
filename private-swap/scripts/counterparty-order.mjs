/**
 * The scripted counterparty for a demo round: wraps and funds one lot of the
 * A-side token (PRAWL) and submits an encrypted A->B order in the current
 * round, so a wallet selling the B side (WETH) has someone to net against.
 * Honest labelling: this is a scripted second participant, not a second user.
 *
 * Usage: node scripts/counterparty-order.mjs [lots=1]
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ethers } from "ethers";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const f of [".env.local", ".env"]) {
  try {
    for (const line of readFileSync(resolve(root, f), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {}
}
const lots = BigInt(process.argv[2] ?? "1");
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const manifest = JSON.parse(readFileSync(resolve(root, process.env.PRAWL_DEPLOYMENTS_DIR ?? "deployments", "manifest.json"), "utf8"));
const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL, manifest.chainId, { staticNetwork: true });
const me = new ethers.Wallet(process.env.COUNTERPARTY_PRIVATE_KEY, provider);
const sdk = createRequire(import.meta.url)("@zama-fhe/relayer-sdk/node");

const batch = new ethers.Contract(manifest.batch, [
  "function currentRound() view returns (uint256)",
  "function fundedBalance(address, uint8) view returns (bytes32)",
  "function orderStatus(uint256, address) view returns (bool, bool, bool)",
  "function submitOrder(bytes32, bytes, bytes32, bytes, bytes32, bytes)",
  "function roundPrices(uint256) view returns (uint64 lotA, uint64 lotB, uint64 maxLots, uint256 validUntil)",
], me);
const wrapper = new ethers.Contract(manifest.wrapperA, [
  "function rate() view returns (uint256)",
  "function wrap(address, uint256) returns (uint256)",
  "function confidentialTransferAndCall(address, bytes32, bytes, bytes) returns (bytes32)",
], me);
const token = new ethers.Contract(manifest.tokenA, [
  "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)",
], me);
const oracle = new ethers.Contract(manifest.oracle, ["function latestLotPrice() view returns (uint64,uint64,uint256)"], provider);

async function retry(label, fn, n = 6) {
  for (let i = 0; ; ++i) {
    try { return await fn(); } catch (e) {
      if (i >= n - 1) throw e;
      log(`${label}: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 90)}; retrying`);
      await new Promise((r) => setTimeout(r, 6000));
    }
  }
}

const round = await batch.currentRound();
if ((await batch.orderStatus(round, me.address))[0]) { log(`already ordered in round ${round}`); process.exit(0); }
const [lotA] = await oracle.latestLotPrice();
const units = lotA * lots;
const instance = await sdk.createInstance({ ...sdk.SepoliaConfig, network: process.env.SEPOLIA_RPC_URL });

// Fund only if this account has no vault balance of A yet (a funded balance is enough for a few lots).
if ((await batch.fundedBalance(me.address, 0)) === ethers.ZeroHash) {
  const underlying = units * (await wrapper.rate());
  if ((await token.balanceOf(me.address)) < underlying) throw new Error(`counterparty needs ${underlying} PRAWL wei; it holds ${await token.balanceOf(me.address)}`);
  if ((await token.allowance(me.address, wrapper.target)) < underlying) await (await token.approve(wrapper.target, underlying)).wait();
  await retry("wrap", async () => (await wrapper.wrap(me.address, underlying)).wait());
  const enc = await instance.createEncryptedInput(wrapper.target, me.address).add64(units).encrypt();
  await retry("fund vault", async () => (await wrapper.confidentialTransferAndCall(batch.target, enc.handles[0], enc.inputProof, "0x00")).wait());
  log(`funded ${units} c-units of A`);
}
const enc = await instance.createEncryptedInput(batch.target, me.address).add64(units).add8(1).add64(0n).encrypt();
await retry("submit order", async () => (await batch.submitOrder(enc.handles[0], enc.inputProof, enc.handles[1], enc.inputProof, enc.handles[2], enc.inputProof)).wait());
log(`counterparty ordered ${lots} lot(s) A->B in round ${round}`);
