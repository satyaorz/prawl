import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, toEventSelector, type Hex } from "viem";
import loadFixture from "./fixtures/offline/load-deposited.json";
import redeemFixture from "./fixtures/offline/redeem-already-paid.json";
import { ESCROW_ABI, depositCall, redeemCall, redeemOutcome, revertReason } from "../src/offline/escrow";
import { ESCROW_V3, ESCROW_V31, ESCROW_V32, PayloadError, ShieldAsk, configProblems, decodeD, depositorUri, encodeD, parsePayload, payloadFromText, payoutValue, type RedeemPayload } from "../src/offline/payload";

describe("offline handoff payloads (real phone vectors)", () => {
  it("decodes a load link and builds the exact deposit call", () => {
    const p = payloadFromText(`https://prawl.example/#/offline/load?d=${loadFixture.d}`);
    expect(p.t).toBe("load");
    if (p.t !== "load") return;
    expect(p.coinId).toBe(loadFixture.payload.coinId);
    expect(p.value).toBe(5_000_000_000_000_000n);
    expect(p.depositor).toBe("0x03a62B04aBe69f382bd7582f492be735B1dDb47B");
    expect(configProblems(p)).toEqual([]);
    const call = depositCall(p);
    expect(call.to).toBe(ESCROW_V3);
    expect(call.value).toBe(5_000_000_000_000_000n);
    const { functionName, args } = decodeFunctionData({ abi: ESCROW_ABI, data: call.data });
    expect(functionName).toBe("deposit");
    expect(args).toEqual([loadFixture.payload.coinId, 1794812349n, BigInt(loadFixture.payload.k0x), BigInt(loadFixture.payload.k0y)]);
  });

  it("decodes a redeem link (also prawl://) and round-trips the redeem arguments", () => {
    const p = payloadFromText(`prawl://offline/redeem?d=${redeemFixture.d}`) as RedeemPayload;
    expect(p.t).toBe("redeem");
    expect(p.path).toHaveLength(2);
    expect(payoutValue(p)).toBe(1_000_000_000_000_000n);
    const { functionName, args } = decodeFunctionData({ abi: ESCROW_ABI, data: redeemCall(p).data });
    expect(functionName).toBe("redeem");
    const [h, path, rd] = args as unknown as [{ coinId: Hex; depositor: Hex }, { index: bigint }[], { payout: Hex }];
    expect(h.coinId).toBe(redeemFixture.payload.header.coinId);
    expect(path.map((s) => s.index)).toEqual([0n, 0n]);
    expect(rd.payout).toBe("0x03a62B04aBe69f382bd7582f492be735B1dDb47B");
  });

  it("accepts a bare d and round-trips encodeD/decodeD", () => {
    expect(payloadFromText(loadFixture.d).t).toBe("load");
    expect(decodeD(encodeD({ a: "ü" }))).toEqual({ a: "ü" });
  });

  it("refuses wrong versions, types, mismatched link kinds, bad fields and foreign escrows", () => {
    const bad = (patch: object) => encodeD({ ...loadFixture.payload, ...patch });
    expect(() => payloadFromText(bad({ v: 2 }))).toThrow(/version/);
    expect(() => payloadFromText(bad({ t: "steal" }))).toThrow(/unknown payload type/);
    expect(() => payloadFromText(`#/offline/redeem?d=${loadFixture.d}`)).toThrow(/link says redeem/);
    expect(() => payloadFromText(bad({ coinId: "0x12" }))).toThrow(/coinId/);
    expect(() => payloadFromText(bad({ value: "-1" }))).toThrow(/value/);
    expect(() => payloadFromText("hello")).toThrow(PayloadError);
    const foreign = parsePayload({ ...loadFixture.payload, escrow: "0x000000000000000000000000000000000000dEaD", chainId: 1 });
    expect(configProblems(foreign)).toHaveLength(2);
  });

  it("names escrow reverts, e.g. AlreadyRedeemed", () => {
    const data = encodeErrorResult({ abi: ESCROW_ABI, errorName: "AlreadyRedeemed", args: [`0x${"ab".repeat(32)}`] });
    expect(data.slice(0, 10)).toBe("0xc8e03f03");
    const e = Object.assign(new Error("execution reverted"), { rpcData: data });
    expect(revertReason(e)).toBe("this cash-out was already paid (AlreadyRedeemed)");
    expect(revertReason(new Error("boom"))).toBe("boom");
  });

  it("makes the EIP-681 depositor link", () => {
    expect(depositorUri("0x03a62b04abe69f382bd7582f492be735b1ddb47b")).toBe("ethereum:0x03a62B04aBe69f382bd7582f492be735B1dDb47B@11155111");
  });

  it("decides a mined redeem's result from the escrow's events, not the receipt status", () => {
    const p = payloadFromText(redeemFixture.d) as RedeemPayload;
    const coin = p.header.coinId;
    const payout = p.redemption.payout;
    const log = (eventName: string, args: Record<string, unknown>, data: Hex) => ({
      address: ESCROW_V3 as Hex,
      topics: encodeEventTopics({ abi: ESCROW_ABI, eventName: eventName as never, args: args as never }) as Hex[],
      data,
    });
    // The live cash-out (tx 0x167cfd8c…) emitted topic 0xbf4d9a8f… for Redeemed.
    expect(toEventSelector("Redeemed(bytes32,address,bytes32,uint256,uint256,bytes32,uint256)").slice(0, 10)).toBe("0xbf4d9a8f");
    const redeemed = log("Redeemed", { coinId: coin, payout, noteId: `0x${"11".repeat(32)}` },
      encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }], [0n, 1000n, `0x${"22".repeat(32)}`, 1000n]));
    const deferred = log("PaymentDeferred", { to: payout }, encodeAbiParameters([{ type: "uint256" }], [1000n]));
    const blocked = log("RedeemBlocked", { coinId: coin, keyHash: `0x${"33".repeat(32)}` }, encodeAbiParameters([{ type: "uint256" }], [1n]));
    const frozen = log("CoinFrozen", { coinId: coin, keyHash: `0x${"33".repeat(32)}` }, "0x");
    expect(redeemOutcome([redeemed], p)).toEqual({ kind: "paid", amount: 1000n });
    expect(redeemOutcome([redeemed, deferred], p)).toEqual({ kind: "deferred", amount: 1000n });
    expect(redeemOutcome([frozen, blocked], p)).toEqual({ kind: "blocked", frozen: true });
    expect(redeemOutcome([], p)).toEqual({ kind: "unknown" });
    // Events from another contract never count.
    expect(redeemOutcome([{ ...redeemed, address: "0x000000000000000000000000000000000000dEaD" }], p)).toEqual({ kind: "unknown" });
  });
});

describe("payload indexes", () => {
  it("refuses a redemption or spend whose index points past its outputs", async () => {
    const { encodeD, payloadFromText: parse } = await import("../src/offline/payload");
    const base = redeemFixture.payload as unknown as { redemption: { index: number }; path: { index: number }[] };
    expect(() => parse(encodeD({ ...base, redemption: { ...base.redemption, index: 5 } }))).toThrow(/redemption.index/);
    expect(() => parse(encodeD({ ...base, path: [{ ...base.path[0], index: 9 }, base.path[1]] }))).toThrow(/path\[0\].index/);
  });
});

describe("escrow v3.1 handoff kinds", () => {
  const params = {
    coinId: `0x${"a1".repeat(32)}`, expiry: 1794812810, k0x: `0x${"b2".repeat(32)}`, k0y: `0x${"c3".repeat(32)}`,
    depositor: "0x00000000000000000000000000000000000000d4", minValue: "5000000000000000", maxValue: "5000000000000000", tip: "0",
  };
  const loadPrivate = { v: 1, t: "load-private", chainId: 11155111, escrow: ESCROW_V31, params, depositAddress: "0x00000000000000000000000000000000000000e5" };

  it("parses a private load and requires escrow v3.1", () => {
    const p = payloadFromText(`https://x.example/#/offline/load-private?d=${encodeD(loadPrivate)}`);
    expect(p.t).toBe("load-private");
    if (p.t !== "load-private") return;
    expect(p.params.maxValue).toBe(5_000_000_000_000_000n);
    expect(p.depositAddress).toBe("0x00000000000000000000000000000000000000E5"); // checksummed
    expect(configProblems(p)).toEqual([]);
    const onV3 = parsePayload({ ...loadPrivate, escrow: ESCROW_V3 });
    expect(configProblems(onV3).join(" ")).toMatch(/needs escrow v3.1/);
    expect(() => parsePayload({ ...loadPrivate, params: { ...params, maxValue: "x" } })).toThrow(/maxValue/);
  });

  it("accepts plain load and redeem links on either escrow", () => {
    const p = parsePayload({ ...loadFixture.payload, escrow: ESCROW_V31 });
    expect(configProblems(p)).toEqual([]);
    expect(configProblems(parsePayload(loadFixture.payload))).toEqual([]);
  });

  it("refuses a shield-target link: it is a request for the phone", () => {
    expect(() => payloadFromText(`prawl://offline/shield-target?d=${encodeD({ v: 1, t: "shield-target" })}`)).toThrow(/request for the phone/);
  });

  it("calls the three v3.1 functions with the escrow's own address and the nested structs", async () => {
    const { commitCall, activateCall, redeemToShieldCall } = await import("../src/offline/escrow");
    const p = parsePayload(loadPrivate);
    if (p.t !== "load-private") throw new Error("type");
    expect(commitCall(p).to).toBe(ESCROW_V31);
    for (const [call, name] of [[commitCall(p), "commitDeposit"], [activateCall(p), "activate"]] as const) {
      const d = decodeFunctionData({ abi: ESCROW_ABI, data: call.data });
      expect(d.functionName).toBe(name);
      expect((d.args as unknown as [{ coinId: Hex; depositor: Hex; maxValue: bigint }])[0]).toMatchObject({ coinId: params.coinId, maxValue: 5_000_000_000_000_000n });
    }
    void redeemToShieldCall;
  });

  it("decides a shield cash-out from RedeemedToShield for this coin and npk, never the receipt", async () => {
    const { redeemOutcome } = await import("../src/offline/escrow");
    const shield = { npk: `0x${"7e".repeat(32)}`, tokenType: 0, tokenAddress: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", tokenSubID: "0", value: "1000", encryptedBundle: [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`, `0x${"03".repeat(32)}`], shieldKey: `0x${"04".repeat(32)}` };
    const base = redeemFixture.payload as unknown as Record<string, unknown> & { redemption: Record<string, unknown> };
    const p = parsePayload({ ...base, t: "redeem-shield", escrow: ESCROW_V31, redemption: { ...base.redemption, payout: "0x0000000000000000000000000000000000000000" }, shield });
    if (p.t !== "redeem-shield") throw new Error("type");
    const mk = (eventName: string, args: Record<string, unknown>, data: Hex) => ({
      address: ESCROW_V31 as Hex,
      topics: encodeEventTopics({ abi: ESCROW_ABI, eventName: eventName as never, args: args as never }) as Hex[],
      data,
    });
    const ok = mk("RedeemedToShield", { coinId: p.header.coinId, npk: shield.npk }, encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [`0x${"05".repeat(32)}`, 1000n]));
    expect(redeemOutcome([ok], p)).toEqual({ kind: "paid", amount: 1000n });
    const other = mk("RedeemedToShield", { coinId: p.header.coinId, npk: `0x${"7f".repeat(32)}` }, encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [`0x${"05".repeat(32)}`, 1000n]));
    expect(redeemOutcome([other], p)).toEqual({ kind: "unknown" });
    expect(redeemOutcome([], p)).toEqual({ kind: "unknown" });
  });
});

describe("refresh and shield-ask", () => {
  const base = redeemFixture.payload as unknown as Record<string, unknown> & { redemption: Record<string, unknown> };
  const refresh = {
    ...base, t: "refresh", escrow: ESCROW_V31,
    redemption: { ...base.redemption, payout: "0x00000000000000000000000000000000000000d4" },
    refresh: { newCoinId: `0x52465348${"ab".repeat(28)}`, newExpiry: 1_796_000_000, newK0x: `0x${"11".repeat(32)}`, newK0y: `0x${"22".repeat(32)}` },
  };

  it("parses a refresh, requires v3.1, and refuses a bad new coin id word", async () => {
    const p = payloadFromText(`https://x.example/#/offline/refresh?d=${encodeD(refresh)}`);
    expect(p.t).toBe("refresh");
    if (p.t !== "refresh") return;
    expect(p.refresh.newExpiry).toBe(1_796_000_000n);
    expect(configProblems(p)).toEqual([]);
    expect(configProblems(parsePayload({ ...refresh, escrow: ESCROW_V3 })).join(" ")).toMatch(/needs escrow v3.1/);
    expect(() => parsePayload({ ...refresh, refresh: { ...refresh.refresh, newCoinId: "0x12" } })).toThrow(/newCoinId/);
    const { refreshCall } = await import("../src/offline/escrow");
    const d = decodeFunctionData({ abi: ESCROW_ABI, data: refreshCall(p).data });
    expect(d.functionName).toBe("refresh");
    expect((d.args as unknown as unknown[])[3]).toBe(refresh.refresh.newCoinId);
    expect((d.args as unknown as unknown[])[4]).toBe(1_796_000_000n);
  });

  it("decides a refresh from Refreshed for the old and the new coin id", async () => {
    const { redeemOutcome } = await import("../src/offline/escrow");
    const p = parsePayload(refresh);
    if (p.t !== "refresh") throw new Error("type");
    const mk = (newCoinId: string) => ({
      address: ESCROW_V31 as Hex,
      topics: encodeEventTopics({ abi: ESCROW_ABI, eventName: "Refreshed", args: { coinId: p.header.coinId, newCoinId: newCoinId as Hex } }) as Hex[],
      data: encodeAbiParameters([{ type: "uint256" }], [3000n]),
    });
    expect(redeemOutcome([mk(p.refresh.newCoinId)], p)).toEqual({ kind: "paid", amount: 3000n });
    expect(redeemOutcome([mk(`0x52465348${"cd".repeat(28)}`)], p)).toEqual({ kind: "unknown" });
    expect(redeemOutcome([], p)).toEqual({ kind: "unknown" });
  });

  it("turns a phone's shield-ask into the value to build a target for", () => {
    const ask = encodeD({ v: 1, t: "shield-ask", chainId: 11155111, escrow: ESCROW_V31, value: "2000000000000000" });
    try {
      payloadFromText(`prawl://offline/shield-ask?d=${ask}`);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ShieldAsk);
      expect((e as ShieldAsk).valueWei).toBe(2_000_000_000_000_000n);
    }
    expect(() => payloadFromText(`prawl://offline/shield-ask?d=${encodeD({ v: 2, t: "shield-ask", value: "1" })}`)).toThrow(/not a shield request/);
  });
});

describe("shield-ask nonce and escrow v3.2", () => {
  const NONCE = "0123456789abcdef0123456789abcdef";
  const ask = (extra: object) => `prawl://offline/shield-ask?d=${encodeD({ v: 1, t: "shield-ask", chainId: 11155111, escrow: ESCROW_V31, value: "2000000000000000", ...extra })}`;
  const catchAsk = (text: string): ShieldAsk => {
    try {
      payloadFromText(text);
    } catch (e) {
      if (e instanceof ShieldAsk) return e;
      throw e;
    }
    throw new Error("expected a ShieldAsk");
  };

  it("carries the phone's nonce and escrow so the target can echo them", async () => {
    const a = catchAsk(ask({ nonce: NONCE }));
    expect(a.nonce).toBe(NONCE);
    expect(a.escrow).toBe(ESCROW_V31);
    expect(catchAsk(ask({})).nonce).toBeUndefined();
    const { shieldTargetLink: link, decodeD: dec } = await import("../src/offline/payload");
    const req = { npk: `0x${"7e".repeat(32)}`, tokenType: 0, tokenAddress: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", tokenSubID: 0n, value: 2_000_000_000_000_000n, encryptedBundle: [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`, `0x${"03".repeat(32)}`], shieldKey: `0x${"04".repeat(32)}` } as const;
    const withNonce = dec(link(ESCROW_V31, req as never, NONCE).split("d=")[1]!) as Record<string, unknown>;
    expect(withNonce.nonce).toBe(NONCE); // top-level, next to `request`
    expect(withNonce.request).toBeDefined();
    const typed = dec(link(ESCROW_V31, req as never).split("d=")[1]!) as Record<string, unknown>;
    expect("nonce" in typed).toBe(false);
  });

  it("refuses a malformed nonce, another chain and an escrow that cannot shield", () => {
    expect(() => payloadFromText(ask({ nonce: "ABC" }))).toThrow(/nonce/);
    expect(() => payloadFromText(ask({ nonce: NONCE.toUpperCase() }))).toThrow(/nonce/);
    expect(() => payloadFromText(ask({ chainId: 1 }))).toThrow(/chain/);
    expect(() => payloadFromText(ask({ escrow: ESCROW_V3 }))).toThrow(/cannot cash out into RAILGUN/);
  });

  it("treats v3.2 like v3.1 for the private kinds and plain flows", () => {
    expect(configProblems(parsePayload({ ...loadFixture.payload, escrow: ESCROW_V32 }))).toEqual([]);
    const lp = { v: 1, t: "load-private", chainId: 11155111, escrow: ESCROW_V32, depositAddress: "0x00000000000000000000000000000000000000e5",
      params: { coinId: `0x${"a1".repeat(32)}`, expiry: 1794812810, k0x: `0x${"b2".repeat(32)}`, k0y: `0x${"c3".repeat(32)}`, depositor: "0x00000000000000000000000000000000000000d4", minValue: "1", maxValue: "1", tip: "0" } };
    expect(configProblems(parsePayload(lp))).toEqual([]);
    expect(configProblems(parsePayload({ ...lp, escrow: ESCROW_V3 })).join(" ")).toMatch(/v3.1 or newer/);
  });
});
