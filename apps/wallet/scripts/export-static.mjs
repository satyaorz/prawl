#!/usr/bin/env node
// Turn a `vite build --outDir <dir>` into a self-contained static site (for
// Vercel or any static host): copy in the files the dev server serves from the
// local-only .local/ folder, and write vercel.json with their headers.
//
//   anon-rpc/worker-0x<keccak>.js   tor-js worker build (vendor/torjs-worker/build.sh)
//   tor/bootstrap.zip.zst           Tor directory snapshot (gateway/start.sh); goes stale in ~3 days
//   railgun/kohaku_railgun_wasm*    RAILGUN wasm (packages/railgun/scripts/build-wasm.sh)
//   railgun/snapshot-<chain>.json   public pool snapshot (packages/railgun/scripts/build-snapshot.mjs)
//   .well-known/assetlinks.json     only if apps/wallet/public/.well-known has one (Android App Links / TWA)
//
// Usage: node scripts/export-static.mjs <outDir>
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const root = path.resolve(app, "../..");
const local = path.join(root, ".local");
const out = path.resolve(app, process.argv[2] ?? "dist-web");
if (!existsSync(path.join(out, "index.html"))) throw new Error(`${out} has no index.html: run vite build --outDir first`);

const copy = (from, to) => {
  if (!existsSync(from)) throw new Error(`missing ${path.relative(root, from)}`);
  mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
  copyFileSync(from, path.join(out, to));
  console.log(`${to.padEnd(52)} ${(statSync(from).size / 1e6).toFixed(2)} MB`);
};

// Worker bundles: the file name ends in -0x<keccak>.js; the app asks for /anon-rpc/worker-0x<keccak>.js.
const workers = readdirSync(path.join(local, "worker")).filter((f) => /-0x[0-9a-f]{64}\.js$/.test(f));
if (workers.length === 0) throw new Error("no worker build in .local/worker");
for (const f of workers) copy(path.join(local, "worker", f), `anon-rpc/worker-${f.match(/0x[0-9a-f]{64}/)[0]}.js`);
copy(path.join(local, "tor", "bootstrap.zip.zst"), "tor/bootstrap.zip.zst");
for (const f of ["kohaku_railgun_wasm.js", "kohaku_railgun_wasm_bg.wasm"]) copy(path.join(local, "railgun", "web", f), `railgun/${f}`);
for (const f of readdirSync(path.join(local, "railgun", "web")).filter((f) => /^snapshot-\d+\.json$/.test(f))) {
  copy(path.join(local, "railgun", "web", f), `railgun/${f}`);
}

const security = [
  { key: "referrer-policy", value: "no-referrer" },
  { key: "x-content-type-options", value: "nosniff" },
  { key: "x-frame-options", value: "DENY" },
  { key: "permissions-policy", value: "camera=(self), microphone=(), geolocation=(), interest-cohort=()" },
];
const vercel = {
  $schema: "https://openapi.vercel.sh/vercel.json",
  cleanUrls: false,
  trailingSlash: false,
  headers: [
    { source: "/(.*)", headers: security },
    {
      source: "/anon-rpc/(.*)",
      headers: [
        { key: "content-type", value: "text/javascript; charset=utf-8" },
        // The name carries the keccak of the content, and the harness re-checks it.
        { key: "cache-control", value: "public, max-age=31536000, immutable" },
      ],
    },
    {
      source: "/tor/(.*)",
      headers: [
        { key: "content-type", value: "application/zstd" },
        { key: "cache-control", value: "no-cache" },
      ],
    },
    { source: "/railgun/(.*)", headers: [{ key: "cache-control", value: "no-cache" }] },
    { source: "/railgun/(.*)\\.wasm", headers: [{ key: "content-type", value: "application/wasm" }] },
    { source: "/railgun/(.*)\\.json", headers: [{ key: "content-type", value: "application/json" }] },
    { source: "/.well-known/assetlinks.json", headers: [{ key: "content-type", value: "application/json" }] },
    { source: "/assets/(.*)", headers: [{ key: "cache-control", value: "public, max-age=31536000, immutable" }] },
  ],
};
writeFileSync(path.join(out, "vercel.json"), JSON.stringify(vercel, null, 2) + "\n");
console.log(`wrote ${path.relative(root, path.join(out, "vercel.json"))}`);
