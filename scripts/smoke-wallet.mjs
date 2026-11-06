#!/usr/bin/env node
// Live wallet smoke test: a virtual passkey with PRF creates a wallet, RAILGUN
// opens and syncs Sepolia over Tor, and the private balance shows. Prints
// timings, the RAILGUN sync progress and a per-host request summary.
// Usage: CHROME=/path/to/chromium node scripts/smoke-wallet.mjs [url] [maxMinutes]
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
  page.on("pageerror", (e) => console.log(`[${s()}] pageerror`, e.message));
  page.on("console", (m) => ["error", "warning"].includes(m.type()) && console.log(`[${s()}] console.${m.type()}`, m.text().slice(0, 300)));
  await page.goto(url);
  await page.getByText(/Connected over Tor|Tor failed/).waitFor({ timeout: 120_000 });
  console.log(`[${s()}] tor ready`);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await page.getByText("Private balance").waitFor({ timeout: 120_000 });
  console.log(`[${s()}] wallet open`);
  let last = "";
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const card = (await page.locator("section").first().innerText()).replace(/\n/g, " | ");
    const progress = card.match(/Scanning[^|]*/)?.[0] ?? "";
    if (progress !== last) {
      console.log(`[${s()}] ${progress || card.slice(0, 200)}`);
      last = progress;
    }
    if (/synced in|No private funds|red-400/.test(card) || (await page.locator("section").first().locator("p.text-red-400").count())) break;
    await page.waitForTimeout(2000);
  }
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
