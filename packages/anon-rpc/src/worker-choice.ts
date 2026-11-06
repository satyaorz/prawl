/**
 * Which tor-js worker bundle the client boots, chosen by config.
 *
 * Every choice is a keccak-named file served from our own origin at
 * `/anon-rpc/worker-0x<keccak>.js`. The harness reads two values from the
 * specifier contract (`workerHash()` and `workerResolvers()`); the pinned
 * specifier below answers both locally, for the chosen hash only, with only
 * our own URL listed. No resolver, CDN or bootstrap RPC is contacted, and the
 * harness still re-checks the keccak of the bytes it downloads, so a wrong or
 * tampered file fails closed.
 *
 * Node-safe (no browser imports), so it is unit-tested directly.
 */
import { encodeAbiParameters, toFunctionSelector, type Hex } from "viem";

export const SPECIFIER_ADDRESS = "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e";

export interface WorkerBuild {
  /** keccak256 of the bundle bytes, 0x-prefixed. */
  hash: string;
  description: string;
}

/**
 * Known builds.
 *  - stock: upstream tor-js 0.4.4, the hash published on the specifier.
 *  - fork: our keep-alive fork (vendor/torjs-worker), idle cap 8 per
 *    (key, origin). Our own unaudited, non-reproducible build: nothing on-chain
 *    names this hash.
 *  - fork-cap4: the first fork build, idle cap 4. Kept for comparison.
 *  - fork-v3: cap 8, plus a 4-minute connection age (was 5) and a 5 s
 *    response-head deadline for replayable requests on a reused connection,
 *    resent once on a fresh connection under the same key; requests that may
 *    not be repeated never take a pooled connection (vendor/torjs-worker).
 *    Same caveats as `fork`.
 */
export const WORKER_BUILDS = {
  stock: {
    hash: "0x5b62f358ce7a2b94ee9bc3a0e6a08757db68fa08fc348276f31eda788aec818b",
    description: "tor-js 0.4.4 (upstream)",
  },
  fork: {
    hash: "0x3229c9ebfd42ea0b8c6ab6f101d920f9a5b674b04d92328ef931c33297199436",
    description: "tor-js 0.4.4 + keep-alive fork, idle cap 8 per (key, origin)",
  },
  "fork-cap4": {
    hash: "0x23cb6c8d580b26e8a054fcd6840e62631f06b4cb2c24253e14f2f886b3761ebc",
    description: "tor-js 0.4.4 + keep-alive fork, idle cap 4 per (key, origin)",
  },
  "fork-v3": {
    hash: "0x65de36bd50200d9b988a7a81b8da63186cb9efc3ab54c0dbef1f71825df3d744",
    description: "tor-js 0.4.4 + keep-alive fork, cap 8, 4 min max age, 5 s stall deadline on reused connections",
  },
} as const satisfies Record<string, WorkerBuild>;

export type WorkerName = keyof typeof WORKER_BUILDS;

/** A named build, or any other keccak-named bundle we serve ourselves. */
export type WorkerChoice = WorkerName | { hash: string };

export const DEFAULT_WORKER: WorkerName = "stock";

const HASH_RE = /^0x[0-9a-f]{64}$/;

export interface ResolvedWorker {
  name: WorkerName | "custom";
  hash: string;
  /** Absolute URL of our own copy of the bundle. */
  bundleUrl: string;
}

/** The chosen build's hash and the URL of our local copy on `origin`. */
export function resolveWorker(choice: WorkerChoice | undefined, origin: string): ResolvedWorker {
  const picked = choice ?? DEFAULT_WORKER;
  let name: WorkerName | "custom";
  let hash: string;
  if (typeof picked === "string") {
    if (!Object.hasOwn(WORKER_BUILDS, picked)) throw new Error(`unknown worker build "${picked}"`);
    name = picked;
    hash = WORKER_BUILDS[picked].hash;
  } else {
    name = "custom";
    hash = picked.hash.toLowerCase();
  }
  if (!HASH_RE.test(hash)) throw new Error(`worker hash must be 0x + 64 hex, got ${hash}`);
  const base = new URL(origin);
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("worker origin must be http(s)");
  return { name, hash, bundleUrl: new URL(`/anon-rpc/worker-${hash}.js`, base.origin).href };
}

const SEL_HASH = toFunctionSelector("workerHash()");
const SEL_RESOLVERS = toFunctionSelector("workerResolvers()");

/**
 * An EIP-1193-shaped provider that answers only the harness's two specifier
 * reads, for one hash and one bundle URL. Anything else throws.
 */
export function pinnedSpecifier(bundleUrl: string, workerHash: string, address: string = SPECIFIER_ADDRESS) {
  if (!HASH_RE.test(workerHash.toLowerCase())) throw new Error("pinned specifier: bad hash");
  return {
    async request({ method, params }: { method: string; params?: readonly unknown[] }): Promise<unknown> {
      if (method === "eth_chainId") return "0x1";
      if (method !== "eth_call") throw new Error(`pinned specifier does not serve ${method}`);
      const [call] = (params ?? []) as [{ to?: string; data?: string }];
      if (call?.to?.toLowerCase() !== address.toLowerCase()) throw new Error("pinned specifier: wrong address");
      if (call.data === SEL_HASH) return encodeAbiParameters([{ type: "bytes32" }], [workerHash as Hex]);
      if (call.data === SEL_RESOLVERS) return encodeAbiParameters([{ type: "string[]" }], [[bundleUrl]]);
      throw new Error("pinned specifier: unknown call");
    },
  };
}
