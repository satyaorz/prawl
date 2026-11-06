/**
 * Provider policy per chain and method, from the 2026-11-06 measurements over
 * Tor (research_notes/Anon RPC live comparison, section 5):
 *
 *  - Tenderly: 403 to 4 of 5 exits on both chains. Banned.
 *  - Flashbots: returned 0 logs where two others agreed on 4; eth_call is not
 *    whitelisted. Banned for logs (and not used for reads at all).
 *  - publicnode mainnet: logs only up to 1k blocks, no archive; batch of 10 OK.
 *  - dRPC mainnet: batch capped at 3, no logs on the free plan; proofs OK.
 *  - MEV Blocker: the only keyless deep-log source on mainnet (2M on 2/5 exits).
 *  - onfinality Sepolia: deep logs 5/5 up to 2M; 429 on every batch.
 *  - publicnode Sepolia: logs up to 10k; batch OK.
 *  - Pimlico public bundler: read-only methods answered 10/10.
 *
 * Failover is sequential, in this fixed order, only after a failure, and a
 * failover target gets its own circuit (the provider id is part of the key).
 * There is no direct (non-worker) path anywhere in this client.
 */
import { AnonRpcError } from "./errors";

export interface Provider {
  id: string;
  url: string;
  chainId: number;
  /** Largest JSON-RPC batch the provider accepted over Tor; 0 means no batches. */
  maxBatch: number;
  /** Largest eth_getLogs block range that worked; 0 means do not use for logs. */
  maxLogRange: number;
}

export type Route = "read" | "logs" | "proofs" | "bundler" | "broadcast";

export interface ChainPolicy {
  /** Ordered failover lists. The first entry is the primary. */
  read: string[];
  logs: string[];
  proofs: string[];
  bundler: string[];
  broadcast: string[];
}

export interface ProviderPolicy {
  providers: Record<string, Provider>;
  chains: Record<number, ChainPolicy>;
}

export const MAINNET = 1;
export const SEPOLIA = 11_155_111;

export const DEFAULT_POLICY: ProviderPolicy = {
  providers: {
    "publicnode-mainnet": { id: "publicnode-mainnet", url: "https://ethereum-rpc.publicnode.com", chainId: MAINNET, maxBatch: 10, maxLogRange: 1_000 },
    "drpc-mainnet": { id: "drpc-mainnet", url: "https://eth.drpc.org", chainId: MAINNET, maxBatch: 3, maxLogRange: 0 },
    "mevblocker-mainnet": { id: "mevblocker-mainnet", url: "https://rpc.mevblocker.io", chainId: MAINNET, maxBatch: 10, maxLogRange: 2_000_000 },
    "pimlico-mainnet": { id: "pimlico-mainnet", url: "https://public.pimlico.io/v2/1/rpc", chainId: MAINNET, maxBatch: 2, maxLogRange: 0 },
    "publicnode-sepolia": { id: "publicnode-sepolia", url: "https://ethereum-sepolia-rpc.publicnode.com", chainId: SEPOLIA, maxBatch: 10, maxLogRange: 10_000 },
    "onfinality-sepolia": { id: "onfinality-sepolia", url: "https://eth-sepolia.api.onfinality.io/public", chainId: SEPOLIA, maxBatch: 0, maxLogRange: 2_000_000 },
    "pimlico-sepolia": { id: "pimlico-sepolia", url: "https://public.pimlico.io/v2/11155111/rpc", chainId: SEPOLIA, maxBatch: 2, maxLogRange: 0 },
  },
  chains: {
    [MAINNET]: {
      read: ["publicnode-mainnet", "drpc-mainnet", "mevblocker-mainnet"],
      // publicnode serves up to 1k blocks; anything deeper goes to MEV Blocker only.
      logs: ["publicnode-mainnet", "mevblocker-mainnet"],
      proofs: ["publicnode-mainnet", "drpc-mainnet", "mevblocker-mainnet"],
      bundler: ["pimlico-mainnet"],
      broadcast: ["mevblocker-mainnet"],
    },
    [SEPOLIA]: {
      read: ["publicnode-sepolia", "onfinality-sepolia"],
      logs: ["onfinality-sepolia", "publicnode-sepolia"],
      proofs: ["onfinality-sepolia", "publicnode-sepolia"],
      bundler: ["pimlico-sepolia"],
      broadcast: ["publicnode-sepolia"],
    },
  },
};

/** Hosts that must never appear anywhere in a policy. */
const BANNED_HOSTS = [/(^|\.)tenderly\.co$/i];
/** Hosts that must never serve eth_getLogs (silent wrong answers). */
const BANNED_FOR_LOGS = [/(^|\.)flashbots\.net$/i];

export const READ_METHODS: ReadonlySet<string> = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getProof",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_simulateV1",
  // Read-only bundler methods.
  "eth_supportedEntryPoints",
  "eth_estimateUserOperationGas",
  "eth_getUserOperationReceipt",
  "pimlico_getUserOperationGasPrice",
]);

export const WRITE_METHODS: ReadonlySet<string> = new Set(["eth_sendRawTransaction", "eth_sendUserOperation"]);

const BUNDLER_METHODS: ReadonlySet<string> = new Set([
  "eth_supportedEntryPoints",
  "eth_estimateUserOperationGas",
  "eth_getUserOperationReceipt",
  "pimlico_getUserOperationGasPrice",
  "eth_sendUserOperation",
]);

export function routeFor(method: string): Route {
  if (method === "eth_getLogs") return "logs";
  if (method === "eth_getProof") return "proofs";
  if (BUNDLER_METHODS.has(method)) return "bundler";
  if (method === "eth_sendRawTransaction") return "broadcast";
  return "read";
}

/** Throws POLICY on a banned host, a non-https URL, or an unknown provider id. */
export function validatePolicy(policy: ProviderPolicy): void {
  for (const p of Object.values(policy.providers)) {
    let url: URL;
    try {
      url = new URL(p.url);
    } catch {
      throw new AnonRpcError(`provider ${p.id}: invalid URL`, "POLICY");
    }
    if (url.protocol !== "https:") throw new AnonRpcError(`provider ${p.id}: https only`, "POLICY");
    if (BANNED_HOSTS.some((re) => re.test(url.hostname))) {
      throw new AnonRpcError(`provider ${p.id}: ${url.hostname} is banned (blocks Tor exits)`, "POLICY");
    }
  }
  for (const [chain, routes] of Object.entries(policy.chains)) {
    for (const [route, ids] of Object.entries(routes) as [Route, string[]][]) {
      for (const id of ids) {
        const p = policy.providers[id];
        if (!p) throw new AnonRpcError(`chain ${chain} ${route}: unknown provider ${id}`, "POLICY");
        if (p.chainId !== Number(chain)) {
          throw new AnonRpcError(`chain ${chain} ${route}: ${id} serves chain ${p.chainId}`, "POLICY");
        }
        if (route === "logs" && BANNED_FOR_LOGS.some((re) => re.test(new URL(p.url).hostname))) {
          throw new AnonRpcError(`${id} must not serve eth_getLogs`, "POLICY");
        }
      }
    }
  }
}

/** Block range of an eth_getLogs filter, or undefined when it uses tags. */
export function logRange(params: readonly unknown[] | undefined): number | undefined {
  const filter = (params?.[0] ?? {}) as { fromBlock?: unknown; toBlock?: unknown; blockHash?: unknown };
  if (typeof filter.blockHash === "string") return 1;
  const from = quantity(filter.fromBlock);
  const to = quantity(filter.toBlock);
  if (from === undefined || to === undefined) return undefined;
  return Number(to - from + 1n);
}

function quantity(v: unknown): bigint | undefined {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) return undefined;
  return BigInt(v);
}

/**
 * Ordered providers for one request. For logs, providers whose measured range
 * is smaller than the request are dropped (an unknown range counts as 1k).
 * For a batch, providers that refuse a batch of that size are dropped.
 */
export function providersFor(
  policy: ProviderPolicy,
  chainId: number,
  method: string,
  params?: readonly unknown[],
  batchSize?: number,
): Provider[] {
  const chain = policy.chains[chainId];
  if (!chain) throw new AnonRpcError(`chain ${chainId} is not configured`, "POLICY");
  const route = routeFor(method);
  let list = chain[route].map((id) => policy.providers[id]!).filter(Boolean);
  if (route === "logs") {
    const range = logRange(params) ?? 1_000;
    list = list.filter((p) => p.maxLogRange >= range);
  }
  if (batchSize !== undefined && batchSize > 1) {
    list = list.filter((p) => p.maxBatch >= batchSize);
  }
  return list;
}
