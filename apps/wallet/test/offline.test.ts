import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeErrorResult, type Hex } from "viem";
import loadFixture from "./fixtures/offline/load-deposited.json";
import redeemFixture from "./fixtures/offline/redeem-already-paid.json";
import { ESCROW_ABI, depositCall, redeemCall, revertReason } from "../src/offline/escrow";
import { ESCROW_V3, PayloadError, configProblems, decodeD, depositorUri, encodeD, parsePayload, payloadFromText, payoutValue, type RedeemPayload } from "../src/offline/payload";

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
});
