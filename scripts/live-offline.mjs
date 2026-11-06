#!/usr/bin/env node
// Live test of the website side of offline cash (HANDOFF v1), all over Tor:
// creates a wallet, writes its public account (the depositor) to <dir>/address.txt,
// waits for public ETH, then processes handoff links dropped into <dir>:
//   check-*.txt   open the link, log what the card shows (no transaction)
//   go-*.txt      open the link and press Load / Cash out, log the result
// A processed file is renamed to *.done. Write "exit" to <dir>/control.txt to stop.
// The virtual passkey lives only in this browser session.
// Usage: CHROME=... node scripts/live-offline.mjs <url> <dir>
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const url = process.argv[2] ?? "http://localhost:4173/";
const dir = process.argv[3] ?? ".";
mkdirSync(dir, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)} +${((Date.now() - t0) / 60000).toFixed(1)}m]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
try {
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(url).origin });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  page.on("dialog", (d) => void d.accept());
  page.on("pageerror", (e) => log("pageerror", e.message));
  await page.goto(url);
  await page.getByText(/Connected over Tor|Tor failed/).waitFor({ timeout: 180_000 });
  await page.getByRole("button", { name: "Create wallet" }).click();
  const card = page.locator("section").first();
  while (!/synced in/.test(await card.innerText())) await sleep(2000);
  await card.getByRole("button", { name: "copy" }).nth(1).click();
  const account = await page.evaluate(() => navigator.clipboard.readText());
  writeFileSync(path.join(dir, "address.txt"), account + "\n");
  log(`wallet open; depositor/public account ${account}`);

  const offline = page.locator("section", { hasText: "Offline cash" });
  const publicEth = async () =>
    Number((await page.locator("section", { hasText: "Add funds privately" }).innerText()).match(/public: ([\d.]+) ETH/)?.[1] ?? 0);

  let lastBalance = -1;
  for (;;) {
    const ctl = path.join(dir, "control.txt");
    if (existsSync(ctl)) {
      const cmd = readFileSync(ctl, "utf8").trim();
      rmSync(ctl, { force: true });
      if (cmd === "exit") break;
    }
    const bal = await publicEth();
    if (bal !== lastBalance) log(`public balance ${bal} ETH`);
    lastBalance = bal;

    const files = readdirSync(dir).filter((f) => /^(check|go)-.*\.txt$/.test(f)).sort();
    for (const f of files) {
      const link = readFileSync(path.join(dir, f), "utf8").trim();
      renameSync(path.join(dir, f), path.join(dir, `${f}.done`));
      const hash = link.slice(link.indexOf("#"));
      log(`${f}: opening ${hash.slice(0, 40)}…`);
      await page.evaluate((h) => (window.location.hash = h), hash);
      const panel = offline.locator("div.rounded-xl");
      await panel.or(offline.locator("p.text-red-400")).first().waitFor({ timeout: 30_000 });
      for (let i = 0; i < 60 && /checking over Tor/.test(await offline.innerText()); i++) await sleep(1000);
      log(`${f}: card: ${(await offline.innerText()).replace(/\n/g, " | ").slice(0, 700)}`);
      if (f.startsWith("go-")) {
        const button = panel.getByRole("button", { name: /^(Load .* ETH|Cash out)$/ });
        if (!(await button.isEnabled())) {
          log(`${f}: action button disabled`);
          continue;
        }
        await button.click();
        for (let i = 0; i < 180; i++) {
          const t = await offline.innerText();
          if (/Loaded\.|Paid |reverted|failed|Not sent|Not loaded/.test(t)) break;
          await sleep(2000);
        }
        await sleep(3000);
        log(`${f}: result: ${(await offline.innerText()).replace(/\n/g, " | ").slice(-700)}`);
      }
    }
    await sleep(5000);
  }
  log("LIVE OFFLINE TEST DONE");
} catch (e) {
  log("LIVE OFFLINE TEST FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
