/**
 * Multicall3 `aggregate3` for ONE owner identity.
 *
 * Measured: 25 balanceOf reads went from 6.2 s (separate, 4 in flight) to
 * 1.55 s (one aggregate3) on publicnode, and it works on every provider,
 * unlike JSON-RPC batches.
 *
 * Privacy rule: an aggregate3 call carries one identity. The helper only
 * accepts an account or stealth identity, and the client's cross-identity
 * guard rejects calldata that names any other registered identity.
 */
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import type { AnonRpcClient } from "./client";
import { AnonRpcError } from "./errors";
import type { Identity } from "./identity";

export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MC3_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  "function getEthBalance(address addr) view returns (uint256 balance)",
  "function getBlockNumber() view returns (uint256 blockNumber)",
]);
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const BYTES32_SYMBOL_ABI = parseAbi(["function symbol() view returns (bytes32)"]);

export interface Call3 {
  target: Address;
  callData: Hex;
  allowFailure?: boolean;
}

export interface Call3Result {
  success: boolean;
  returnData: Hex;
}

export function encodeAggregate3(calls: readonly Call3[]): Hex {
  return encodeFunctionData({
    abi: MC3_ABI,
    functionName: "aggregate3",
    args: [calls.map((c) => ({ target: c.target, allowFailure: c.allowFailure ?? true, callData: c.callData }))],
  });
}

export function decodeAggregate3(data: Hex): Call3Result[] {
  const out = decodeFunctionResult({ abi: MC3_ABI, functionName: "aggregate3", data });
  return out.map((r) => ({ success: r.success, returnData: r.returnData }));
}

function assertOwner(owner: Identity): void {
  if (owner.kind !== "account" && owner.kind !== "stealth") {
    throw new AnonRpcError("aggregate3 is for one owner identity (account or stealth address)", "POLICY");
  }
}

/** eth_call params for one aggregate3 at `blockTag`, for use in client.batch(). */
export function aggregate3Read(owner: Identity, calls: readonly Call3[], blockTag: string) {
  assertOwner(owner);
  return { method: "eth_call", params: [{ to: MULTICALL3, data: encodeAggregate3(calls) }, blockTag] as const };
}

/** Runs aggregate3 for one owner, split into chunks of `maxCalls` (each chunk one request, same identity). */
export async function aggregate3(
  client: AnonRpcClient,
  owner: Identity,
  chainId: number,
  calls: readonly Call3[],
  blockTag: string,
  { maxCalls = 150 }: { maxCalls?: number } = {},
): Promise<Call3Result[]> {
  assertOwner(owner);
  const chunks: Call3[][] = [];
  for (let i = 0; i < calls.length; i += maxCalls) chunks.push(calls.slice(i, i + maxCalls));
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const data = await client.read<Hex>(owner, chainId, "eth_call", [{ to: MULTICALL3, data: encodeAggregate3(chunk) }, blockTag]);
      return decodeAggregate3(data);
    }),
  );
  return results.flat();
}

// ---- call builders and decoders ------------------------------------------

/** Owner address as the subject of an identity, checked. */
export function ownerAddress(owner: Identity): Address {
  assertOwner(owner);
  return `0x${owner.subject}` as Address;
}

export const calls = {
  ethBalance: (owner: Identity): Call3 => ({
    target: MULTICALL3,
    callData: encodeFunctionData({ abi: MC3_ABI, functionName: "getEthBalance", args: [ownerAddress(owner)] }),
  }),
  balanceOf: (token: Address, owner: Identity): Call3 => ({
    target: token,
    callData: encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [ownerAddress(owner)] }),
  }),
  /**
   * Multicall3 `getBlockNumber()`: names nothing, and makes an aggregate3 sent
   * at `latest` say which block its answers come from (so a first load need
   * not wait for a separate head read to pin a block).
   */
  blockNumber: (): Call3 => ({ target: MULTICALL3, callData: encodeFunctionData({ abi: MC3_ABI, functionName: "getBlockNumber" }) }),
  symbol: (token: Address): Call3 => ({ target: token, callData: encodeFunctionData({ abi: ERC20_ABI, functionName: "symbol" }) }),
  decimals: (token: Address): Call3 => ({ target: token, callData: encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" }) }),
};

export function decodeUint(r: Call3Result | undefined): bigint | undefined {
  if (!r?.success || r.returnData.length < 66) return undefined;
  return BigInt(r.returnData.slice(0, 66));
}

/** string symbol, falling back to bytes32 (MKR-style). */
export function decodeSymbol(r: Call3Result | undefined): string | undefined {
  if (!r?.success || r.returnData === "0x") return undefined;
  try {
    return decodeFunctionResult({ abi: ERC20_ABI, functionName: "symbol", data: r.returnData });
  } catch {
    try {
      const b = decodeFunctionResult({ abi: BYTES32_SYMBOL_ABI, functionName: "symbol", data: r.returnData });
      const bytes = (b.slice(2).match(/../g) ?? []).map((h) => parseInt(h, 16)).filter((x) => x !== 0);
      return new TextDecoder().decode(new Uint8Array(bytes));
    } catch {
      return undefined;
    }
  }
}
