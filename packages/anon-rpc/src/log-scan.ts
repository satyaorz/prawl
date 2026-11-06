/**
 * eth_getLogs over a long range, sized from the provider policy.
 *
 * Unlike wabl's scanLogs, only a range-limit answer shrinks the window (a
 * timeout or transport error is the client's retry business, not a reason to
 * halve), and a learned ceiling is remembered per chain for later scans.
 * Fails closed: a partial scan is never reported as complete.
 */
import type { AnonRpcClient } from "./client";
import { AnonRpcError } from "./errors";
import type { Identity } from "./identity";
import { DEFAULT_POLICY, type ProviderPolicy } from "./providers";

const RANGE_ERROR = /range|block limit|too many|exceed|max(imum)? .*block|10000|limit/i;
const learnedCeiling = new Map<number, number>();

export interface ScanOptions {
  policy?: ProviderPolicy;
  /** Override the starting window (defaults to the primary logs provider's measured range). */
  window?: number;
  minWindow?: number;
}

export interface ScanResult<T> {
  logs: T[];
  requests: number;
  ranges: Array<[bigint, bigint]>;
}

export async function scanLogs<T = unknown>(
  client: AnonRpcClient,
  identity: Identity,
  chainId: number,
  filter: { address?: string; topics?: unknown[] },
  fromBlock: bigint,
  toBlock: bigint,
  options: ScanOptions = {},
): Promise<ScanResult<T>> {
  const policy = options.policy ?? DEFAULT_POLICY;
  const primary = policy.chains[chainId]?.logs[0];
  const measured = primary ? policy.providers[primary]?.maxLogRange ?? 1_000 : 1_000;
  let window = BigInt(Math.min(options.window ?? measured, learnedCeiling.get(chainId) ?? Number.MAX_SAFE_INTEGER));
  const minWindow = BigInt(options.minWindow ?? 1_000);
  const out: ScanResult<T> = { logs: [], requests: 0, ranges: [] };
  let start = fromBlock;
  while (start <= toBlock) {
    const end = start + window - 1n < toBlock ? start + window - 1n : toBlock;
    out.requests += 1;
    try {
      const logs = await client.read<T[]>(identity, chainId, "eth_getLogs", [
        { ...filter, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` },
      ]);
      if (!Array.isArray(logs)) throw new AnonRpcError("eth_getLogs did not return a list", "INVALID_RESPONSE");
      out.logs.push(...logs);
      out.ranges.push([start, end]);
      start = end + 1n;
    } catch (error) {
      const isRange = error instanceof AnonRpcError && error.code === "RPC_ERROR" && RANGE_ERROR.test(error.message);
      if (!isRange || window <= minWindow) throw error;
      window = window / 2n < minWindow ? minWindow : window / 2n;
      learnedCeiling.set(chainId, Number(window));
    }
  }
  return out;
}
