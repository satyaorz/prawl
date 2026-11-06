#!/usr/bin/env node
// Live end-to-end test of the private swap through the real wallet UI, over Tor,
// on Sepolia, against the real Zama gateway and a real Uniswap v4 pool.
//
//   1. creates a wallet (virtual passkey), writes its public account to <dir>/address.txt
//   2. waits for <dir>/go.txt (create it after funding that account, see below)
//   3. opens Swap, connects (FHE worker over Tor, key download), wraps, funds the vault,
//      submits an encrypted order, then lets the WALLET advance the round by itself
//      (close, publish the net, trade it on Uniswap, credit), and finally exits a part.
//
// Fund the account:  (cd private-swap && node scripts/fund-wallet.mjs <address> 0.01 0.0005)
// Opposite side:     (cd private-swap && node scripts/counterparty-order.mjs 1)   # before or after the order
// Build with:        VITE_PRAWL_SWAP_DEPLOYMENT="$(cat private-swap/deployments/manifest.json)" pnpm --filter ./apps/wallet build
//
// The virtual passkey lives only in this browser session. If a step fails the
// browser stays open (up to 3 h) and obeys <dir>/control.txt: `status` logs the
// sheet's text, `exit` closes the browser (and loses the wallet).
// Usage: CHROME=... node scripts/live-swap.mjs <url> <dir>
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const url = process.argv[2] ?? "http://localhost:4174/";
const dir = process.argv[3] ?? ".";
mkdirSync(dir, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)} +${((Date.now() - t0) / 60000).toFixed(1)}m]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000;
const WRAP_AMOUNT = process.env.SWAP_AMOUNT ?? "0.0002"; // 6-dp wrapper units: 2 lots of WETH at the default deployment
const EXIT_AMOUNT = process.env.SWAP_EXIT ?? "0.01";

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(url).origin });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
});
page.on("dialog", (d) => void d.accept());
page.on("pageerror", (e) => log("pageerror", e.message));
const dialog = page.getByRole("dialog");
const dlgText = async () => (await dialog.innerText().catch(() => "")).replace(/\n+/g, " | ");

async function until(what, fn, timeoutMs, everyMs = 5000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    const v = await fn();
    if (v.done) return v.value;
    if (v.note !== last) log(`${what}: ${v.note}`);
    last = v.note;
    await sleep(everyMs);
  }
  throw new Error(`timed out: ${what}`);
}

async function click(name) {
  const b = dialog.getByRole("button", { name, exact: true });
  await b.waitFor({ timeout: 60_000 });
  await until(`button ${name} enabled`, async () => ({ done: await b.isEnabled(), note: "disabled" }), 5 * MIN, 1000);
  await b.click();
}

/** Click an action, then wait for its status line (or an error) to say it finished. */
async function act(name, doneRe, timeoutMs = 10 * MIN) {
  await click(name);
  const text = await until(name, async () => {
    const t = await dlgText();
    const err = t.match(/(?:Not enough|Enter a|reverted|failed|Invalid|refused|did not|stale|expired|must)[^|]*/i)?.[0];
    if (err && !doneRe.test(t)) return { done: true, value: `ERROR ${err}`, note: err };
    return { done: doneRe.test(t), value: t, note: t.slice(-160) };
  }, timeoutMs, 4000);
  if (text.startsWith("ERROR")) throw new Error(`${name}: ${text}`);
  log(`${name}: done`);
}

try {
  await page.goto(url);
  await page.getByText(/Connected over Tor|Tor failed/).waitFor({ timeout: 180_000 });
  await page.getByRole("button", { name: "Create wallet" }).click();
  await page.getByRole("button", { name: "Swap", exact: true }).waitFor({ timeout: 10 * MIN });
  await page.getByRole("button", { name: "Copy Public address" }).click();
  const account = await page.evaluate(() => navigator.clipboard.readText());
  writeFileSync(path.join(dir, "address.txt"), account + "\n");
  log(`wallet open; public account ${account}`);
  log(`FUND IT, then create ${path.join(dir, "go.txt")}`);
  await until("go.txt", async () => ({ done: existsSync(path.join(dir, "go.txt")), note: "waiting for funding" }), 3 * 60 * MIN, 3000);

  await page.getByRole("button", { name: "Swap", exact: true }).click();
  await dialog.waitFor();
  log("opening the swap dashboard (FHE worker, key download over Tor)…");
  await click("Open swap dashboard");
  await until("connect", async () => {
    const t = await dlgText();
    return { done: /Public \/ wrapped \/ swap vault/.test(t), note: (t.match(/(Checking|Connecting|[A-Z][^|]*(?:failed|different|Invalid|not available)[^|]*)/)?.[0] ?? "connecting") };
  }, 15 * MIN, 5000);
  log(`dashboard open: ${(await dlgText()).slice(0, 300)}`);

  await dialog.getByPlaceholder("0.0").fill(WRAP_AMOUNT);
  await act("Wrap public tokens", /Tokens wrapped/);
  await act("Fund swap vault", /sent to the swap vault/);
  await act("Submit private swap", /Encrypted order submitted/);
  writeFileSync(path.join(dir, "ordered.txt"), new Date().toISOString() + "\n");
  log(`order placed. If the counterparty has not ordered yet: (cd private-swap && node scripts/counterparty-order.mjs 1)`);

  // The wallet advances the round by itself now. Watch the dashboard until the payout is credited.
  const settled = await until("round", async () => {
    const t = await dlgText();
    return { done: /payout is in your confidential balance|Settled/.test(t) && /Round \d+/.test(t), value: t, note: (t.match(/Round \d+[^|]*\|[^|]*\|[^|]*/)?.[0] ?? t.slice(0, 160)) };
  }, 40 * MIN, 10_000);
  log(`round settled: ${settled.slice(0, 500)}`);

  // Exit part of the payout (the output asset, so flip the direction first).
  await dialog.getByRole("button", { name: "Reverse", exact: true }).click();
  await dialog.getByPlaceholder("0.0").fill(EXIT_AMOUNT);
  await act("Exit vault to public", /Exit requested|released/);
  await until("exit released", async () => {
    const t = await dlgText();
    return { done: /Exit released/.test(t), note: t.slice(-120) };
  }, 20 * MIN, 8000);
  log("SWAP LIVE TEST DONE");
} catch (e) {
  log("SWAP LIVE TEST FAILED:", e.message);
  process.exitCode = 1;
  const controlFile = path.join(dir, "control.txt");
  log(`holding the browser open; write status | exit to ${controlFile}`);
  const end = Date.now() + 3 * 60 * MIN;
  while (Date.now() < end) {
    if (existsSync(controlFile)) {
      const cmd = readFileSync(controlFile, "utf8").trim();
      rmSync(controlFile, { force: true });
      log(`control: ${cmd}`);
      if (cmd === "exit") break;
      if (cmd === "status") log(`sheet: ${(await dlgText()).slice(0, 1200)}`);
    }
    await sleep(5000);
  }
} finally {
  await browser.close();
}
