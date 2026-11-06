#!/usr/bin/env node
// Live funded end-to-end test on Sepolia, all over Tor, driven through the UI:
//   wallet A is created, waits for public ETH, shields it, waits for PPOI,
//   sends part privately to wallet B, waits for B's notes to become spendable
//   (needs A's PPOI proof submission), then withdraws A's rest to a return address.
// Both wallets use virtual passkeys that live only in this browser session: if the
// process dies, what is still shielded is stuck. Use small testnet amounts.
//
// Usage: CHROME=... node scripts/live-funded.mjs <url> <workdir>
//   <workdir>/address-a.txt   written: A's public account (fund it)
//   <workdir>/return.txt      read when needed: 0x address for the final withdrawal
//   <workdir>/control.txt     optional command, consumed when read:
//       status    log every wallet's balances, PPOI states and queued proofs
//       reload    reload every wallet page (picks up a new build) and unlock it again
//       withdraw  withdraw everything spendable to the return address
//       exit      close the browser (the in-memory passkeys are then gone)
// On failure the browser stays open and keeps obeying control.txt for 12 h,
// so a bug found mid-run can be fixed without losing the shielded funds.
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const url = process.argv[2] ?? "http://localhost:4173/";
const dir = process.argv[3] ?? ".";
mkdirSync(dir, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)} +${((Date.now() - t0) / 60000).toFixed(1)}m]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000;

const wallets = [];
const controlFile = path.join(dir, "control.txt");
async function control() {
  if (!existsSync(controlFile)) return undefined;
  const cmd = readFileSync(controlFile, "utf8").trim();
  rmSync(controlFile, { force: true });
  log(`control: ${cmd}`);
  if (cmd === "status") for (const w of wallets) log(`${w.name}: ${await balanceLines(w)}`);
  if (cmd === "reload") for (const w of wallets) await reload(w);
  if (cmd === "withdraw") await withdrawAll(await returnAddress());
  return cmd;
}

async function until(what, fn, timeoutMs, everyMs = 15_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    if ((await control()) === "exit") throw new Error("exit requested");
    const v = await fn();
    if (v.done) return v.value;
    if (v.note !== last) log(`${what}: ${v.note}`);
    last = v.note;
    await sleep(everyMs);
  }
  throw new Error(`timed out: ${what}`);
}

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});

async function wallet(name) {
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(url).origin });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  page.on("pageerror", (e) => log(`${name} pageerror`, e.message));
  page.on("dialog", (d) => void d.accept());
  await page.goto(url);
  await page.getByText(/Connected over Tor|Tor failed/).waitFor({ timeout: 180_000 });
  await page.getByRole("button", { name: "Create wallet" }).click();
  const card = page.locator("section").first();
  await until(`${name} open`, async () => ({ done: /synced in/.test(await card.innerText()), note: "syncing" }), 15 * MIN, 3000);
  const copy = async (i) => {
    await card.getByRole("button", { name: "copy" }).nth(i).click();
    return page.evaluate(() => navigator.clipboard.readText());
  };
  const w = { name, page, card, zk: await copy(0), evm: await copy(1) };
  log(`${name}: ${w.zk.slice(0, 18)}… public ${w.evm}`);
  wallets.push(w);
  return w;
}

/** Reload the page (new build) and unlock with the same virtual passkey; the sealed checkpoint survives. */
async function reload(w) {
  await w.page.reload();
  await w.page.getByText(/Connected over Tor|Tor failed/).waitFor({ timeout: 180_000 });
  await w.page.getByRole("button", { name: "Unlock with passkey" }).click();
  const end = Date.now() + 15 * MIN;
  while (Date.now() < end && !/synced in/.test(await w.card.innerText())) await sleep(3000);
  log(`${w.name} reloaded: ${await balanceLines(w)}`);
}

async function returnAddress() {
  const f = path.join(dir, "return.txt");
  const end = Date.now() + 120 * MIN;
  while (Date.now() < end) {
    const a = existsSync(f) ? readFileSync(f, "utf8").trim() : "";
    if (/^0x[0-9a-fA-F]{40}$/.test(a)) return a;
    await sleep(30_000);
  }
  throw new Error("no return address");
}

/** Withdraw what fits: spendable minus a gas reserve (paid from the private balance) and the 0.25% fee; retry smaller if refused. */
async function withdrawAll(ret) {
  for (const w of wallets) {
    const avail = await spendable(w);
    let amt = Math.floor(((avail - 0.0045) / 1.0025) * 1e6) / 1e6;
    for (let attempt = 0; attempt < 3 && amt > 0; attempt++) {
      const s = w.page.locator("section", { hasText: "Send privately" });
      log(`${w.name} withdraws ${amt} ETH to ${ret}`);
      await s.getByRole("button", { name: "Withdraw to public" }).click();
      await s.locator("input").nth(0).fill(ret);
      await s.locator("input").nth(1).fill(String(amt));
      await s.getByRole("button", { name: "Withdraw", exact: true }).click();
      const end = Date.now() + 30 * MIN;
      let t = "";
      while (Date.now() < end) {
        t = await actionText(w, "Withdraw to public");
        if (/Done\.|reverted|failed|Try at most|is spendable/.test(t)) break;
        await sleep(5000);
      }
      log(`${w.name} withdraw result: ${t}`);
      const fits = t.match(/Try at most ([\d.]+) ETH/)?.[1];
      if (!fits) break;
      amt = Math.floor(Number(fits) * 0.95 * 1e6) / 1e6;
    }
  }
}

const num = (s) => (s ? Number(s) : 0);
const publicEth = async (w) => num((await w.page.locator("section", { hasText: "Add funds privately" }).innerText()).match(/public: ([\d.]+) ETH/)?.[1]);
const spendable = async (w) => num((await w.page.locator("section", { hasText: "Send privately" }).innerText()).match(/spendable: ([\d.]+) ETH/)?.[1]);
const balanceLines = async (w) => (await w.card.innerText()).split("\n").filter((l) => /^ETH|^\d|spendable|PPOI|queued|Last attempt/.test(l)).join(" | ");
const actionText = async (w, section) => (await w.page.locator("section", { hasText: section }).innerText()).replace(/\n/g, " | ");

async function refresh(w) {
  const b = w.card.getByRole("button", { name: "Refresh" });
  if (await b.isEnabled()) await b.click();
}

try {
  const A = await wallet("A");
  writeFileSync(path.join(dir, "address-a.txt"), A.evm + "\n");
  log(`FUND ME: send Sepolia ETH to ${A.evm}`);

  const funded = await until("A public balance", async () => {
    await refresh(A);
    const v = await publicEth(A);
    return { done: v > 0, value: v, note: `${v} ETH` };
  }, 120 * MIN, 30_000);
  log(`A funded: ${funded} ETH public`);

  // Shield all but a gas reserve; the wallet says how much fits if the reserve is short.
  const shieldForm = A.page.locator("section", { hasText: "Add funds privately" });
  let amount = Math.floor((funded - 0.006) * 1e6) / 1e6;
  for (let attempt = 0; attempt < 3; attempt++) {
    log(`A shields ${amount} ETH`);
    await shieldForm.locator("input").fill(String(amount));
    await shieldForm.getByRole("button", { name: "Shield ETH" }).click();
    const out = await until("shield", async () => {
      const t = await actionText(A, "Add funds privately");
      const done = /Shielded\.|reverted|failed|Not enough/.test(t);
      return { done, value: t, note: t.split(" | ").slice(3, 5).join(" ") };
    }, 15 * MIN, 5000);
    log(`shield result: ${out}`);
    const fits = out.match(/Try at most ([\d.]+) ETH/)?.[1];
    if (fits) { amount = Math.floor(Number(fits) * 0.97 * 1e6) / 1e6; continue; }
    if (!/Shielded\./.test(out)) throw new Error("shield failed");
    break;
  }

  const valid = await until("A PPOI", async () => {
    const v = await spendable(A);
    return { done: v > 0, value: v, note: await balanceLines(A) };
  }, 360 * MIN, 60_000);
  log(`A spendable: ${valid} ETH`);

  const B = await wallet("B");
  const actions = A.page.locator("section", { hasText: "Send privately" });
  const sendAmt = Math.floor((valid / 2) * 1e6) / 1e6; // B must afford its own withdrawal gas
  log(`A sends ${sendAmt} ETH privately to B`);
  await actions.getByRole("button", { name: "Send privately" }).click();
  await actions.locator("input").nth(0).fill(B.zk);
  await actions.locator("input").nth(1).fill(String(sendAmt));
  await actions.getByRole("button", { name: "Send", exact: true }).click();
  const sent = await until("private send", async () => {
    const t = await actionText(A, "Send privately");
    return { done: /Done\.|reverted|failed/.test(t), value: t, note: t.split(" | ").slice(-2).join(" ") };
  }, 30 * MIN, 5000);
  log(`send result: ${sent}`);
  if (!/Done\./.test(sent)) throw new Error("private send failed");

  await until("B receives", async () => {
    await refresh(B);
    const lines = await balanceLines(B);
    return { done: /ETH/.test(lines), note: lines || "nothing yet" };
  }, 20 * MIN, 30_000);
  const bValid = await until("B PPOI (A submits proofs on its syncs)", async () => {
    const v = await spendable(B);
    return { done: v > 0, value: v, note: `B: ${await balanceLines(B)} || A: ${await balanceLines(A)}` };
  }, 120 * MIN, 60_000);
  log(`B spendable: ${bValid} ETH`);

  await withdrawAll(await returnAddress());
  log("LIVE TEST DONE");
} catch (e) {
  log("LIVE TEST FAILED:", e.message);
  process.exitCode = 1;
  if (e.message !== "exit requested") {
    log(`holding the browser open; write reload | withdraw | exit to ${controlFile}`);
    const end = Date.now() + 12 * 60 * MIN;
    while (Date.now() < end) {
      const cmd = await control().catch((err) => log("control failed:", err.message));
      if (cmd === "exit") break;
      await sleep(10_000);
    }
  }
} finally {
  await browser.close();
}
