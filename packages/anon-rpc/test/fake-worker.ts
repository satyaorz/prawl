import { AnonRpcClient, type ClientOptions } from "../src/client";
import type { AnonOptions, Trace, WorkerFactory, WorkerLike } from "../src/types";
import { WorkerHost, type HostEvent, type WorkerHostOptions } from "../src/worker-host";

export interface FakeCall {
  index: number;
  url: string;
  host: string;
  key: string | undefined;
  /** The whole anonOptions object the client passed. */
  anonOptions: AnonOptions | undefined;
  /** Identity part of the key (before `@provider#gen`). */
  identityKey: string | undefined;
  method: string;
  headers: Record<string, string>;
  body: string;
  json: unknown;
  signal: AbortSignal | undefined;
  workerIndex: number;
}

export type Behavior =
  | { json: unknown; status?: number; headers?: Record<string, string>; delayMs?: number }
  | { bytes: Uint8Array | string; status?: number; headers?: Record<string, string>; delayMs?: number }
  | { error: { code?: string; message: string; name?: string }; delayMs?: number }
  /** Never settles and ignores abort: the measured "silent hang". */
  | { hang: true }
  /** Headers arrive, the body never finishes. */
  | { stallBody: true; status?: number };

export type Handler = (call: FakeCall) => Behavior | Promise<Behavior>;

// Node loads its fetch internals lazily on the first Response; do it now so
// the first test's 40 ms deadlines measure the client, not module loading.
await new Response(new ReadableStream({ start: (c) => c.close() })).arrayBuffer();
await new Response(JSON.stringify({ warm: true }), { headers: { "content-type": "application/json" } }).json();

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Answers JSON-RPC by method: eth_chainId, eth_blockNumber, everything else `result: "0x1"`. */
export const okRpc: Handler = (call) => {
  const j = call.json as { method?: string; id?: number } | Array<{ id: number; method: string }>;
  if (Array.isArray(j)) return { json: j.map((x) => ({ jsonrpc: "2.0", id: x.id, result: "0x1" })) };
  if (j?.method === "eth_blockNumber") return { json: { jsonrpc: "2.0", id: 1, result: "0x1000" } };
  return { json: { jsonrpc: "2.0", id: j?.id ?? 1, result: "0x1" } };
};

export class FakeWorker implements WorkerLike {
  ready: Promise<void>;
  closed = false;
  readonly calls: FakeCall[] = [];
  bodyCancels = 0;
  inflight = 0;
  maxInflight = 0;
  readonly inflightByIdentity = new Map<string, number>();
  readonly maxInflightByIdentity = new Map<string, number>();
  resolveReady!: () => void;
  rejectReady!: (e: unknown) => void;

  constructor(
    private readonly handler: Handler,
    private readonly log: FakeCall[],
    readonly index: number,
    readonly bootstrap: Uint8Array | undefined,
  ) {
    this.ready = new Promise<void>((res, rej) => {
      this.resolveReady = res;
      this.rejectReady = rej;
    });
    this.ready.catch(() => undefined);
  }

  close(): void {
    this.closed = true;
  }

  async fetch(url: string, init: RequestInit & { anonOptions?: AnonOptions }): Promise<Response> {
    if (this.closed) throw Object.assign(new Error("worker closed"), { name: "Error" });
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init.body === "string" ? init.body : "";
    let json: unknown;
    try {
      json = body ? JSON.parse(body) : undefined;
    } catch {
      json = undefined;
    }
    const key = init.anonOptions?.isolationKey;
    const identityKey = key?.split("@")[0];
    const call: FakeCall = {
      index: this.log.length,
      url,
      host: new URL(url).host,
      key,
      anonOptions: init.anonOptions,
      identityKey,
      method: init.method ?? "GET",
      headers,
      body,
      json,
      signal: init.signal ?? undefined,
      workerIndex: this.index,
    };
    this.calls.push(call);
    this.log.push(call);
    const id = identityKey ?? "none";
    this.inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    const n = (this.inflightByIdentity.get(id) ?? 0) + 1;
    this.inflightByIdentity.set(id, n);
    this.maxInflightByIdentity.set(id, Math.max(this.maxInflightByIdentity.get(id) ?? 0, n));
    const done = () => {
      this.inflight -= 1;
      this.inflightByIdentity.set(id, (this.inflightByIdentity.get(id) ?? 1) - 1);
    };
    try {
      const b = await this.handler(call);
      if ("hang" in b) return await new Promise<never>(() => undefined);
      if ("delayMs" in b && b.delayMs) await sleep(b.delayMs);
      if ("error" in b) {
        throw Object.assign(new Error(b.error.message), { name: b.error.name ?? "Error", code: b.error.code });
      }
      if ("stallBody" in b) {
        const self = this;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'));
          },
          cancel() {
            self.bodyCancels += 1;
          },
        });
        return new Response(stream, { status: b.status ?? 200 });
      }
      const payload = "json" in b ? JSON.stringify(b.json) : b.bytes;
      return new Response(payload as BodyInit, { status: b.status ?? 200, headers: b.headers ?? { "content-type": "application/json" } });
    } finally {
      done();
    }
  }
}

export type ReadyPlan = "resolve" | "never" | "reject" | number; // number = resolve after ms

export function fakeFactory(handler: Handler, readyPlan: ReadyPlan[] = ["resolve"]) {
  const log: FakeCall[] = [];
  const workers: FakeWorker[] = [];
  const factory: WorkerFactory = ({ bootstrap }) => {
    const w = new FakeWorker(handler, log, workers.length, bootstrap);
    const plan = readyPlan[Math.min(workers.length, readyPlan.length - 1)]!;
    workers.push(w);
    if (plan === "resolve") queueMicrotask(() => w.resolveReady());
    else if (plan === "reject") queueMicrotask(() => w.rejectReady(new Error("boot failed: gateway refused")));
    else if (typeof plan === "number") setTimeout(() => w.resolveReady(), plan);
    return w;
  };
  return { factory, workers, log };
}

export interface Setup {
  client: AnonRpcClient;
  host: WorkerHost;
  traces: Trace[];
  events: HostEvent[];
  workers: FakeWorker[];
  log: FakeCall[];
}

export function setup(
  handler: Handler = okRpc,
  opts: {
    ready?: ReadyPlan[];
    host?: Partial<WorkerHostOptions>;
    client?: Partial<ClientOptions>;
  } = {},
): Setup {
  const { factory, workers, log } = fakeFactory(handler, opts.ready);
  const events: HostEvent[] = [];
  const host = new WorkerHost({
    factory,
    bootDeadlineMs: 150,
    drainMs: 50,
    onEvent: (e) => events.push(e),
    ...opts.host,
  });
  const traces: Trace[] = [];
  const client = new AnonRpcClient({
    host,
    deadlines: { headersMs: 40, totalMs: 80 },
    scheduler: { switchJitterMs: [0, 0] },
    prewarmChainId: false,
    onTrace: (t) => traces.push(t),
    ...opts.client,
  });
  return { client, host, traces, events, workers, log };
}

export const ADDR_A = "0x00000000000000000000000000000000000000aa";
export const ADDR_B = "0x00000000000000000000000000000000000000bb";
export const BURN = "0x000000000000000000000000000000000000dEaD";
export const TX_1 = `0x${"11".repeat(32)}`;
