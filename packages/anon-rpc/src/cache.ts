/**
 * In-flight dedupe for identical reads pinned to a block number or hash, and
 * a small LRU for results that cannot change: pinned at or below the
 * finalized block, pinned by block hash, or immutable (eth_chainId).
 *
 * Only identical method + params + chain dedupe. Identical bodies cannot
 * carry two different identities, and a deduped caller sends nothing, so
 * sharing an answer leaks nothing to the network. Errors are never cached.
 * The cache is in memory only; nothing is written to storage.
 */
export type BlockRef =
  | { kind: "number"; n: bigint }
  | { kind: "hash" }
  | { kind: "immutable" };

/** Index of the block parameter for each pinnable method. */
const BLOCK_PARAM: Record<string, number> = {
  eth_call: 1,
  eth_getBalance: 1,
  eth_getCode: 1,
  eth_getTransactionCount: 1,
  eth_getStorageAt: 2,
  eth_getProof: 2,
  eth_getBlockByNumber: 0,
};

const QUANTITY = /^0x[0-9a-fA-F]+$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

export function blockRefOf(method: string, params: readonly unknown[] = []): BlockRef | undefined {
  if (method === "eth_chainId") return { kind: "immutable" };
  if (method === "eth_getBlockByHash") return { kind: "hash" };
  if (method === "eth_getLogs") {
    const f = (params[0] ?? {}) as { fromBlock?: unknown; toBlock?: unknown; blockHash?: unknown };
    if (typeof f.blockHash === "string" && HASH.test(f.blockHash)) return { kind: "hash" };
    if (typeof f.fromBlock === "string" && typeof f.toBlock === "string" && QUANTITY.test(f.fromBlock) && QUANTITY.test(f.toBlock)) {
      return { kind: "number", n: BigInt(f.toBlock) };
    }
    return undefined;
  }
  const index = BLOCK_PARAM[method];
  if (index === undefined) return undefined;
  const tag = params[index];
  if (typeof tag === "string") {
    if (HASH.test(tag)) return { kind: "hash" };
    if (QUANTITY.test(tag)) return { kind: "number", n: BigInt(tag) };
    return undefined; // latest, pending, safe, finalized: moving targets
  }
  if (tag && typeof tag === "object") {
    const t = tag as { blockHash?: unknown; blockNumber?: unknown };
    if (typeof t.blockHash === "string" && HASH.test(t.blockHash)) return { kind: "hash" };
    if (typeof t.blockNumber === "string" && QUANTITY.test(t.blockNumber)) return { kind: "number", n: BigInt(t.blockNumber) };
  }
  return undefined;
}

export class ReadCache {
  readonly #inflight = new Map<string, Promise<unknown>>();
  readonly #lru = new Map<string, unknown>();
  readonly #max: number;
  readonly stats = { hits: 0, deduped: 0, misses: 0 };

  constructor(maxEntries = 512) {
    this.#max = maxEntries;
  }

  /**
   * Runs `fn` unless an identical pinned read is in flight (join it) or
   * cached (return it). `cacheable` decides whether the result is kept.
   */
  async run<T>(key: string, cacheable: boolean, fn: () => Promise<T>): Promise<T> {
    if (this.#lru.has(key)) {
      const v = this.#lru.get(key);
      this.#lru.delete(key);
      this.#lru.set(key, v);
      this.stats.hits += 1;
      return structuredClone(v) as T;
    }
    const pending = this.#inflight.get(key);
    if (pending) {
      this.stats.deduped += 1;
      return structuredClone(await pending) as T;
    }
    this.stats.misses += 1;
    const p = fn();
    this.#inflight.set(key, p);
    try {
      const value = await p;
      if (cacheable) {
        this.#lru.set(key, value);
        while (this.#lru.size > this.#max) this.#lru.delete(this.#lru.keys().next().value!);
      }
      return value;
    } finally {
      this.#inflight.delete(key);
    }
  }

  clear(): void {
    this.#lru.clear();
  }
}

export function readKey(chainId: number, method: string, params: readonly unknown[] = []): string {
  return `${chainId}|${method}|${JSON.stringify(params, (_k, v) => (typeof v === "string" && /^0x/i.test(v) ? v.toLowerCase() : v))}`;
}
