import { describe, expect, it } from "vitest";
import fixture from "./fixtures/offline/shield-weth-1e15.json";
import { SHIELD_SELECTOR, encodeShieldRequest, shieldHash, shieldRequestFromCall } from "../src/offline/shield";
import { ESCROW_V31, PayloadError, parsePayload, shieldRequestWire, shieldTargetLink, decodeD } from "../src/offline/payload";
import type { Hex } from "viem";

const call = { to: fixture.calls[0]!.to as Hex, data: fixture.calls[0]!.data as Hex, value: BigInt(fixture.calls[0]!.value) };

describe("ShieldRequest from kohaku's real shield call", () => {
  it("decodes the nine fields and matches the 288-byte encoding in the call", () => {
    expect(call.data.slice(0, 10)).toBe(SHIELD_SELECTOR);
    const r = shieldRequestFromCall(call, fixture.smartWallet as Hex);
    expect(r.tokenType).toBe(0);
    expect(r.tokenAddress.toLowerCase()).toBe(fixture.weth.toLowerCase());
    expect(r.tokenSubID).toBe(0n);
    expect(r.value).toBe(10n ** 15n);
    expect(r.npk).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.encryptedBundle).toHaveLength(3);
    // The calldata is selector + offset + length + the same 9 words abi.encode(request) gives.
    const enc = encodeShieldRequest(r);
    expect((enc.length - 2) / 2).toBe(288);
    expect(call.data.slice(2 + 8 + 128)).toBe(enc.slice(2));
  });

  it("hashes with sha256 over those words (the phone's shieldHash)", async () => {
    const r = shieldRequestFromCall(call, fixture.smartWallet as Hex);
    const h = await shieldHash(r);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(await shieldHash({ ...r }));
    expect(h).not.toBe(await shieldHash({ ...r, value: r.value + 1n }));
  });

  it("refuses another target, ETH, another function, or no request", () => {
    expect(() => shieldRequestFromCall({ ...call, to: "0x000000000000000000000000000000000000dEaD" }, fixture.smartWallet as Hex)).toThrow(/smart wallet/);
    expect(() => shieldRequestFromCall({ ...call, value: 1n }, fixture.smartWallet as Hex)).toThrow(/ETH/);
    expect(() => shieldRequestFromCall({ ...call, data: `0xdeadbeef${call.data.slice(10)}` }, fixture.smartWallet as Hex)).toThrow(/not a RAILGUN shield call/);
  });

  it("round-trips through the handoff wire format as a shield-target link", () => {
    const r = shieldRequestFromCall(call, fixture.smartWallet as Hex);
    const link = shieldTargetLink(ESCROW_V31, r);
    expect(link.startsWith("prawl://offline/shield-target?d=")).toBe(true);
    const body = decodeD(link.split("d=")[1]!) as { t: string; request: Record<string, unknown> };
    expect(body.t).toBe("shield-target");
    expect(body.request).toEqual(shieldRequestWire(r));
    expect(typeof body.request.value).toBe("string");
    expect(typeof body.request.tokenSubID).toBe("string");
    // And a redeem-shield payload carrying it parses back to the same request.
    const redeem = {
      v: 1, t: "redeem-shield", chainId: 11155111, escrow: ESCROW_V31,
      header: { coinId: `0x${"01".repeat(32)}`, value: "1000", expiry: 1794812810, k0x: `0x${"02".repeat(32)}`, k0y: `0x${"03".repeat(32)}`, depositor: "0x00000000000000000000000000000000000000a1" },
      path: [],
      redemption: { outputs: [{ value: "1000", keyHash: `0x${"04".repeat(32)}` }], index: 0, payout: "0x0000000000000000000000000000000000000000", r: `0x${"05".repeat(32)}`, s: `0x${"06".repeat(32)}` },
      shield: body.request,
    };
    const parsed = parsePayload(redeem);
    expect(parsed.t).toBe("redeem-shield");
    if (parsed.t === "redeem-shield") expect(parsed.shield).toEqual(r);
    expect(() => parsePayload({ ...redeem, shield: { ...(body.request as object), encryptedBundle: ["0x1"] } })).toThrow(PayloadError);
  });
});
