#!/usr/bin/env node
// Live end-to-end test of the private swap through the real wallet UI, over Tor,
// on Sepolia, against the real Zama gateway and a real Uniswap v4 pool.
//
//   1. creates a wallet (virtual passkey), writes its public account to <dir>/address.txt
//   2. waits for <dir>/go.txt (create it after funding that account with ~0.03 ETH, see below)
//   3. shields ETH into the private balance and waits for the PPOI check
//   4. Swap > "Fund new swap account": the private balance funds a FRESH account (no link to the main one)
//   5. connects (FHE worker over Tor, key download), "Swap privately" (wrap, fund, encrypted order);
//      the WALLET advances the round by itself (close, publish the net, trade it on Uniswap, credit)
//   6. withdraws the payout from the vault, then shields the leftover back into the private balance
//
// Fund the account:  (cd private-swap && node scripts/fund-wallet.mjs <address> 0.03 0 0)
// Opposite side:     the harness writes <dir>/ordered.txt once its order is placed; then run
//                    (cd private-swap && node scripts/counterparty-order.mjs 1)
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
const SWAP_AMOUNT = process.env.SWAP_AMOUNT ?? "0.0002"; // 6-dp wrapper units: 2 lots of WETH at the default deployment
const SHIELD_ETH = process.env.SHIELD_ETH ?? "0.02";
const FUND_SWAP_ACCOUNT = process.env.FUND_SWAP_ACCOUNT ?? "0.003";

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
/** Visible errors fail a step at once: never spin on a message the wallet already printed. */
const alertText = async () => (await dialog.getByRole("alert").allInnerTexts().catch(() => [])).join(" ").trim();

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

/** Click an action, then wait for its status line to say it finished; a visible alert is a failure. */
async function act(name, doneRe, timeoutMs = 10 * MIN, clickName = name) {
  await click(clickName);
  const text = await until(name, async () => {
    const t = await dlgText();
    const alert = await alertText();
    if (alert && !doneRe.test(t)) return { done: true, value: `ERROR ${alert}`, note: alert };
    return { done: doneRe.test(t), value: t, note: t.slice(-160) };
  }, timeoutMs, 4000);
  if (text.startsWith("ERROR")) throw new Error(`${name}: ${text}`);
  log(`${name}: done`);
}

const spendable = async () => Number((await page.locator("body").innerText()).match(/([\d.]+) spendable/)?.[1] ?? 0);
const closeSheet = async () => { await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" }).catch(() => {}); };

async function unlock() {
  await page.getByText(/Connected over Tor|Tor failed/).waitFor({ timeout: 180_000 });
  await page.getByRole("button", { name: "Unlock with passkey" }).click();
  await page.getByRole("button", { name: "Swap", exact: true }).waitFor({ timeout: 10 * MIN });
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
  log(`FUND IT (~0.03 ETH), then create ${path.join(dir, "go.txt")}`);
  await until("go.txt", async () => ({ done: existsSync(path.join(dir, "go.txt")), note: "waiting for funding" }), 3 * 60 * MIN, 3000);

  // Shield into the private balance, wait for the PPOI check: the real way money gets in.
  await page.getByRole("button", { name: "Shield", exact: true }).first().click();
  await dialog.waitFor();
  await dialog.getByPlaceholder("0.01").fill(SHIELD_ETH);
  await act("Shield ETH", /Shielded\./, 15 * MIN);
  await closeSheet();
  await until("PPOI (spendable private balance)", async () => {
    const v = await spendable();
    return { done: v > 0, note: `${v} spendable` };
  }, 60 * MIN, 30_000);

  await page.getByRole("button", { name: "Swap", exact: true }).click();
  await dialog.waitFor();
  await dialog.getByLabel("ETH to move to a new swap account").fill(FUND_SWAP_ACCOUNT);
  await act("Fund new swap account", /Swap account funded/, 25 * MIN);

  log("opening the swap dashboard (FHE worker, key download over Tor)…");
  await click("Open swap dashboard");
  await until("connect", async () => {
    const t = await dlgText();
    const alert = await alertText();
    if (alert) return { done: true, value: `ERROR ${alert}`, note: alert };
    return { done: /Public \/ wrapped \/ swap vault/.test(t), value: t, note: "connecting (key download over Tor can take minutes)" };
  }, 20 * MIN, 5000).then((v) => { if (typeof v === "string" && v.startsWith("ERROR")) throw new Error(`connect: ${v}`); });
  log(`dashboard open: ${(await dlgText()).slice(0, 400)}`);

  await dialog.getByPlaceholder("0.0").fill(SWAP_AMOUNT);
  await act("Swap privately", /Encrypted order submitted/, 20 * MIN);
  writeFileSync(path.join(dir, "ordered.txt"), new Date().toISOString() + "\n");
  log("order placed. Now run the counterparty: (cd private-swap && node scripts/counterparty-order.mjs 1)");

  // The wallet advances the round by itself now. Watch until the payout is credited.
  const settled = await until("round", async () => {
    const t = await dlgText();
    const alert = await alertText();
    if (/payout is in your confidential balance/.test(t)) return { done: true, value: t, note: "settled" };
    if (alert && /reverted|did not|stale|expired/i.test(alert)) return { done: true, value: `ERROR ${alert}`, note: alert };
    return { done: false, note: (t.match(/Round \d+[^|]*\|[^|]*\|[^|]*/)?.[0] ?? t.slice(0, 160)) };
  }, 45 * MIN, 10_000);
  if (String(settled).startsWith("ERROR")) throw new Error(`round: ${settled}`);
  log(`round settled: ${String(settled).slice(0, 500)}`);

  // Withdraw the payout (the output asset) from the vault to the swap account's public balance.
  await act("Withdraw payout", /Withdrawal requested/, 10 * MIN, /^Withdraw .* Custom token to the swap account$/);
  await until("exit released", async () => {
    const t = await dlgText();
    return { done: /Exit released/.test(t), note: t.slice(-120) };
  }, 25 * MIN, 8000);

  // Shield the leftover (WETH and gas ETH) back into the private balance.
  await act("Shield back", /Moved back into your private balance/, 20 * MIN, "Shield back to my private balance");
  log("SWAP LIVE TEST DONE");
} catch (e) {
  log("SWAP LIVE TEST FAILED:", e.message);
  process.exitCode = 1;
  const controlFile = path.join(dir, "control.txt");
  log(`holding the browser open; write status | reload | exit to ${controlFile}`);
  const end = Date.now() + 3 * 60 * MIN;
  while (Date.now() < end) {
    if (existsSync(controlFile)) {
      const cmd = readFileSync(controlFile, "utf8").trim();
      rmSync(controlFile, { force: true });
      log(`control: ${cmd}`);
      if (cmd === "exit") break;
      try {
        if (cmd === "status") log(`sheet: ${(await dlgText()).slice(0, 1500)} | body: ${(await page.locator("body").innerText()).replace(/\n+/g, " | ").slice(0, 600)}`);
        if (cmd === "reload") { await page.reload(); await unlock(); log("reloaded and unlocked"); }
      } catch (err) { log(`control ${cmd} failed: ${err.message}`); }
    }
    await sleep(5000);
  }
} finally {
  await browser.close();
}
