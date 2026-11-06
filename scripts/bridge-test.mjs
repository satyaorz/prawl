#!/usr/bin/env node
// The phone-bridge panel in a real browser, against a FAKE window.prawlOffline injected into the page
// (the real one exists only inside the Android app). Checks that the panel appears, lists coins, that a
// cash-out payload opens in the Offline card like a scanned code, that a refusal on the phone reads as
// "declined", and that a mint is validated. Read-only: nothing is sent to the chain.
// Usage: CHROME=... node scripts/bridge-test.mjs [url]
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.argv[2] ?? "http://localhost:4173/";
const fx = (f) => JSON.parse(readFileSync(path.join(root, "apps/wallet/test/fixtures/offline", f), "utf8"));
const load = fx("load-deposited.json").payload;
const redeem = fx("redeem-already-paid.json").payload;
const results = [];
const check = (name, ok, detail = "") => (results.push(ok), console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`));

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const context = await browser.newContext({ viewport: { width: 420, height: 1000 } });
await context.addInitScript(({ load, redeem }) => {
  const calls = [];
  window.__bridgeCalls = calls;
  window.prawlOffline = {
    mint: async (r) => (calls.push(["mint", r]), load),
    coins: async () => [{ coinId: redeem.header.coinId, valueWei: redeem.header.value, expiry: redeem.header.expiry, state: "unspent", notes: [{ noteId: "n1", valueWei: "1000000000000000" }] }],
    cashOut: async (r) => {
      calls.push(["cashOut", r]);
      if (window.__decline) throw Object.assign(new Error("User declined"), { code: "USER_DECLINED" });
      return redeem;
    },
    refresh: async () => Promise.reject({ code: "DECLINED" }),
    shieldAsk: async () => ({ nonce: "0123456789abcdef0123456789abcdef" }),
    acceptShieldTarget: async () => ({ ok: true }),
    markDeposited: async () => ({}),
    markRefreshed: async () => ({}),
  };
}, { load, redeem });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
page.on("dialog", (d) => void d.accept());
try {
  await page.goto(url);
  await page.getByText(/Connected over Tor|Tor failed/).first().waitFor({ timeout: 180_000 });
  await page.getByRole("button", { name: "Create wallet" }).click();
  await page.getByText(/synced in/).waitFor({ timeout: 180_000 });
  await page.getByRole("tab", { name: "Offline" }).click();

  const panel = page.locator("section", { hasText: "This phone" });
  await panel.waitFor();
  check("the panel appears when window.prawlOffline exists", true);
  await panel.getByText("0.01 ETH · expires").waitFor();
  check("it lists the phone's coins with their notes", (await panel.innerText()).includes("0.001 ETH"));

  await panel.getByPlaceholder(/Payout address/).fill("0x03a62B04aBe69f382bd7582f492be735B1dDb47B");
  await panel.getByRole("button", { name: "To address" }).click();
  const card = page.locator("div.rounded-xl", { hasText: "Cash out" });
  await card.first().waitFor({ timeout: 30_000 });
  const calls1 = await page.evaluate(() => window.__bridgeCalls.filter((c) => c[0] === "cashOut"));
  check("cash-out is requested for the note and address, and its payload opens in the card", calls1[0]?.[1]?.noteId === "n1" && calls1[0]?.[1]?.to?.address?.startsWith("0x03a6") && /Pays[\s\S]*0\.001 ETH/.test(await card.first().innerText()));

  await page.evaluate(() => (window.__decline = true));
  await panel.getByRole("button", { name: "To address" }).click();
  await panel.getByText("Declined on the phone. Nothing was signed.").waitFor({ timeout: 15_000 });
  check("a refusal on the phone reads as declined", true);

  await panel.getByRole("button", { name: "Refresh", exact: true }).first().click().catch(() => {});
  await panel.getByPlaceholder("0.003").fill("0.005");
  await panel.getByRole("button", { name: "Mint", exact: true }).click();
  await page.locator("div.rounded-xl", { hasText: "Load a coin" }).first().waitFor({ timeout: 30_000 });
  const mint = await page.evaluate(() => window.__bridgeCalls.find((c) => c[0] === "mint"));
  check("mint asks the phone for this wallet's account and opens the load in the card", mint?.[1]?.mode === "public" && mint?.[1]?.valueWei === "5000000000000000" && /^0x[0-9a-fA-F]{40}$/.test(mint?.[1]?.depositor ?? ""));
} catch (e) {
  check("bridge panel run", false, String(e.message).split("\n")[0]);
} finally {
  await browser.close();
}
console.log(results.every(Boolean) ? "\nBRIDGE TEST PASSED" : "\nBRIDGE TEST FAILED");
process.exitCode = results.every(Boolean) ? 0 : 1;
