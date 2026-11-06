/// <reference lib="webworker" />
/**
 * RAILGUN worker. Runs kohaku-railgun-wasm off the UI thread. Its global
 * `fetch` is replaced by a bridge to the page, where every request goes out
 * over Anon-RPC (Tor). Same-origin requests (the wasm itself, a local artifact
 * mirror) use the real fetch; nothing else ever does.
 *
 * Keys arrive in an `open` message and live only in this worker's memory.
 * Checkpoints are sealed here with the wallet's storage key before storage.
 */
import { seal, open as openSealed, type Sealed } from "@prawl/keys";
import { RailgunWallet, isPublicSnapshot, seedFreshAccount, snapshotBlock, type RailgunWasm } from "@prawl/railgun";
import { store } from "../lib/store";
import type { FromWorker, OpenArgs, Ops, ToWorker } from "./protocol";

type ArgsOf<K extends keyof Ops> = Parameters<Ops[K]>[0];

declare const self: DedicatedWorkerGlobalScope;

const realFetch = self.fetch.bind(self);
const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

// ------------------------------------------------------------- fetch bridge
let fetchSeq = 0;
const pendingFetches = new Map<number, { resolve: (r: Response) => void; reject: (e: unknown) => void }>();

async function bridgedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  if (url.origin === self.location.origin) return realFetch(request);
  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
  const id = ++fetchSeq;
  const headers: [string, string][] = [];
  request.headers.forEach((v, k) => headers.push([k, v]));
  const signal = init?.signal ?? request.signal;
  return new Promise<Response>((resolve, reject) => {
    pendingFetches.set(id, { resolve, reject });
    signal?.addEventListener("abort", () => {
      pendingFetches.delete(id);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
    post({ t: "fetch", id, url: url.href, method: request.method, headers, body }, body ? [body] : []);
  });
}
self.fetch = bridgedFetch as typeof fetch;

// ------------------------------------------------------------------- wasm
let wasmPromise: Promise<RailgunWasm> | undefined;
function loadWasm(): Promise<RailgunWasm> {
  wasmPromise ??= (async () => {
    const glue = "/railgun/kohaku_railgun_wasm.js";
    const mod = (await import(/* @vite-ignore */ glue)) as RailgunWasm & { default: (input: unknown) => Promise<unknown> };
    await mod.default({ module_or_path: "/railgun/kohaku_railgun_wasm_bg.wasm" });
    return mod;
  })();
  return wasmPromise;
}

/** Our own public pool snapshot (same origin). Anything that is not a clean public snapshot is ignored. */
async function loadSnapshot(chainId: number): Promise<string | undefined> {
  try {
    const res = await realFetch(`/railgun/snapshot-${chainId}.json`, { credentials: "omit" });
    if (!res.ok) return undefined;
    const text = await res.text();
    return isPublicSnapshot(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A snapshot taken this long before the wallet was born is safe to start a
 * restore from: covers clock skew between the creating device and the chain.
 */
const SNAPSHOT_SLACK_S = 2 * 3600;

/** Block timestamp over the RAILGUN transport (so over Tor, on the shared RAILGUN circuit). */
async function blockTimestamp(rpcUrl: string, block: bigint): Promise<number | undefined> {
  const res = await self.fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [`0x${block.toString(16)}`, false] }),
  });
  const body = (await res.json()) as { result?: { timestamp?: string } };
  const ts = body.result?.timestamp;
  return ts ? Number(BigInt(ts)) : undefined;
}

// ------------------------------------------------------------------ state
let wallet: RailgunWallet | undefined;
let storageKey: CryptoKey | undefined;
let checkpointName = "";

async function saveCheckpoint(plaintext: string): Promise<void> {
  if (!storageKey) return;
  await store.set(checkpointName, await seal(storageKey, checkpointName, plaintext));
}

const ops: { [K in keyof Ops]: (args: never) => Promise<ReturnType<Ops[K]>> } = {
  async deployment(chainId: number) {
    const wasm = await loadWasm();
    const c = wasm.Chain.fromChainId(BigInt(chainId));
    if (!c) throw new Error(`RAILGUN has no deployment on chain ${chainId}`);
    try {
      return {
        chainId,
        deploymentBlock: c.deploymentBlock.toString(),
        smartWallet: c.railgunSmartWallet,
        wrappedBaseToken: c.wrappedBaseToken,
        unshieldFeeBps: c.unshieldFeeBps,
        subsquidEndpoint: c.subsquidEndpoint,
        poiEndpoint: c.poiEndpoint,
      };
    } finally {
      c.free();
    }
  },

  async open(args: OpenArgs) {
    const wasm = await loadWasm();
    await wallet?.close();
    storageKey = args.storageKey;
    checkpointName = args.checkpointName;
    if (args.discardCheckpoint) await store.delete(checkpointName);
    const sealed = await store.get<Sealed>(checkpointName);
    let checkpoint: string | undefined;
    if (sealed) {
      try {
        checkpoint = await openSealed(storageKey, checkpointName, sealed);
      } catch {
        checkpoint = undefined; // other wallet or corrupt: resync
      }
    }
    let fromSnapshot: bigint | undefined;
    let expectedAddress: string | undefined;
    if (!checkpoint && (args.fresh || args.bornAt !== undefined)) {
      const snap = await loadSnapshot(args.chainId);
      const block = snap ? snapshotBlock(snap) : undefined;
      // A new wallet cannot own older notes. A restored one can skip history
      // from before it was born: use the snapshot only if it is clearly older.
      let usable = args.fresh;
      if (!usable && block !== undefined && args.bornAt !== undefined) {
        const ts = await blockTimestamp(args.rpcUrl, block).catch(() => undefined);
        usable = ts !== undefined && ts + SNAPSHOT_SLACK_S <= args.bornAt;
      }
      if (snap && usable) {
        const addr = wasm.RailgunAddress.fromPrivateKeys(args.spendingKey, args.viewingKey, BigInt(args.chainId));
        expectedAddress = addr.toString();
        addr.free();
        checkpoint = seedFreshAccount(snap, expectedAddress);
        fromSnapshot = block;
      }
    }
    const openWith = (cp: string | undefined) =>
      RailgunWallet.open({
        wasm,
        chainId: args.chainId,
        rpcUrl: args.rpcUrl,
        spendingKey: args.spendingKey,
        viewingKey: args.viewingKey,
        ...(cp ? { checkpoint: cp } : {}),
      });
    wallet = await openWith(checkpoint);
    if (expectedAddress !== undefined && wallet.address !== expectedAddress) {
      // The seeded account is not this wallet's: never trust the snapshot, do a full sync.
      await wallet.close();
      fromSnapshot = undefined;
      checkpoint = undefined;
      wallet = await openWith(undefined);
    }
    if (fromSnapshot !== undefined) await saveCheckpoint(await wallet.checkpoint());
    return {
      address: wallet.address,
      syncedBlock: wallet.syncedBlock.toString(),
      restored: !!checkpoint && fromSnapshot === undefined,
      fullScan: !checkpoint,
      ...(fromSnapshot !== undefined ? { snapshotBlock: fromSnapshot.toString() } : {}),
    };
  },

  async sync(args: { head: string; windowBlocks?: string }) {
    const w = need();
    await w.sync({
      head: BigInt(args.head),
      ...(args.windowBlocks ? { windowBlocks: BigInt(args.windowBlocks) } : {}),
      onCheckpoint: saveCheckpoint,
      onProgress: (p) =>
        post({ t: "progress", progress: { from: p.from.toString(), to: p.to.toString(), synced: p.synced.toString(), head: p.head.toString(), ms: p.ms } }),
    });
    return { syncedBlock: w.syncedBlock.toString() };
  },

  async refreshPoi() {
    await need().refreshPoi();
    await saveCheckpoint(await need().checkpoint());
  },

  poiPendingCount: async () => (await need().poiPending()).length,

  async processPendingPoi() {
    const w = need();
    const report = await w.processPendingPoi();
    await saveCheckpoint(await w.checkpoint()); // the queue shrank, or retry state changed
    return report;
  },

  balances: async () => need().balances(),
  notes: async () => need().notes(),

  async buildShield(args: { recipient: string; items: Array<{ token: "native" | `0x${string}`; amount: string }> }) {
    return need().buildShield(args.recipient, args.items.map((i) => ({ token: i.token, amount: BigInt(i.amount) })));
  },

  async prepareTransfer(args: ArgsOf<"prepareTransfer">) {
    const w = need();
    const out = await w.prepareTransfer({ ...args, amount: BigInt(args.amount) });
    await saveCheckpoint(await w.checkpoint()); // keeps the pending PPOI proof
    return out;
  },

  async prepareUnshield(args: ArgsOf<"prepareUnshield">) {
    const w = need();
    const out = await w.prepareUnshield({ ...args, amount: BigInt(args.amount) });
    await saveCheckpoint(await w.checkpoint());
    return out;
  },

  async close() {
    await wallet?.close();
    wallet = undefined;
    storageKey = undefined;
  },
};

function need(): RailgunWallet {
  if (!wallet) throw new Error("RAILGUN wallet is not open");
  return wallet;
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  if (m.t === "fetch-result") {
    const p = pendingFetches.get(m.id);
    if (!p) return;
    pendingFetches.delete(m.id);
    if (!m.ok) {
      p.reject(new TypeError(m.error));
      return;
    }
    const res = new Response(m.status === 204 || m.status === 304 ? null : m.body, { status: m.status, statusText: m.statusText, headers: m.headers });
    Object.defineProperty(res, "url", { value: m.url });
    p.resolve(res);
    return;
  }
  if (m.t === "call") {
    try {
      const fn = ops[m.op] as (a: unknown) => Promise<unknown>;
      const value = await fn(m.args);
      post({ t: "result", id: m.id, ok: true, value });
    } catch (e) {
      post({ t: "result", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
};
