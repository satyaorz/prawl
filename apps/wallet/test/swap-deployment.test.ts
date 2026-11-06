import { describe, expect, it } from "vitest";
import { encodeFunctionResult, keccak256, parseAbi, toFunctionSelector, zeroAddress, type Hex } from "viem";
import type { AnonRpcClient } from "@prawl/anon-rpc";
import { parseSwapDeployment, verifySwapDeployment, type SwapDeployment } from "../src/swap/deployment";

const names = ["batch", "tokenA", "tokenB", "wrapperA", "wrapperB", "oracle", "router", "permit2"] as const;
const addresses = Object.fromEntries(names.map((name, i) => [name, `0x${(i + 1).toString(16).padStart(40, "0")}`])) as Record<typeof names[number], Hex>;
const codes = Object.fromEntries(names.map((name, i) => [name, `0x60${(i + 1).toString(16).padStart(2, "0")}`])) as Record<typeof names[number], Hex>;
const fixture = {
  chainId: 11155111, ...addresses,
  pool: { currency0: addresses.tokenA, currency1: addresses.tokenB, fee: 3000, tickSpacing: 60, hooks: zeroAddress },
  codeHashes: Object.fromEntries(names.map((name) => [name, keccak256(codes[name])])),
};
const batchAbi = parseAbi([
  "function VERSION() view returns (uint256)", "function cTokenA() view returns (address)", "function cTokenB() view returns (address)",
  "function priceOracle() view returns (address)", "function router() view returns (address)", "function permit2() view returns (address)",
  "function poolKey() view returns (address,address,uint24,int24,address)",
]);
const wrapperAbi = parseAbi(["function underlying() view returns (address)", "function rate() view returns (uint256)", "function decimals() view returns (uint8)"]);

function fakeClient(config: SwapDeployment, badCode = false, badWrapper = false): AnonRpcClient {
  return {
    identities: { publicScope: () => ({ key: "public-swap-config" }) },
    read: async (_id: unknown, chainId: number, method: string, params: unknown[]) => {
      expect(chainId).toBe(11155111);
      if (method === "eth_getCode") {
        const index = names.findIndex((name) => config[name].toLowerCase() === String(params[0]).toLowerCase());
        return badCode && index === 0 ? "0x6000" : codes[names[index]!];
      }
      const { to, data } = params[0] as { to: string; data: string };
      const selector = data.slice(0, 10);
      if (to.toLowerCase() === config.batch.toLowerCase()) {
        if (selector === toFunctionSelector("VERSION()")) return encodeFunctionResult({ abi: batchAbi, functionName: "VERSION", result: 4n });
        const fields = { cTokenA: config.wrapperA, cTokenB: config.wrapperB, priceOracle: config.oracle, router: config.router, permit2: config.permit2 } as const;
        for (const [name, value] of Object.entries(fields)) if (selector === toFunctionSelector(`${name}()`)) {
          return encodeFunctionResult({ abi: parseAbi([`function ${name}() view returns (address)`]), functionName: name, result: value });
        }
        if (selector === toFunctionSelector("poolKey()")) return encodeFunctionResult({ abi: batchAbi, functionName: "poolKey", result: [config.pool.currency0, config.pool.currency1, 3000, 60, zeroAddress] });
      }
      if (selector === toFunctionSelector("underlying()")) return encodeFunctionResult({ abi: wrapperAbi, functionName: "underlying", result: badWrapper ? config.tokenB : to.toLowerCase() === config.wrapperA.toLowerCase() ? config.tokenA : config.tokenB });
      if (selector === toFunctionSelector("rate()")) return encodeFunctionResult({ abi: wrapperAbi, functionName: "rate", result: 10n ** 12n });
      if (selector === toFunctionSelector("decimals()")) return encodeFunctionResult({ abi: wrapperAbi, functionName: "decimals", result: [config.wrapperA, config.wrapperB].some((a) => a.toLowerCase() === to.toLowerCase()) ? 6 : 18 });
      throw new Error(`unexpected read ${method}`);
    },
  } as unknown as AnonRpcClient;
}

describe("swap deployment verification", () => {
  it("accepts a pinned WETH pair only after verifying code, pool, wrappers and decimals", async () => {
    const config = parseSwapDeployment(fixture, addresses.tokenA);
    await expect(verifySwapDeployment(fakeClient(config), config)).resolves.toBeUndefined();
  });

  it("rejects other chains, mismatched WETH and malformed pool or code hashes", () => {
    expect(() => parseSwapDeployment({ ...fixture, chainId: 1 }, addresses.tokenA)).toThrow();
    expect(() => parseSwapDeployment(fixture, addresses.oracle)).toThrow();
    expect(() => parseSwapDeployment({ ...fixture, pool: { ...fixture.pool, hooks: addresses.oracle } }, addresses.tokenA)).toThrow();
    expect(() => parseSwapDeployment({ ...fixture, codeHashes: { ...fixture.codeHashes, batch: "0x" } }, addresses.tokenA)).toThrow();
  });

  it("rejects changed contract code and wrapper wiring", async () => {
    const config = parseSwapDeployment(fixture, addresses.tokenA);
    await expect(verifySwapDeployment(fakeClient(config, true), config)).rejects.toThrow("code mismatch");
    await expect(verifySwapDeployment(fakeClient(config, false, true), config)).rejects.toThrow("wrapper or token mismatch");
  });
});
