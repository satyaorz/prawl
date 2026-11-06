#!/usr/bin/env node
// Live wallet smoke test: a virtual passkey with PRF creates a wallet, RAILGUN
// opens and syncs Sepolia over Tor, and the private balance shows. Prints
// timings, the RAILGUN sync progress and a per-host request summary.
// With RESTORE=1 it then wipes the page's storage (as on a new device), signs in
// with the same passkey and times the restore.
// With RESCAN=1 it finally presses Full rescan and times a scan of all history.
// Usage: CHROME=/path/to/chromium [RESTORE=1] [RESCAN=1] node scripts/smoke-wallet.mjs [url] [maxMinutes]
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:5173/";
const maxMs = Number(process.argv[3] ?? 20) * 60_000;
const t0 = Date.now();
const s = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  page.on("dialog", (d) => void d.accept()); // passkey-free prompts: gateway confirmation, rescan
  page.on("pageerror", (e) => console.log(`[${s()}] pageerror`, e.message));
  page.on("console", (m) => ["error", "warning"].includes(m.type()) && console.log(`[${s()}] console.${m.type()}`, m.text().slice(0, 300)));
  await page.goto(url);
  await page.getByText(/Connected over Tor|Tor failed/).waitFor({ timeout: 120_000 });
  console.log(`[${s()}] tor ready`);
  const card = () => page.locator("section").first();
  async function openAndSync(button, what) {
    const t = Date.now();
    await page.getByRole("button", { name: button }).click();
    if (button === "Full rescan") await page.getByText("Scanning").first().waitFor({ timeout: 60_000 });
    await page.getByText("Private balance").or(card().locator("p.text-red-400")).first().waitFor({ timeout: 120_000 });
    const openErr = card().locator("p.text-red-400");
    if (await openErr.count()) throw new Error(`wallet failed to open: ${await openErr.first().innerText()}`);
    console.log(`[${s()}] ${what}: wallet open`);
    let last = "";
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const text = (await card().innerText()).replace(/\n/g, " | ");
      const progress = text.match(/Scanning[^|]*/)?.[0] ?? "";
      if (progress !== last) {
        console.log(`[${s()}] ${progress || text.slice(0, 200)}`);
        last = progress;
      }
      if (/synced in|No private funds/.test(text) || (await card().locator("p.text-red-400").count())) break;
      await page.waitForTimeout(2000);
    }
    console.log(`[${s()}] ${what}: usable after ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }
  await openAndSync("Create wallet", "create");
  const address = (await card().innerText()).match(/0zk1\S+/)?.[0];
  if (process.env.RESTORE) {
    await page.getByRole("button", { name: "Lock" }).click();
    await page.evaluate(() => new Promise((res, rej) => {
      const r = indexedDB.deleteDatabase("prawl");
      r.onsuccess = () => res(undefined);
      r.onerror = () => rej(r.error);
      r.onblocked = () => res(undefined);
    }));
    await page.reload();
    await page.getByText(/Connected over Tor|Tor failed/).waitFor({ timeout: 120_000 });
    console.log(`[${s()}] storage wiped, tor ready again`);
    await openAndSync("Restore with passkey", "restore");
    const again = (await card().innerText()).match(/0zk1\S+/)?.[0];
    console.log(`[${s()}] same address after restore: ${!!address && address === again}`);
  }
  if (process.env.RESCAN) await openAndSync("Full rescan", "full rescan");
  console.log(`[${s()}] final:`, (await page.locator("section").first().innerText()).replace(/\n/g, " | "));
  const rows = await page.locator("section", { hasText: "Network log" }).locator("li").allInnerTexts();
  const by = {};
  for (const r of rows) {
    const [ok, method, identity, circuit, ms] = r.split("\n");
    const k = `${(circuit ?? "").replace(/#\d+$/, "")} ${identity}`;
    by[k] ??= { n: 0, fail: 0, ms: 0, methods: new Set() };
    by[k].n++;
    if (ok !== "✓") by[k].fail++;
    by[k].ms += parseInt(ms ?? "0", 10);
    by[k].methods.add(method);
  }
  for (const [k, v] of Object.entries(by)) console.log(`  ${k}: ${v.n} (${v.fail} failed), ${(v.ms / 1000).toFixed(1)} s, ${[...v.methods].join(",")}`);
} finally {
  await browser.close();
}
