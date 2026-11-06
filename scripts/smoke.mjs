#!/usr/bin/env node
// Live smoke test: loads the wallet in headless Chromium, waits for Tor, reads
// a public address over Tor and prints timings plus the network log.
// Usage: node scripts/smoke.mjs [url] [address]
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:5173/";
const address = process.argv[3] ?? "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // a well-known public address
const t0 = Date.now();
const s = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";

// CHROME: path to a Chromium binary; defaults to Playwright's own download.
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`[${s()}] pageerror`, e.message));
  page.on("console", (m) => m.type() === "error" && console.log(`[${s()}] console.error`, m.text().slice(0, 300)));
  await page.goto(url);
  await page.getByText(/Connected over Tor|Tor failed/).waitFor({ timeout: 120_000 });
  console.log(`[${s()}]`, (await page.locator("section").first().innerText()).replace(/\n/g, " | "));
  await page.getByPlaceholder("0x…").fill(address);
  const t1 = Date.now();
  await page.getByRole("button", { name: "Check" }).click();
  await page.locator("li", { hasText: "ETH" }).or(page.locator("p.text-red-400")).first().waitFor({ timeout: 120_000 });
  await page.waitForFunction(() => !document.querySelector("button[disabled]"), null, { timeout: 120_000 });
  console.log(`[${s()}] read took ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log((await page.locator("section").nth(1).innerText()).replace(/\n/g, " | "));
  const log = page.locator("section", { hasText: "Network log" });
  if (await log.count()) console.log((await log.innerText()).split("\n").slice(2).join("\n"));
} finally {
  await browser.close();
}
