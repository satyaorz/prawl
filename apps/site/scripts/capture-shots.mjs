#!/usr/bin/env node
// Capture the real wallet screens into apps/site/public/shots/, for the site's
// overlapping screenshot stack.
//
//   pnpm --filter @prawl/wallet dev &          # http://localhost:5173
//   node apps/site/scripts/capture-shots.mjs
//
// The wallet is driven through devSetState() (dev builds only), so every pixel
// is the actual product UI: no mock-ups, no edited images.
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../public/shots");
const URL_ = process.env.WALLET_URL ?? "http://localhost:5173/";
const EXE =
  process.env.CHROME ??
  [`${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`].find((p) => existsSync(p));

mkdirSync(out, { recursive: true });

const EVM = "0x7A3f9C2b41D8eE05aB6c1F84d9E02b3A5c7D1e90";
const ZK = "0zk1qy8x4v2n7k5m3p9r6t1w8s4u0z2a5c7e9g1j3l5n7p9r1t3v5x7z9b1d3f5h7j9l0";
const now = Date.now();

/** Every field the Home, Activity and Offline screens read. */
const READY = {
  phase: "ready",
  hasPasskey: true,
  evmAddress: EVM,
  railgunAddress: ZK,
  syncedBlock: 8942113n,
  head: 8942113n,
  deploymentBlock: 5100000n,
  balances: [{ asset: "erc20:0x0000000000000000000000000000000000000000", amount: "2486000000000000000", poiStatus: "Valid" }],
  publicWei: 185000000000000000n,
  unshieldFeeBps: 25,
  lastSyncMs: 1240,
  poiQueue: 0,
  restored: false,
  fullScan: false,
  activity: [
    { at: now - 1000 * 60 * 3, kind: "send", amount: "120000000000000000", to: ZK, txHash: "0x8f2a1c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a", ok: true },
    { at: now - 1000 * 60 * 47, kind: "shield", amount: "500000000000000000", txHash: "0x1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d", ok: true },
    { at: now - 1000 * 60 * 60 * 6, kind: "offline-load", amount: "50000000000000000", txHash: "0x4e6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f60", ok: true },
    { at: now - 1000 * 60 * 60 * 26, kind: "unshield", amount: "250000000000000000", to: EVM, txHash: "0x9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c10", ok: true },
  ],
};

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({
  viewport: { width: 420, height: 780 },
  deviceScaleFactor: 3,
  colorScheme: "dark",
});
const page = await ctx.newPage();

/** Load the wallet and push a state into the store. */
async function shoot(name, patch, steps = []) {
  await page.goto(URL_, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  const ok = await page.evaluate((p) => {
    const fn = window.__prowlDevSetState;
    if (!fn) return false;
    fn(p);
    return true;
  }, patch);
  if (!ok) throw new Error("the wallet dev server is not running a dev build with __prowlDevSetState");
  await page.waitForTimeout(1000);
  for (const step of steps) await step();
  await page.waitForTimeout(700);
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
  console.log("wrote", path.relative(process.cwd(), file));
}

const click = (text) => async () => {
  await page.getByRole("tab", { name: new RegExp(text, "i") }).first().click();
};

// 1. The locked welcome screen: what the product says about itself.
await page.goto(URL_, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(out, "welcome.png") });
console.log("wrote public/shots/welcome.png");

// 2. Main balance.
await shoot("wallet", READY);

// 3. Activity list.
await shoot("activity", READY, [click("activity")]);

// 4. Offline cash tab.
await shoot("offline", READY, [
  async () => {
    const tab = page.getByRole("tab", { name: /offline/i }).first();
    if (await tab.count()) await tab.click();
  },
]);

// 5. The Shield sheet, over the balance.
await shoot("shield", READY, [
  async () => {
    await page.getByRole("button", { name: /^shield$/i }).first().click();
  },
]);

await browser.close();
