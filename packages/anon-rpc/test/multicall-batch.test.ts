import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionResult, parseAbi, type Hex } from "viem";
import { aggregate3, aggregate3Read, calls, decodeAggregate3, decodeSymbol, decodeUint, encodeAggregate3, MULTICALL3 } from "../src/multicall";
import { DEFAULT_POLICY, type ProviderPolicy } from "../src/providers";
import { ADDR_A, ADDR_B, BURN, okRpc, setup } from "./fake-worker";

const MC3 = parseAbi([
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns (Result[] returnData)",
]);
const TOKENS = Array.from({ length: 25 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "a")}` as `0x${string}`);

function mc3Answer(n: number): Hex {
  const results = Array.from({ length: n }, (_, i) => ({
    success: true,
    returnData: encodeAbiParameters([{ type: "uint256" }], [BigInt(i + 1)]),
  }));
  return encodeFunctionResult({ abi: MC3, functionName: "aggregate3", result: results });
}

describe("rule 6: Multicall3 for one owner", () => {
  it("encodes and decodes aggregate3 round trip", () => {
    const owner = setup().client.identities.account(BURN);
    const data = encodeAggregate3([calls.balanceOf(TOKENS[0]!, owner), calls.symbol(TOKENS[0]!)]);
    expect(data.slice(0, 10)).toBe("0x82ad56cb");
    const decoded = decodeAggregate3(mc3Answer(2));
    expect(decoded.map(decodeUint)).toEqual([1n, 2n]);
    const sym = encodeAbiParameters([{ type: "string" }], ["USDC"]);
    expect(decodeSymbol({ success: true, returnData: sym })).toBe("USDC");
    const mkr = `0x${"4d4b52".padEnd(64, "0")}` as Hex; // "MKR" as bytes32
    expect(decodeSymbol({ success: true, returnData: mkr })).toBe("MKR");
  });

  it("sends 76 owner calls (ETH + 25 balances + metadata) as one request", async () => {
    const s = setup(() => ({ json: { jsonrpc: "2.0", id: 1, result: mc3Answer(76) } }));
    const owner = s.client.identities.account(BURN);
    const list = [calls.ethBalance(owner), ...TOKENS.flatMap((t) => [calls.balanceOf(t, owner), calls.symbol(t), calls.decimals(t)])];
    const out = await aggregate3(s.client, owner, 1, list, "0x100");
    expect(out).toHaveLength(76);
    expect(s.log).toHaveLength(1);
    expect((s.log[0]!.json as { params: [{ to: string }] }).params[0].to).toBe(MULTICALL3);
  });

  it("refuses a public or tx identity as the owner", () => {
    const s = setup();
    expect(() => aggregate3Read(s.client.identities.publicScope("tokens"), [], "latest")).toThrow(/one owner/);
    expect(() => calls.balanceOf(TOKENS[0]!, s.client.identities.publicScope("tokens"))).toThrow(/one owner/);
  });

  it("rejects a multicall under owner A that reads owner B's balance (cross-identity)", async () => {
    const s = setup(() => ({ json: { jsonrpc: "2.0", id: 1, result: mc3Answer(2) } }));
    const a = s.client.identities.account(ADDR_A);
    const b = s.client.identities.account(ADDR_B);
    await expect(aggregate3(s.client, a, 1, [calls.balanceOf(TOKENS[0]!, a), calls.balanceOf(TOKENS[0]!, b)], "0x100")).rejects.toMatchObject({
      code: "CROSS_IDENTITY",
    });
    expect(s.log).toHaveLength(0);
  });
});

describe("rule 6: single-identity JSON-RPC batch only where the provider allows it", () => {
  it("sends one batch request on publicnode (accepts 10)", async () => {
    const s = setup();
    const a = s.client.identities.account(ADDR_A);
    const out = await s.client.batch(a, 1, [
      { method: "eth_getBalance", params: [ADDR_A, "latest"] },
      { method: "eth_getCode", params: [ADDR_A, "latest"] },
      { method: "eth_getTransactionCount", params: [ADDR_A, "latest"] },
    ]);
    expect(out).toEqual([{ result: "0x1" }, { result: "0x1" }, { result: "0x1" }]);
    expect(s.log).toHaveLength(1);
    expect(Array.isArray(s.log[0]!.json)).toBe(true);
    expect(s.traces[0]!.method).toBe("batch:3");
  });

  it("skips dRPC for batches over 3 and falls back to separate reads when nobody accepts the size", async () => {
    const s = setup();
    const a = s.client.identities.account(ADDR_A);
    const eleven = Array.from({ length: 11 }, (_, i) => ({ method: "eth_getStorageAt", params: [ADDR_A, `0x${i}`, "latest"] }));
    const out = await s.client.batch(a, 1, eleven);
    expect(out).toHaveLength(11);
    expect(s.log).toHaveLength(11);
    expect(s.log.every((c) => !Array.isArray(c.json))).toBe(true);
    expect(new Set(s.log.map((c) => c.identityKey))).toEqual(new Set([`acct:${ADDR_A}`]));
  });

  it("never batches on onfinality (429 on every batch)", async () => {
    const policy: ProviderPolicy = structuredClone(DEFAULT_POLICY);
    policy.chains[11155111]!.read = ["onfinality-sepolia"];
    const s = setup(okRpc, { client: { policy } });
    const a = s.client.identities.account(ADDR_A);
    await s.client.batch(a, 11155111, [
      { method: "eth_getBalance", params: [ADDR_A, "latest"] },
      { method: "eth_getCode", params: [ADDR_A, "latest"] },
    ]);
    expect(s.log).toHaveLength(2);
    expect(s.log.every((c) => c.host === "eth-sepolia.api.onfinality.io")).toBe(true);
  });

  it("rejects a batch whose calls name a second identity", async () => {
    const s = setup();
    const a = s.client.identities.account(ADDR_A);
    s.client.identities.account(ADDR_B);
    await expect(
      s.client.batch(a, 1, [
        { method: "eth_getBalance", params: [ADDR_A, "latest"] },
        { method: "eth_getBalance", params: [ADDR_B, "latest"] },
      ]),
    ).rejects.toMatchObject({ code: "CROSS_IDENTITY" });
    expect(s.log).toHaveLength(0);
  });

  it("maps per-item JSON-RPC errors without failing the whole batch", async () => {
    const s = setup(() => ({
      json: [
        { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "reverted" } },
        { jsonrpc: "2.0", id: 1, result: "0x5" },
      ],
    }));
    const out = await s.client.batch(s.client.identities.account(ADDR_A), 1, [
      { method: "eth_getBalance", params: [ADDR_A, "latest"] },
      { method: "eth_call", params: [{ to: ADDR_A }, "latest"] },
    ]);
    expect(out[0]).toEqual({ result: "0x5" });
    expect((out[1] as { error: { code: string } }).error.code).toBe("RPC_ERROR");
  });
});
