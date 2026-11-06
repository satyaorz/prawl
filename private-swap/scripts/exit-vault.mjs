/**
 * Exit part of an account's confidential vault balance to plain tokens, then
 * let the keeper finalize the async unwrap (anyone can; it needs only the
 * gateway's public proof). Proves the exit path end to end.
 *
 * Usage: node scripts/exit-vault.mjs <asset 0|1> <c-units> [counterparty|deployer]
 */
import { createKeeper } from "./keeper.mjs";
import { ethers } from "ethers";

const [asset, units, who = "counterparty"] = process.argv.slice(2);
if (!["0", "1"].includes(asset) || !units) throw new Error("Usage: exit-vault.mjs <asset 0|1> <c-units> [counterparty|deployer]");
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const keeper = await createKeeper(log);
const key = who === "deployer" ? process.env.DEPLOYER_PRIVATE_KEY : process.env.COUNTERPARTY_PRIVATE_KEY;
const user = new ethers.Wallet(key, keeper.provider);
const token = new ethers.Contract(asset === "0" ? keeper.manifest.tokenA : keeper.manifest.tokenB, ["function balanceOf(address) view returns (uint256)"], keeper.provider);
const batch = new ethers.Contract(keeper.manifest.batch, ["function exit(uint8, bytes32, bytes)"], user);
const before = await token.balanceOf(user.address);
const enc = await keeper.instance.createEncryptedInput(keeper.manifest.batch, user.address).add64(BigInt(units)).encrypt();
const sent = await batch.exit(Number(asset), enc.handles[0], enc.inputProof);
const receipt = await sent.wait();
log(`exit requested: ${receipt.hash}`);
keeper.cursor = receipt.blockNumber; // only this exit's events matter
for (let i = 0; i < 40; ++i) {
  await keeper.pass().catch((e) => log(`pass: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 100)}`));
  const after = await token.balanceOf(user.address);
  if (after > before) { log(`EXIT FINALIZED: ${user.address} received ${after - before} wei`); process.exit(0); }
  await new Promise((r) => setTimeout(r, 8000));
}
throw new Error("exit was not finalized in time");
