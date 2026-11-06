#!/usr/bin/env node
// QR hand-offs between "devices", checked end to end:
//  A. every QR the wallet SHOWS (receive, depositor, shield target) is rendered, read back
//     from the image with an independent decoder and compared with what it must contain;
//  B. QR codes a phone WOULD show (a load link, a cash-out link, a shield-ask) are fed to the
//     wallet's own scanner through a fake webcam (Chromium's fake video capture of a y4m made
//     from the QR image), and the wallet must open them.
// Usage: CHROME=... node scripts/qr-test.mjs [url]
import { chromium } from "playwright";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(path.join(root, "apps/wallet/package.json"));
const QRCode = req("qrcode");
const jsQR = req("jsqr");
const url = process.argv[2] ?? "http://localhost:4173/";
const exe = process.env.CHROME ? { executablePath: process.env.CHROME } : {};
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

/** Decode a QR from a PNG data URL (not the wallet's own code path). */
const decodeDataUrl = (dataUrl) => {
  const png = PNG.sync.read(Buffer.from(dataUrl.split(",")[1], "base64"));
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data;
};

async function newWallet(browser, extra = {}) {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 }, ...extra });
  await context.grantPermissions(["clipboard-read", "clipboard-write", "camera"], { origin: new URL(url).origin });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  page.on("dialog", (d) => void d.accept());
  await page.goto(url);
  await page.getByText(/Connected over Tor|Tor failed/).first().waitFor({ timeout: 180_000 });
  await page.getByRole("button", { name: "Create wallet" }).click();
  await page.getByText(/synced in/).waitFor({ timeout: 180_000 });
  return page;
}

const ONLY = process.env.ONLY; // "show", "scan" or "ask": run one part
// ---------------------------------------------------------------- A. QR codes the wallet shows
if (!ONLY || ONLY === "show") {
  const browser = await chromium.launch(exe);
  const page = await newWallet(browser);
  const card = page.locator("section").first();
  const copy = async (name) => {
    await card.getByRole("button", { name }).click();
    return page.evaluate(() => navigator.clipboard.readText());
  };
  const zk = await copy(/Copy Private address/);
  const evm = await copy(/Copy Public address/);

  await page.getByRole("button", { name: "Receive", exact: true }).click();
  const img = (alt) => page.getByRole("dialog").getByAltText(alt);
  await img("QR code of the private address").waitFor();
  check("receive (private 0zk) QR decodes to the address", decodeDataUrl(await img("QR code of the private address").getAttribute("src")) === zk);
  await page.getByRole("dialog").getByRole("button", { name: "Fund (public)" }).click();
  await img("QR code of the public address").waitFor();
  check("receive (public) QR decodes to the address", decodeDataUrl(await img("QR code of the public address").getAttribute("src")) === evm);
  await page.keyboard.press("Escape");

  await page.getByRole("tab", { name: "Offline" }).click();
  await page.getByRole("button", { name: "Before minting: show my depositor QR" }).click();
  await page.getByAltText("Depositor address QR").waitFor();
  const dep = decodeDataUrl(await page.getByAltText("Depositor address QR").getAttribute("src"));
  check("depositor QR is the EIP-681 link of the public account", dep?.toLowerCase() === `ethereum:${evm}@11155111`.toLowerCase(), dep ?? "");

  await page.getByRole("button", { name: /Cash out a phone coin/ }).click();
  await page.getByPlaceholder("note value, e.g. 0.003").fill("0.002");
  await page.getByRole("button", { name: "Show QR" }).click();
  await page.getByAltText("Shield target QR for the phone").waitFor({ timeout: 60_000 });
  const target = decodeDataUrl(await page.getByAltText("Shield target QR for the phone").getAttribute("src"));
  const body = target?.startsWith("prawl://offline/shield-target?d=") ? JSON.parse(Buffer.from(target.split("d=")[1], "base64url").toString()) : undefined;
  check("shield-target QR decodes to a v1 shield-target for exactly 0.002 WETH", body?.t === "shield-target" && body.request?.value === "2000000000000000" && body.request?.tokenSubID === "0" && body.request?.encryptedBundle?.length === 3, `${target?.length ?? 0} chars`);
  await browser.close();
}

// ---------------------------------------------------------------- B. QR codes a phone would show
const dir = mkdtempSync(path.join(tmpdir(), "prawl-qr-"));
const fx = (f) => JSON.parse(readFileSync(path.join(root, "apps/wallet/test/fixtures/offline", f), "utf8"));
const cases = [
  { name: "load link", text: `https://prawl.example/#/offline/load?d=${fx("load-deposited.json").d}`, expect: /Load a coin/ },
  { name: "cash-out link (2 offline payments, already paid)", text: `prawl://offline/redeem?d=${fx("redeem-already-paid.json").d}`, expect: /Cash out[\s\S]*paid 0\.01 ETH/ },
];

async function scan(c) {
  const qr = path.join(dir, "qr.png");
  const size = 700;
  await QRCode.toFile(qr, c.text, { errorCorrectionLevel: "L", margin: 4, width: size });
  const y4m = path.join(dir, "cam.y4m");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-loop", "1", "-i", qr, "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=white", "-t", "2", "-r", "10", "-pix_fmt", "yuv420p", y4m]);
  const browser = await chromium.launch({
    ...exe,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${y4m}`],
  });
  let page;
  try {
    page = await newWallet(browser);
    await page.getByRole("tab", { name: "Offline" }).click();
    await page.getByRole("button", { name: "Scan" }).click();
    const panel = page.locator("div.rounded-xl", { hasText: /Load a coin|Cash out/ });
    await panel.first().waitFor({ timeout: 60_000 });
    for (let i = 0; i < 30 && /checking over Tor/.test(await panel.first().innerText()); i++) await page.waitForTimeout(1000);
    const text = await panel.first().innerText();
    check(`scanner opens a ${c.name} (${c.text.length} chars)`, c.expect.test(text), text.replace(/\n/g, " | ").slice(0, 140));
  } catch (e) {
    check(`scanner opens a ${c.name}`, false, String(e.message).split("\n")[0] + " | page: " + (await page?.locator("body").innerText().then((t) => t.replace(/\n/g, " | ").slice(-500)).catch(() => "?")));
  } finally {
    await browser.close();
  }
}
if (!ONLY || ONLY === "scan") for (const c of cases) await scan(c);

// a shield-ask QR fills in the value and builds the target at once
if (!ONLY || ONLY === "ask") {
  const text = `prawl://offline/shield-ask?d=${Buffer.from(JSON.stringify({ v: 1, t: "shield-ask", chainId: 11155111, escrow: "0x236b1dC3b1a90E23728DA6E361b0Ab1C386cd779", value: "3000000000000000", nonce: "0123456789abcdef0123456789abcdef" })).toString("base64url")}`;
  const qr = path.join(dir, "ask.png");
  await QRCode.toFile(qr, text, { errorCorrectionLevel: "L", margin: 4, width: 700 });
  const y4m = path.join(dir, "ask.y4m");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-loop", "1", "-i", qr, "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=white", "-t", "2", "-r", "10", "-pix_fmt", "yuv420p", y4m]);
  const browser = await chromium.launch({ ...exe, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${y4m}`] });
  try {
    const page = await newWallet(browser);
    await page.getByRole("tab", { name: "Offline" }).click();
    await page.getByRole("button", { name: "Scan" }).click();
    await page.getByAltText("Shield target QR for the phone").waitFor({ timeout: 90_000 });
    const target = decodeDataUrl(await page.getByAltText("Shield target QR for the phone").getAttribute("src"));
    const body = JSON.parse(Buffer.from(target.split("d=")[1], "base64url").toString());
    check("scanned shield-ask builds a target for 0.003 with the nonce echoed", body.nonce === "0123456789abcdef0123456789abcdef" && body.request.value === "3000000000000000" && /v3\.1|236b1d/i.test(body.escrow) && (await page.getByText("Bound to the phone's request.").count()) === 1);
  } catch (e) {
    check("scanned shield-ask builds a target", false, String(e.message).split("\n")[0]);
  } finally {
    await browser.close();
  }
}

console.log(results.every(Boolean) ? "\nQR TEST PASSED" : "\nQR TEST FAILED");
process.exitCode = results.every(Boolean) ? 0 : 1;
