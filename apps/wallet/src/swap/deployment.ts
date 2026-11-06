import type { AnonRpcClient } from "@prawl/anon-rpc";
import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, isHex, keccak256, parseAbi, zeroAddress, type Address, type Hex } from "viem";

/** A build-time, chain-specific deployment manifest. Addresses alone are not trusted. */
export interface SwapDeployment {
  chainId: 11155111;
  batch: Address;
  tokenA: Address;
  tokenB: Address;
  wrapperA: Address;
  wrapperB: Address;
  oracle: Address;
  router: Address;
  permit2: Address;
  pool: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  codeHashes: { batch: Hex; tokenA: Hex; tokenB: Hex; wrapperA: Hex; wrapperB: Hex; oracle: Hex; router: Hex; permit2: Hex };
}

const hashKeys = ["batch", "tokenA", "tokenB", "wrapperA", "wrapperB", "oracle", "router", "permit2"] as const;
const batchAbi = parseAbi([
  "function VERSION() view returns (uint256)",
  "function cTokenA() view returns (address)",
  "function cTokenB() view returns (address)",
  "function priceOracle() view returns (address)",
  "function router() view returns (address)",
  "function permit2() view returns (address)",
  "function poolKey() view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)",
]);
const wrapperAbi = parseAbi(["function underlying() view returns (address)", "function rate() view returns (uint256)", "function decimals() view returns (uint8)"]);
const tokenAbi = parseAbi(["function decimals() view returns (uint8)"]);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid swap deployment manifest");
  return value as Record<string, unknown>;
}
function address(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value) || value.toLowerCase() === zeroAddress) throw new Error("Invalid swap deployment address");
  return getAddress(value);
}
function digest(value: unknown): Hex {
  if (typeof value !== "string" || !isHex(value) || value.length !== 66) throw new Error("Invalid swap deployment code hash");
  return value as Hex;
}

/** Parse a trusted build-time manifest and enforce the single WETH pair. */
export function parseSwapDeployment(value: unknown, weth: string): SwapDeployment {
  const raw = object(value);
  if (raw.chainId !== 11155111) throw new Error("Swap deployment is not on Sepolia");
  const pool = object(raw.pool);
  const hashes = object(raw.codeHashes);
  const parts = Object.fromEntries(hashKeys.map((key) => [key, address(raw[key])])) as Pick<SwapDeployment, typeof hashKeys[number]>;
  if (new Set(Object.values(parts).map((a) => a.toLowerCase())).size !== hashKeys.length) throw new Error("Swap deployment addresses must be distinct");
  if (![parts.tokenA.toLowerCase(), parts.tokenB.toLowerCase()].includes(address(weth).toLowerCase())) throw new Error("Swap pool does not use this wallet's WETH");
  const currency0 = address(pool.currency0);
  const currency1 = address(pool.currency1);
  if (BigInt(currency0) >= BigInt(currency1)) throw new Error("Swap pool currencies are not sorted");
  if (![parts.tokenA.toLowerCase(), parts.tokenB.toLowerCase()].includes(currency0.toLowerCase()) ||
      ![parts.tokenA.toLowerCase(), parts.tokenB.toLowerCase()].includes(currency1.toLowerCase())) throw new Error("Swap pool assets do not match the manifest");
  if (!Number.isInteger(pool.fee) || Number(pool.fee) < 0 || Number(pool.fee) >= 1_000_000) throw new Error("Invalid swap pool fee");
  if (!Number.isInteger(pool.tickSpacing) || Number(pool.tickSpacing) < 1 || Number(pool.tickSpacing) > 32767) throw new Error("Invalid swap pool tick spacing");
  if (typeof pool.hooks !== "string" || pool.hooks.toLowerCase() !== zeroAddress) throw new Error("Swap pool hooks are not supported");
  return {
    chainId: 11155111,
    ...parts,
    pool: { currency0, currency1, fee: Number(pool.fee), tickSpacing: Number(pool.tickSpacing), hooks: zeroAddress },
    codeHashes: Object.fromEntries(hashKeys.map((key) => [key, digest(hashes[key])])) as SwapDeployment["codeHashes"],
  };
}

/** Validate on-chain code and wiring before showing transaction controls. */
export async function verifySwapDeployment(client: AnonRpcClient, config: SwapDeployment): Promise<void> {
  const id = client.identities.publicScope("swap-deployment");
  const read = (method: string, params: unknown[]) => client.read(id, config.chainId, method, params);
  await Promise.all(hashKeys.map(async (key) => {
    const code = await read("eth_getCode", [config[key], "latest"]);
    if (typeof code !== "string" || !isHex(code) || code === "0x" || keccak256(code).toLowerCase() !== config.codeHashes[key].toLowerCase()) {
      throw new Error(`Swap deployment code mismatch: ${key}`);
    }
  }));
  async function call(to: Address, data: Hex): Promise<Hex> {
    const result = await read("eth_call", [{ to, data }, "latest"]);
    if (typeof result !== "string" || !isHex(result)) throw new Error("Invalid swap contract response");
    return result;
  }
  const batchRead = async (name: "VERSION" | "cTokenA" | "cTokenB" | "priceOracle" | "router" | "permit2" | "poolKey") =>
    decodeFunctionResult({ abi: batchAbi, functionName: name, data: await call(config.batch, encodeFunctionData({ abi: batchAbi, functionName: name })) });
  const [version, wrapperA, wrapperB, oracle, router, permit2, key] = await Promise.all([
    batchRead("VERSION"), batchRead("cTokenA"), batchRead("cTokenB"), batchRead("priceOracle"), batchRead("router"), batchRead("permit2"), batchRead("poolKey"),
  ]);
  if (version !== 4n || String(wrapperA).toLowerCase() !== config.wrapperA.toLowerCase() || String(wrapperB).toLowerCase() !== config.wrapperB.toLowerCase() ||
      String(oracle).toLowerCase() !== config.oracle.toLowerCase() || String(router).toLowerCase() !== config.router.toLowerCase() || String(permit2).toLowerCase() !== config.permit2.toLowerCase()) {
    throw new Error("Swap contract wiring mismatch");
  }
  if (!Array.isArray(key) || String(key[0]).toLowerCase() !== config.pool.currency0.toLowerCase() || String(key[1]).toLowerCase() !== config.pool.currency1.toLowerCase() ||
      Number(key[2]) !== config.pool.fee || Number(key[3]) !== config.pool.tickSpacing || String(key[4]).toLowerCase() !== zeroAddress) throw new Error("Swap contract pool mismatch");
  for (const [wrapper, token] of [[config.wrapperA, config.tokenA], [config.wrapperB, config.tokenB]] as const) {
    const underlying = decodeFunctionResult({ abi: wrapperAbi, functionName: "underlying", data: await call(wrapper, encodeFunctionData({ abi: wrapperAbi, functionName: "underlying" })) });
    const rate = decodeFunctionResult({ abi: wrapperAbi, functionName: "rate", data: await call(wrapper, encodeFunctionData({ abi: wrapperAbi, functionName: "rate" })) });
    const wrappedDecimals = decodeFunctionResult({ abi: wrapperAbi, functionName: "decimals", data: await call(wrapper, encodeFunctionData({ abi: wrapperAbi, functionName: "decimals" })) });
    const tokenDecimals = decodeFunctionResult({ abi: tokenAbi, functionName: "decimals", data: await call(token, encodeFunctionData({ abi: tokenAbi, functionName: "decimals" })) });
    if (underlying.toLowerCase() !== token.toLowerCase() || rate !== 10n ** 12n || wrappedDecimals !== 6 || tokenDecimals !== 18) throw new Error("Swap wrapper or token mismatch");
  }
}
