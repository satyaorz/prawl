/**
 * Prawl's Anon-RPC client.
 *
 * Every request (JSON-RPC read, JSON-RPC batch, write, HTTP GET/POST) goes
 * through one private path, `#send`, which:
 *   1. checks the identity handle came from this client's registry, and that
 *      the URL and body name no other registered identity;
 *   2. takes a slot from the scheduler (per-identity and global limits);
 *   3. acquires a ready worker (the boot deadline lives in WorkerHost);
 *   4. sends one attempt with per-request deadlines and a circuit key
 *      `${identity}@${provider}#${generation}`;
 *   5. on a retryable failure (timeouts, CONNECTION, TLS, HTTP_REQUEST,
 *      IO_ERROR, HTTP 403/429/5xx, or an exit-side Arti kind) retries once on
 *      a fresh circuit, then, if allowed, fails over once to the next
 *      provider in the fixed order. A destination answer such as
 *      RemoteConnectionRefused keeps the circuit and skips straight to the
 *      next provider. Writes get exactly one attempt. JSON-RPC errors are
 *      answers and are never retried;
 *   6. emits one trace per attempt.
 *
 * Reads and GETs carry `anonOptions.idempotent: true`, so a keep-alive worker
 * may resend them once on a fresh connection if a pooled connection died
 * under them. Writes never carry it, so no worker can send them twice.
 * Slow reads (deep eth_getLogs, raised HTTP deadlines) also carry
 * `reusedHeadersTimeoutMs: 0`, so fork v3's 5 s stall deadline on reused
 * connections never cuts a legitimately slow answer.
 *
 * Time to first answer (2026-11-06): `start()` pre-warms with the shared head
 * read itself (public scope, no address), and `blockTag()` never waits for a
 * head: with no fresh head it returns "latest", so an identity's first batch
 * goes out the moment the worker is ready. At boot Arti has no circuit yet and
 * hands the first one (about 0.8 s after ready) to whichever isolated request
 * asked first; the others wait 2-3 s for their own. So with `bootPriority`,
 * head reads that reach the worker while an account or stealth identity's
 * first request is still unanswered wait (at most `headDeferMs`) until it has
 * its answer: the user's data gets the first circuit. `warm(identity)` opens
 * an identity's own circuit with a neutral eth_chainId before its first read.
 *
 * There is no direct-network code path: the only thing that sends bytes is
 * the worker handed out by WorkerHost.
 */
import { blockRefOf, readKey, ReadCache } from "./cache";
import { fetchWithDeadlines, safeHost, type RawResponse } from "./deadlines";
import { AnonRpcError, EXIT_SIDE_TOR_KINDS, isRetryableStatus, retryAction, TIMEOUT_CODES, TRANSPORT_CODES } from "./errors";
import { IdentityRegistry, type Identity } from "./identity";
import {
  DEFAULT_POLICY,
  MAINNET,
  providersFor,
  READ_METHODS,
  routeFor,
  validatePolicy,
  WRITE_METHODS,
  type ProviderPolicy,
} from "./providers";
import { Scheduler, type SchedulerOptions } from "./scheduler";
import { DEFAULT_DEADLINES, type AnonOptions, type Deadlines, type RequestKind, type Trace, type TraceSink } from "./types";
import type { WorkerHost } from "./worker-host";

/** Sent on every request instead of the browser's real user agent. */
export const ANON_USER_AGENT = "Mozilla/5.0";

export interface ClientOptions {
  host: WorkerHost;
  policy?: ProviderPolicy;
  deadlines?: Partial<Deadlines>;
  scheduler?: SchedulerOptions;
  /** Fail over to the next provider after a request failed twice. Disclose this to users. */
  failover?: boolean;
  /** Exact hosts (host[:port]) that http() may reach. */
  httpHosts?: readonly string[];
  onTrace?: TraceSink;
  userAgent?: string;
  cacheEntries?: number;
  /** Blocks behind head treated as final, per chain (default 96). */
  finalityDepth?: Record<number, number>;
  headTtlMs?: number;
  /** Chain whose first read provider gets the neutral pre-warm request; false disables. */
  prewarmChainId?: number | false;
  /**
   * What the pre-warm sends. "head" (default): the chain's shared head read
   * (eth_blockNumber on the public `head:<chain>` scope), so the warm-up is
   * also useful work and, on a keep-alive worker, leaves a connection that
   * later head refreshes reuse. "chainId": the earlier eth_chainId on a
   * throwaway key (kept to reproduce the 2026-11-06 baseline).
   */
  prewarm?: "head" | "chainId";
  /** blockTag() pins to a cached head at most this old (default 60 s); older or none: "latest". */
  headMaxStaleMs?: number;
  /** warm() sends at most one neutral request per identity and provider within this window (default 50 s). */
  warmWindowMs?: number;
  /**
   * Boot priority (default true): until the first account/stealth request has
   * an answer (headers or failure), head reads wait for it, at most
   * `headDeferMs` (default 2 s), so the identity's request claims the first
   * circuit. Only head reads are deferred; nothing is reordered after that.
   */
  bootPriority?: boolean;
  headDeferMs?: number;
  random?: () => number;
  now?: () => number;
}

export interface Target {
  id: string;
  url: string;
}

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** "write" for anything that must not be sent twice (proof submission). */
  kind?: "read" | "write";
  deadlines?: Partial<Deadlines>;
  signal?: AbortSignal;
  /** Return non-2xx responses instead of throwing (after retries). */
  passHttpErrors?: boolean;
}

export interface HttpResult {
  status: number;
  statusText: string;
  headers: Headers;
  body: Uint8Array;
  url: string;
}

export type BatchItem = { result: unknown } | { error: AnonRpcError };

interface SendSpec {
  kind: RequestKind;
  identity: Identity;
  label: string;
  targets: Target[];
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  deadlines: Deadlines;
  signal?: AbortSignal;
  passHttpErrors?: boolean;
  /** anonOptions.reusedHeadersTimeoutMs for reads (fork v3); undefined = worker default (5 s). */
  reusedHeadersTimeoutMs?: number;
  /** A head read: may be deferred at boot behind an identity's first request (bootPriority). */
  background?: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class AnonRpcClient {
  readonly identities: IdentityRegistry;
  readonly #host: WorkerHost;
  readonly #policy: ProviderPolicy;
  readonly #deadlines: Deadlines;
  readonly #scheduler: Scheduler;
  readonly #failover: boolean;
  readonly #httpHosts: ReadonlySet<string>;
  readonly #onTrace: TraceSink;
  readonly #userAgent: string;
  readonly #cache: ReadCache;
  readonly #finalityDepth: Record<number, number>;
  readonly #headTtlMs: number;
  readonly #prewarmChainId: number | false;
  readonly #prewarm: "head" | "chainId";
  readonly #headMaxStaleMs: number;
  readonly #warmWindowMs: number;
  readonly #warmedAt = new Map<string, number>();
  readonly #bootPriority: boolean;
  readonly #headDeferMs: number;
  /** Boot priority: identity requests sent but not yet answered, and whether one has been answered. */
  #fgPending = 0;
  #fgAnswered = false;
  #fgWaiters: Array<() => void> = [];
  readonly #now: () => number;
  readonly #generations = new Map<string, number>();
  readonly #finalized = new Map<number, bigint>();
  readonly #heads = new Map<number, { value: bigint; at: number }>();
  readonly #headInflight = new Map<number, Promise<bigint>>();
  #traceSeq = 0;
  #requestSeq = 0;
  #started = false;

  constructor(options: ClientOptions) {
    this.#host = options.host;
    this.#policy = options.policy ?? DEFAULT_POLICY;
    validatePolicy(this.#policy);
    this.#deadlines = { ...DEFAULT_DEADLINES, ...options.deadlines };
    this.#scheduler = new Scheduler({ ...(options.random ? { random: options.random } : {}), ...options.scheduler });
    this.#failover = options.failover ?? true;
    this.#httpHosts = new Set((options.httpHosts ?? []).map((h) => h.toLowerCase()));
    this.#onTrace = options.onTrace ?? (() => undefined);
    this.#userAgent = options.userAgent ?? ANON_USER_AGENT;
    this.#cache = new ReadCache(options.cacheEntries ?? 512);
    this.#finalityDepth = options.finalityDepth ?? {};
    this.#headTtlMs = options.headTtlMs ?? 12_000;
    this.#prewarmChainId = options.prewarmChainId ?? MAINNET;
    this.#prewarm = options.prewarm ?? "head";
    this.#headMaxStaleMs = options.headMaxStaleMs ?? 60_000;
    this.#warmWindowMs = options.warmWindowMs ?? 50_000;
    this.#bootPriority = options.bootPriority ?? true;
    this.#headDeferMs = options.headDeferMs ?? 2_000;
    this.#now = options.now ?? (() => performance.now());
    this.identities = new IdentityRegistry(options.random);
  }

  /**
   * Call at app load: starts the worker boot and, once ready, sends one
   * neutral request. By default that is the shared head read for
   * `prewarmChainId` (eth_blockNumber on the public head scope), whose answer
   * later pins blocks; with `prewarm: "chainId"` it is eth_chainId on a
   * throwaway identity. No address is ever read to "warm" anything.
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#host.start();
    const chainId = this.#prewarmChainId;
    if (chainId === false) return;
    if (this.#prewarm === "head") {
      // head() waits for the worker itself; its key is the shared public head scope.
      void this.head(chainId).catch(() => undefined);
      return;
    }
    void (async () => {
      const lease = await this.#host.acquire();
      lease.release();
      const provider = providersFor(this.#policy, chainId, "eth_chainId")[0];
      if (!provider) return;
      await this.#send({
        kind: "read",
        identity: this.identities.ephemeral("prewarm"),
        label: "prewarm:eth_chainId",
        targets: [{ id: provider.id, url: provider.url }],
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        deadlines: this.#deadlines,
      });
    })().catch(() => undefined);
  }

  close(): void {
    this.#host.close();
  }

  // ---------------------------------------------------------------- JSON-RPC

  /** One read for one identity. Pinned reads are deduped; final ones cached. */
  async read<T = unknown>(identity: Identity, chainId: number, method: string, params: readonly unknown[] = []): Promise<T> {
    if (!READ_METHODS.has(method)) throw new AnonRpcError(`${method} is not an allowed read`, "POLICY");
    this.#check(identity, JSON.stringify(params));
    const exec = () => this.#rpc<T>("read", identity, chainId, method, params);
    const ref = blockRefOf(method, params);
    if (!ref) return exec();
    const finalized = this.#finalized.get(chainId);
    const cacheable = ref.kind !== "number" || (finalized !== undefined && ref.n <= finalized);
    return this.#cache.run(readKey(chainId, method, params), cacheable, exec);
  }

  /** A state-changing call. Exactly one attempt on the first provider: never retried, never failed over. */
  async write<T = unknown>(identity: Identity, chainId: number, method: string, params: readonly unknown[]): Promise<T> {
    if (!WRITE_METHODS.has(method)) throw new AnonRpcError(`${method} is not an allowed write`, "POLICY");
    this.#check(identity, JSON.stringify(params));
    return this.#rpc<T>("write", identity, chainId, method, params);
  }

  /**
   * Several reads for ONE identity. Sent as a single JSON-RPC batch when a
   * provider on the route accepts a batch of that size (publicnode 10, dRPC
   * 3, onfinality none); otherwise as separate reads under the same identity.
   * There is no way to pass a second identity.
   */
  async batch(identity: Identity, chainId: number, calls: readonly { method: string; params?: readonly unknown[] }[]): Promise<BatchItem[]> {
    if (calls.length === 0) return [];
    for (const c of calls) {
      if (!READ_METHODS.has(c.method)) throw new AnonRpcError(`${c.method} is not an allowed read`, "POLICY");
    }
    const route = routeFor(calls[0]!.method);
    if (calls.some((c) => routeFor(c.method) !== route)) {
      throw new AnonRpcError("a batch must stay on one route", "POLICY");
    }
    this.#check(identity, JSON.stringify(calls));
    const providers = calls.length > 1 ? providersFor(this.#policy, chainId, calls[0]!.method, calls[0]!.params, calls.length) : [];
    if (providers.length === 0) {
      return Promise.all(
        calls.map((c) =>
          this.read(identity, chainId, c.method, c.params ?? []).then(
            (result): BatchItem => ({ result }),
            (error): BatchItem => ({ error: asError(error) }),
          ),
        ),
      );
    }
    const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params ?? [] })));
    const raw = await this.#send({
      kind: "read",
      identity,
      label: `batch:${calls.length}`,
      targets: providers.map((p) => ({ id: p.id, url: p.url })),
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      deadlines: this.#deadlines,
      passHttpErrors: true,
    });
    const payload = parseJson(raw, raw.target.id);
    if (!Array.isArray(payload)) {
      throw rpcErrorFrom(payload, raw, raw.target.id) ?? invalid("batch answer is not a list", raw.target.id);
    }
    const byId = new Map<number, Record<string, unknown>>();
    for (const item of payload) if (item && typeof item === "object") byId.set((item as { id: number }).id, item);
    return calls.map((_, i): BatchItem => {
      const item = byId.get(i + 1);
      if (!item) return { error: invalid(`batch item ${i + 1} missing`, raw.target.id) };
      if (item.error) return { error: rpcErrorFrom(item, raw, raw.target.id)! };
      if (!("result" in item)) return { error: invalid(`batch item ${i + 1} has no result`, raw.target.id) };
      return { result: item.result };
    });
  }

  // ------------------------------------------------------------------- HTTP

  /** HTTP GET/POST to an allowlisted host through the worker (RAILGUN, beacon, ASP). */
  async http(identity: Identity, req: HttpRequest): Promise<HttpResult> {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      throw new AnonRpcError(`invalid URL ${req.url}`, "POLICY");
    }
    if (url.protocol !== "https:") throw new AnonRpcError("https only", "POLICY");
    if (!this.#httpHosts.has(url.host.toLowerCase())) {
      throw new AnonRpcError(`host ${url.host} is not on the allowlist`, "POLICY");
    }
    const method = req.method ?? "GET";
    this.#check(identity, `${url.href} ${req.body ?? ""}`);
    const raw = await this.#send({
      kind: req.kind === "write" ? "write" : method === "GET" ? "get" : "read",
      identity,
      label: `http:${method}`,
      targets: [{ id: url.host, url: url.href }],
      method,
      headers: req.headers ?? {},
      ...(req.body !== undefined ? { body: req.body } : {}),
      deadlines: { ...this.#deadlines, ...req.deadlines },
      ...(req.signal ? { signal: req.signal } : {}),
      passHttpErrors: req.passHttpErrors ?? false,
      // A caller that raised the headers deadline expects a slow answer (Subsquid pages).
      ...((req.deadlines?.headersMs ?? 0) > this.#deadlines.headersMs ? { reusedHeadersTimeoutMs: 0 } : {}),
    });
    return { status: raw.status, statusText: raw.statusText, headers: raw.headers, body: raw.body, url: url.href };
  }

  // ------------------------------------------------------------------ Heads

  /** Latest block number, on a neutral public scope, shared by all callers for `headTtlMs`. */
  async head(chainId: number): Promise<bigint> {
    const cached = this.#heads.get(chainId);
    if (cached && this.#now() - cached.at < this.#headTtlMs) return cached.value;
    const pending = this.#headInflight.get(chainId);
    if (pending) return pending;
    const p = (async () => {
      const scope = this.identities.publicScope(`head:${chainId}`);
      this.#check(scope, "[]");
      const hex = await this.#rpc<string>("read", scope, chainId, "eth_blockNumber", [], { background: true });
      const value = BigInt(hex);
      this.#heads.set(chainId, { value, at: this.#now() });
      const depth = BigInt(this.#finalityDepth[chainId] ?? 96);
      const fin = value - depth;
      if (fin > (this.#finalized.get(chainId) ?? -1n)) this.#finalized.set(chainId, fin);
      return value;
    })();
    this.#headInflight.set(chainId, p);
    try {
      return await p;
    } finally {
      this.#headInflight.delete(chainId);
    }
  }

  /** head − k as a hex block tag. Pinning lets identical reads dedupe and avoids "header not found". Waits for a head. */
  async pinnedBlock(chainId: number, k = 8): Promise<string> {
    const h = await this.head(chainId);
    return `0x${(h - BigInt(k)).toString(16)}`;
  }

  /**
   * A block tag that never waits. With a cached head at most `headMaxStaleMs`
   * old: head − k as hex (as pinnedBlock). Otherwise "latest", so the caller's
   * read goes out at once instead of queueing behind a head read on another
   * circuit; put `calls.blockNumber()` in an aggregate3 to learn which block
   * the answer is from. A head older than `headTtlMs` (or none) is refreshed
   * in the background on the public head scope, never on the caller's key.
   */
  blockTag(chainId: number, k = 8): string {
    const cached = this.#heads.get(chainId);
    const age = cached ? this.#now() - cached.at : Number.POSITIVE_INFINITY;
    if (age >= this.#headTtlMs) void this.head(chainId).catch(() => undefined);
    if (cached && age < this.#headMaxStaleMs) return `0x${(cached.value - BigInt(k)).toString(16)}`;
    return "latest";
  }

  /**
   * Opens `identity`'s own circuit (and, on a keep-alive worker, a pooled
   * connection) to the chain's primary read provider before its first real
   * read, by sending one eth_chainId on that identity's key. The request names
   * nothing; it rides only the identity's own key, so it links nothing the
   * identity's later reads do not already link. Call it when the account is
   * known but its data request is not ready yet. At most once per identity
   * and provider within `warmWindowMs`. Never fails over (a second provider
   * would see nothing useful, but there is no reason to contact it); errors
   * are swallowed.
   */
  async warm(identity: Identity, chainId: number): Promise<void> {
    this.#check(identity, "");
    if (identity.kind === "ephemeral") return; // nothing would ever reuse it
    const provider = providersFor(this.#policy, chainId, "eth_chainId")[0];
    if (!provider) return;
    const genKey = `${identity.key}@${provider.id}`;
    const seen = this.#warmedAt.get(genKey);
    if (seen !== undefined && this.#now() - seen < this.#warmWindowMs) return;
    this.#warmedAt.set(genKey, this.#now());
    await this.#send({
      kind: "read",
      identity,
      label: "warm:eth_chainId",
      targets: [{ id: provider.id, url: provider.url }],
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      deadlines: this.#deadlines,
    }).then(
      () => undefined,
      () => undefined,
    );
  }

  /** Feed a verified finalized block (e.g. from a light client) to widen what may be cached. */
  setFinalizedBlock(chainId: number, n: bigint): void {
    if (n > (this.#finalized.get(chainId) ?? -1n)) this.#finalized.set(chainId, n);
  }

  stats() {
    return {
      scheduler: { ...this.#scheduler.stats },
      cache: { ...this.#cache.stats },
      host: { ...this.#host.stats },
      requests: this.#requestSeq,
      attempts: this.#traceSeq,
    };
  }

  // --------------------------------------------------------------- internals

  #check(identity: Identity, text: string): void {
    if (!this.identities.isIssued(identity)) {
      throw new AnonRpcError("identity handle was not issued by this client", "UNKNOWN_IDENTITY");
    }
    this.identities.assertOnlySubject(identity, text);
  }

  async #rpc<T>(
    kind: "read" | "write",
    identity: Identity,
    chainId: number,
    method: string,
    params: readonly unknown[],
    extra: { background?: boolean } = {},
  ): Promise<T> {
    const providers = providersFor(this.#policy, chainId, method, params);
    if (providers.length === 0) throw new AnonRpcError(`no provider for ${method} on chain ${chainId}`, "POLICY");
    const raw = await this.#send({
      kind,
      identity,
      label: method,
      targets: providers.map((p) => ({ id: p.id, url: p.url })),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      deadlines: this.#deadlines,
      passHttpErrors: true,
      // Log windows can take several seconds of server time (onfinality p50 7.8 s).
      ...(routeFor(method) === "logs" ? { reusedHeadersTimeoutMs: 0 } : {}),
      ...(extra.background ? { background: true } : {}),
    });
    const payload = parseJson(raw, raw.target.id);
    const rpcError = rpcErrorFrom(payload, raw, raw.target.id);
    if (rpcError) throw rpcError;
    if (raw.status < 200 || raw.status > 299) {
      throw new AnonRpcError(`HTTP ${raw.status}`, "HTTP_STATUS", { status: raw.status, provider: raw.target.id });
    }
    if (!payload || typeof payload !== "object" || !("result" in payload)) {
      throw invalid("not a JSON-RPC response", raw.target.id);
    }
    return (payload as { result: T }).result;
  }

  async #send(spec: SendSpec): Promise<RawResponse & { target: Target }> {
    this.#check(spec.identity, `${spec.targets.map((t) => t.url).join(" ")} ${spec.body ?? ""}`);
    if (spec.targets.length === 0) throw new AnonRpcError("no target", "POLICY");
    return this.#scheduler.run(spec.identity.key, () => this.#attempts(spec));
  }

  /** The attempt plan: [primary] for writes; [primary, primary on a fresh circuit, next provider] for reads. */
  async #attempts(spec: SendSpec): Promise<RawResponse & { target: Target }> {
    const requestId = ++this.#requestSeq;
    const bodyBytes = spec.body ? encoder.encode(spec.body).byteLength : 0;
    const idempotent = isIdempotent(spec);
    // Boot priority: an identity's request counts until its first attempt settles.
    let fgOpen = this.#bootPriority && !this.#fgAnswered && (spec.identity.kind === "account" || spec.identity.kind === "stealth");
    if (fgOpen) this.#fgPending += 1;
    const settleForeground = (answered: boolean) => {
      if (!fgOpen) return;
      fgOpen = false;
      this.#fgPending -= 1;
      if (answered) this.#fgAnswered = true;
      if (this.#fgAnswered || this.#fgPending === 0) {
        const waiters = this.#fgWaiters;
        this.#fgWaiters = [];
        for (const w of waiters) w();
      }
    };
    try {
      return await this.#attemptLoop(spec, requestId, bodyBytes, idempotent, settleForeground);
    } finally {
      settleForeground(false);
    }
  }

  /** Boot priority: a head read waits while an identity's first request is unanswered (bounded). */
  async #bootGate(): Promise<void> {
    if (!this.#bootPriority || this.#fgAnswered || this.#fgPending === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      new Promise<void>((r) => this.#fgWaiters.push(r)),
      new Promise<void>((r) => (timer = setTimeout(r, this.#headDeferMs))),
    ]);
    clearTimeout(timer);
  }

  async #attemptLoop(
    spec: SendSpec,
    requestId: number,
    bodyBytes: number,
    idempotent: boolean,
    settleForeground: (answered: boolean) => void,
  ): Promise<RawResponse & { target: Target }> {
    const primary = spec.targets[0]!;
    const plan: Target[] =
      spec.kind === "write"
        ? [primary]
        : [primary, primary, ...(this.#failover && spec.targets[1] ? [spec.targets[1]] : [])];
    let transportFailures = 0;
    let lastError: unknown;
    for (let attempt = 0; attempt < plan.length; attempt++) {
      const target = plan[attempt]!;
      // Nothing is sent before a worker is ready; a boot failure is not an attempt.
      let lease = await this.#host.acquire();
      if (spec.background && attempt === 0 && this.#bootPriority && !this.#fgAnswered && this.#fgPending > 0) {
        // Checked once the worker is ready, when every request queued at boot has registered.
        lease.release();
        await this.#bootGate();
        lease = await this.#host.acquire();
      }
      const genKey = `${spec.identity.key}@${target.id}`;
      const generation = this.#generations.get(genKey) ?? 0;
      const isolationKey = `${genKey}#${generation}`;
      const startedAt = this.#now();
      const trace: Trace = {
        id: ++this.#traceSeq,
        requestId,
        attempt,
        kind: spec.kind,
        method: spec.label,
        identity: spec.identity.label,
        circuit: `${target.id}#${generation}`,
        host: safeHost(target.url),
        bytesOut: bodyBytes,
        bytesIn: 0,
        startedAt,
        durationMs: 0,
        ok: false,
        workerGeneration: lease.generation,
        idempotent,
      };
      const anonOptions: AnonOptions = idempotent
        ? {
            isolationKey,
            idempotent: true,
            ...(spec.reusedHeadersTimeoutMs !== undefined ? { reusedHeadersTimeoutMs: spec.reusedHeadersTimeoutMs } : {}),
          }
        : { isolationKey };
      let emitted = false;
      try {
        const raw = await fetchWithDeadlines(
          lease.worker,
          target.url,
          {
            method: spec.method,
            headers: { ...spec.headers, "user-agent": this.#userAgent },
            ...(spec.body !== undefined ? { body: spec.body } : {}),
            anonOptions,
          },
          { deadlines: spec.deadlines, ...(spec.signal ? { signal: spec.signal } : {}), now: this.#now },
        );
        trace.headersMs = raw.headersMs;
        trace.durationMs = this.#now() - startedAt;
        trace.status = raw.status;
        trace.bytesIn = raw.body.byteLength;
        const ok = raw.status >= 200 && raw.status <= 299;
        trace.ok = ok;
        if (!ok) trace.code = "HTTP_STATUS";
        this.#emit(trace);
        settleForeground(true);
        emitted = true;
        this.#host.reportSuccess(lease.generation); // the transport worked
        if (!ok && isRetryableStatus(raw.status) && attempt < plan.length - 1) {
          lastError = new AnonRpcError(`HTTP ${raw.status}`, "HTTP_STATUS", { status: raw.status, provider: target.id });
          this.#rotate(genKey);
          continue;
        }
        if (!ok && !spec.passHttpErrors) {
          throw new AnonRpcError(`HTTP ${raw.status} from ${target.id}`, "HTTP_STATUS", { status: raw.status, provider: target.id });
        }
        return { ...raw, target };
      } catch (error) {
        const e = asError(error);
        const action = retryAction(e);
        settleForeground(true); // its circuit was used; heads need not wait for the retry
        if (!emitted) {
          trace.durationMs = this.#now() - startedAt;
          trace.code = e.code;
          if (e.torKind) trace.torKind = e.torKind;
          trace.retry = action;
          this.#emit(trace);
        }
        // A destination answer (e.g. RemoteConnectionRefused) says nothing about the circuit or the worker.
        if (action === "rotate" && (TRANSPORT_CODES.has(e.code) || TIMEOUT_CODES.has(e.code) || EXIT_SIDE_TOR_KINDS.has(e.torKind ?? ""))) {
          transportFailures += 1;
          // Two fresh circuits failed for one request: count it against the worker.
          if (transportFailures === 2) this.#host.reportCircuitFailure(lease.generation);
        }
        if (action === "stop" || attempt === plan.length - 1) throw e;
        lastError = e;
        if (action === "next-provider") {
          // Keep this circuit; skip the remaining attempts on the same provider.
          const next = plan.findIndex((t, i) => i > attempt && t.id !== target.id);
          if (next === -1) throw e;
          attempt = next - 1;
          continue;
        }
        this.#rotate(genKey); // fresh circuit for the retry and for later calls
      } finally {
        lease.release();
      }
    }
    throw asError(lastError);
  }

  #rotate(genKey: string): void {
    this.#generations.set(genKey, (this.#generations.get(genKey) ?? 0) + 1);
  }

  #emit(trace: Trace): void {
    try {
      this.#onTrace({ ...trace });
    } catch {
      /* a broken sink must not break requests */
    }
  }
}

/**
 * Reads and GETs may be resent by a keep-alive worker; writes never. Belt and
 * braces: a body that names a sending or submitting method is never marked,
 * whatever kind the caller used.
 */
const NON_IDEMPOTENT_METHOD = /"method"\s*:\s*"(eth_send\w*|ppoi_submit\w*|relay\w*|\w*_submit\w*)"/;
export function isIdempotent(spec: { kind: RequestKind; body?: string }): boolean {
  if (spec.kind === "write") return false;
  if (spec.body !== undefined && NON_IDEMPOTENT_METHOD.test(spec.body)) return false;
  return true;
}

function asError(error: unknown): AnonRpcError {
  return error instanceof AnonRpcError ? error : new AnonRpcError(String((error as Error)?.message ?? error), "WORKER_ERROR", { cause: error });
}

function invalid(message: string, provider: string): AnonRpcError {
  return new AnonRpcError(message, "INVALID_RESPONSE", { provider });
}

function parseJson(raw: RawResponse, provider: string): unknown {
  const text = decoder.decode(raw.body);
  try {
    return JSON.parse(text);
  } catch {
    if (raw.status < 200 || raw.status > 299) {
      throw new AnonRpcError(`HTTP ${raw.status}`, "HTTP_STATUS", { status: raw.status, provider });
    }
    throw invalid("response is not JSON", provider);
  }
}

function rpcErrorFrom(payload: unknown, raw: RawResponse, provider: string): AnonRpcError | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const err = (payload as { error?: { code?: unknown; message?: unknown; data?: unknown } }).error;
  if (!err || typeof err !== "object") return undefined;
  // A retryable status keeps its HTTP identity (e.g. onfinality's 429 carries a JSON error body).
  if (isRetryableStatus(raw.status)) {
    return new AnonRpcError(`HTTP ${raw.status}: ${String(err.message ?? "")}`, "HTTP_STATUS", { status: raw.status, provider });
  }
  return new AnonRpcError(String(err.message ?? "JSON-RPC error"), "RPC_ERROR", {
    ...(typeof err.code === "number" ? { rpcCode: err.code } : {}),
    rpcData: err.data,
    status: raw.status,
    provider,
  });
}
