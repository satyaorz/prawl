#!/usr/bin/env node
// Build or refresh the public RAILGUN pool snapshot for a chain:
//   .local/railgun/web/snapshot-<chainId>.json (+ .gz)
// Syncs a throwaway wallet (random keys, never printed or saved), resuming from
// the previous snapshot when there is one, then strips every wallet-specific
// field and checks the result before writing. Public chain data only.
// Usage: node packages/railgun/scripts/build-snapshot.mjs [chainId] [rpcUrl]
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { isPublicSnapshot, seedFreshAccount, snapshotBlock, stripCheckpoint } from "../src/snapshot.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const { Chain, PoiSession, RailgunAddress } = require(path.join(root, ".local/railgun/nodejs/kohaku_railgun_wasm.js"));

const chainId = BigInt(process.argv[2] ?? "11155111");
const rpc = process.argv[3] ?? (chainId === 1n ? "https://ethereum-rpc.publicnode.com" : "https://ethereum-sepolia-rpc.publicnode.com");
const out = path.join(root, `.local/railgun/web/snapshot-${chainId}.json`);

// reqwest (wasm) rejects a Response with an empty url; Node's fetch sets it, keep it that way.
const t0 = Date.now();
const s = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const previous = existsSync(out) ? readFileSync(out, "utf8") : undefined;
if (previous && !isPublicSnapshot(previous)) throw new Error("existing snapshot is not public; refusing to resume from it");

const chain = Chain.fromChainId(chainId);
if (!chain) throw new Error(`no RAILGUN deployment on chain ${chainId}`);
const hex = () => `0x${randomBytes(32).toString("hex")}`;
const session = await PoiSession.open(chain, rpc, hex(), hex(), previous ?? null);
console.log(`[${s()}] opened at block ${session.syncedBlock}${previous ? " (resumed)" : ""}`);
await session.syncWithoutPoiSubmission();
console.log(`[${s()}] synced to ${session.syncedBlock}`);

const snapshot = stripCheckpoint(session.checkpointJson());
writeFileSync(`${out}.unchecked`, snapshot); // kept for inspection if the checks below fail
if (!isPublicSnapshot(snapshot)) throw new Error("stripped snapshot still has wallet data");
// Must open cleanly for a different fresh wallet, synced to the snapshot block.
const [sk, vk] = [hex(), hex()];
const addr = RailgunAddress.fromPrivateKeys(sk, vk, chainId);
const check = await PoiSession.open(chain, rpc, sk, vk, seedFreshAccount(snapshot, addr.toString()));
if (check.address !== addr.toString()) throw new Error(`address mismatch: ${check.address.slice(0, 12)} vs ${addr.toString().slice(0, 12)}`);
if (check.syncedBlock !== session.syncedBlock) throw new Error(`snapshot did not round-trip: ${check.syncedBlock} vs ${session.syncedBlock}`);
addr.free();
check.free();
session.free();
chain.free();

writeFileSync(`${out}.tmp`, snapshot);
renameSync(`${out}.tmp`, out);
writeFileSync(`${out}.gz`, gzipSync(snapshot, { level: 9 }));
rmSync(`${out}.unchecked`, { force: true });
console.log(`[${s()}] wrote ${out}: block ${snapshotBlock(snapshot)}, ${(snapshot.length / 1e6).toFixed(2)} MB (${(readFileSync(`${out}.gz`).length / 1e6).toFixed(2)} MB gzip)`);
