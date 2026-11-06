import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import loadFixture from "./fixtures/offline/load-deposited.json";
import redeemFixture from "./fixtures/offline/redeem-already-paid.json";
import { BridgeDeclined, BridgeError, ask, cashOutToAddress, cashOutToShield, getBridge, mintOnPhone, payloadLink, refreshOnPhone, tellPhone, type PrawlOfflineBridge } from "../src/offline/bridge";
import { ESCROW_V31, parsePayload, payloadFromText, shieldRequestWire, type ShieldRequest } from "../src/offline/payload";

const NONCE = "0123456789abcdef0123456789abcdef";
const request: ShieldRequest = {
  npk: `0x${"7e".repeat(32)}`, tokenType: 0, tokenAddress: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", tokenSubID: 0n, value: 2_000_000_000_000_000n,
  encryptedBundle: [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`, `0x${"03".repeat(32)}`], shieldKey: `0x${"04".repeat(32)}`,
};
const redeemBase = redeemFixture.payload as unknown as Record<string, unknown> & { redemption: Record<string, unknown> };
const redeemShield = (shield: unknown) => ({ ...redeemBase, t: "redeem-shield", escrow: ESCROW_V31, redemption: { ...redeemBase.redemption, payout: "0x0000000000000000000000000000000000000000" }, shield });
const refreshPayload = { ...redeemBase, t: "refresh", escrow: ESCROW_V31, refresh: { newCoinId: `0x52465348${"ab".repeat(28)}`, newExpiry: 1_796_000_000, newK0x: `0x${"11".repeat(32)}`, newK0y: `0x${"22".repeat(32)}` } };

function fake(over: Partial<Record<keyof PrawlOfflineBridge, unknown>> = {}): PrawlOfflineBridge {
  return {
    mint: vi.fn(async () => loadFixture.payload),
    coins: vi.fn(async () => []),
    cashOut: vi.fn(async () => redeemFixture.payload),
    refresh: vi.fn(async () => refreshPayload),
    shieldAsk: vi.fn(async () => ({ nonce: NONCE })),
    acceptShieldTarget: vi.fn(async () => ({ ok: true })),
    markDeposited: vi.fn(async () => ({})),
    markRefreshed: vi.fn(async () => ({})),
    ...over,
  } as unknown as PrawlOfflineBridge;
}

describe("phone bridge adapter", () => {
  it("is found only when the whole API is there", () => {
    expect(getBridge({})).toBeUndefined();
    expect(getBridge({ prawlOffline: { mint() {} } })).toBeUndefined();
    expect(getBridge({ prawlOffline: fake() })).toBeDefined();
  });

  it("turns a refusal on the phone into BridgeDeclined and anything else into BridgeError", async () => {
    await expect(ask(async () => Promise.reject({ code: "USER_DECLINED", message: "x" }))).rejects.toBeInstanceOf(BridgeDeclined);
    await expect(ask(async () => Promise.reject(new Error("Biometric prompt cancelled")))).rejects.toBeInstanceOf(BridgeDeclined);
    const e = await ask(async () => Promise.reject(new Error("coin is expired"))).catch((x) => x);
    expect(e).toBeInstanceOf(BridgeError);
    expect(e.message).toBe("coin is expired");
  });

  it("validates a minted payload like a scanned one, and refuses the wrong kind", async () => {
    const b = fake();
    const r = await mintOnPhone(b, { depositor: "0x03a62B04aBe69f382bd7582f492be735B1dDb47B", valueWei: 5_000_000_000_000_000n, mode: "public" });
    expect(r.payload.t).toBe("load");
    expect(b.mint).toHaveBeenCalledWith({ depositor: "0x03a62B04aBe69f382bd7582f492be735B1dDb47B", valueWei: "5000000000000000", mode: "public" });
    // The link opens like a scanned code.
    expect(payloadFromText(r.link).t).toBe("load");
    await expect(mintOnPhone(b, { depositor: "0x03a62B04aBe69f382bd7582f492be735B1dDb47B", valueWei: 1n, mode: "private" })).rejects.toThrow(/expected load-private/);
    await expect(mintOnPhone(fake({ mint: async () => ({ v: 1, t: "load", chainId: 11155111 }) }), { depositor: "0x03a62B04aBe69f382bd7582f492be735B1dDb47B", valueWei: 1n, mode: "public" })).rejects.toThrow();
  });

  it("cashes out to an address and asks the phone, which confirms on its own screen", async () => {
    const b = fake();
    const r = await cashOutToAddress(b, { coinId: "0xab", noteId: "n1", address: "0x03a62B04aBe69f382bd7582f492be735B1dDb47B" });
    expect(r.payload.t).toBe("redeem");
    expect(b.cashOut).toHaveBeenCalledWith({ coinId: "0xab", noteId: "n1", to: { address: "0x03a62B04aBe69f382bd7582f492be735B1dDb47B" } });
    const declined = fake({ cashOut: async () => Promise.reject({ code: "DECLINED" }) });
    await expect(cashOutToAddress(declined, { coinId: "0xab", address: "0x03a62B04aBe69f382bd7582f492be735B1dDb47B" })).rejects.toBeInstanceOf(BridgeDeclined);
  });

  it("cashes a note out to the private balance in the agreed order and checks what the phone signed", async () => {
    const wire = shieldRequestWire(request);
    const calls: string[] = [];
    const b = fake({
      shieldAsk: vi.fn(async () => (calls.push("ask"), { nonce: NONCE })),
      acceptShieldTarget: vi.fn(async (t: unknown) => (calls.push("accept"), expect(t).toEqual({ v: 1, t: "shield-target", chainId: 11155111, escrow: ESCROW_V31, nonce: NONCE, request: wire }), { ok: true })),
      cashOut: vi.fn(async (req: { to: { shield: unknown } }) => (calls.push("cashOut"), expect(req.to.shield).toEqual(wire), redeemShield(wire))),
    });
    const buildTarget = vi.fn(async () => request);
    const r = await cashOutToShield(b, { coinId: "0xab", valueWei: 2_000_000_000_000_000n, escrow: ESCROW_V31, chainId: 11155111, buildTarget });
    expect(calls).toEqual(["ask", "accept", "cashOut"]);
    expect(buildTarget).toHaveBeenCalledWith(2_000_000_000_000_000n);
    expect(r.payload.t).toBe("redeem-shield");

    // A phone that signs over a different request than it was handed is refused.
    const other = shieldRequestWire({ ...request, value: 3_000_000_000_000_000n });
    await expect(cashOutToShield(fake({ cashOut: async () => redeemShield(other) }), { coinId: "0xab", valueWei: 2_000_000_000_000_000n, escrow: ESCROW_V31, chainId: 11155111, buildTarget })).rejects.toThrow(/different shield request/);
    // And a malformed nonce stops before any target is built.
    const built = vi.fn(async () => request);
    await expect(cashOutToShield(fake({ shieldAsk: async () => ({ nonce: "NOPE" }) }), { coinId: "0xab", valueWei: 1n, escrow: ESCROW_V31, chainId: 11155111, buildTarget: built })).rejects.toThrow(/nonce/);
    expect(built).not.toHaveBeenCalled();
  });

  it("refreshes, and never lets a failed notification undo anything", async () => {
    const r = await refreshOnPhone(fake(), { coinId: "0xab" });
    expect(r.payload.t).toBe("refresh");
    expect(payloadLink(refreshPayload).startsWith("prawl://offline/refresh?d=")).toBe(true);
    const win = globalThis as unknown as { window?: { prawlOffline?: unknown } };
    win.window = { prawlOffline: fake({ markDeposited: async () => Promise.reject(new Error("phone busy")) }) };
    try {
      await expect(tellPhone((b) => b.markDeposited({ coinId: "0xab", txHash: "0xcd" }))).resolves.toBeUndefined();
    } finally {
      delete win.window;
    }
    expect(() => parsePayload(refreshPayload)).not.toThrow();
  });
});
