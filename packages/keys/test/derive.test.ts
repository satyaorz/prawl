import { describe, expect, it } from "vitest";
import { privateKeyToAddress } from "viem/accounts";
import { deriveWalletKeys, open, seal } from "../src";

const rootA = new Uint8Array(32).fill(7);
const rootB = new Uint8Array(32).fill(8);

describe("deriveWalletKeys", () => {
  it("is deterministic for the same root", async () => {
    const a = await deriveWalletKeys(rootA);
    const b = await deriveWalletKeys(rootA);
    expect(a.railgunSpending).toBe(b.railgunSpending);
    expect(a.railgunViewing).toBe(b.railgunViewing);
    expect(a.evmAccount).toBe(b.evmAccount);
  });

  it("gives different, independent keys per purpose and per root", async () => {
    const a = await deriveWalletKeys(rootA);
    const b = await deriveWalletKeys(rootB);
    const all = [a.railgunSpending, a.railgunViewing, a.evmAccount, b.railgunSpending, b.railgunViewing, b.evmAccount];
    expect(new Set(all).size).toBe(all.length);
    for (const k of all) expect(k).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("derives a usable secp256k1 account key", async () => {
    const { evmAccount } = await deriveWalletKeys(rootA);
    expect(privateKeyToAddress(evmAccount)).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("pins the derivation (changing labels or salt would lose users' funds)", async () => {
    const a = await deriveWalletKeys(rootA);
    expect(a.railgunSpending).toMatchSnapshot();
    expect(a.railgunViewing).toMatchSnapshot();
    expect(a.evmAccount).toMatchSnapshot();
  });

  it("rejects a root that is not 32 bytes", async () => {
    await expect(deriveWalletKeys(new Uint8Array(31))).rejects.toThrow(/32 bytes/);
  });

  it("makes a non-extractable storage key", async () => {
    const { storage } = await deriveWalletKeys(rootA);
    expect(storage.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", storage)).rejects.toThrow();
  });
});

describe("vault", () => {
  it("round-trips and uses a fresh IV each time", async () => {
    const { storage } = await deriveWalletKeys(rootA);
    const s1 = await seal(storage, "checkpoint", "secret state");
    const s2 = await seal(storage, "checkpoint", "secret state");
    expect(s1.iv).not.toBe(s2.iv);
    expect(s1.ct).not.toContain("secret");
    expect(await open(storage, "checkpoint", s1)).toBe("secret state");
  });

  it("refuses a blob under another record name or another wallet's key", async () => {
    const { storage } = await deriveWalletKeys(rootA);
    const other = (await deriveWalletKeys(rootB)).storage;
    const sealed = await seal(storage, "checkpoint", "x");
    await expect(open(storage, "contacts", sealed)).rejects.toThrow();
    await expect(open(other, "checkpoint", sealed)).rejects.toThrow();
  });

  it("detects tampering", async () => {
    const { storage } = await deriveWalletKeys(rootA);
    const sealed = await seal(storage, "checkpoint", "hello");
    const ct = atob(sealed.ct);
    const flipped = btoa(String.fromCharCode(ct.charCodeAt(0) ^ 1) + ct.slice(1));
    await expect(open(storage, "checkpoint", { ...sealed, ct: flipped })).rejects.toThrow();
  });
});
