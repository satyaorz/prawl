/**
 * Per-request options the harness forwards to the worker untouched.
 *
 * `idempotent` tells a keep-alive worker (our tor-js fork) that this POST may
 * be resent once if a pooled connection dies after the request left but
 * before any response byte. The client sets it on reads only, never on
 * writes. The stock worker ignores it.
 */
export interface AnonOptions {
  isolationKey: string;
  idempotent?: true;
  /**
   * Fork v3 only (stock and older forks ignore it): how long a replayable
   * request that rides a *reused* keep-alive connection waits for response
   * headers before the worker presumes the connection silently dead and sends
   * it once more on a fresh connection under the same key. Omitted: the
   * worker's default, 5 s. 0: no such deadline (set for slow reads such as
   * deep eth_getLogs, whose server time alone can exceed 5 s).
   */
  reusedHeadersTimeoutMs?: number;
}

/** What the client needs from an Anon-RPC worker (AnonRpcWorker from the harness fits). */
export interface WorkerLike {
  ready: Promise<void>;
  fetch(
    input: string,
    init: RequestInit & { anonOptions?: AnonOptions },
  ): Promise<Response>;
  close(): void;
}

/** Builds a worker. `bootstrap` is the Tor directory snapshot from our own origin, if we have one. */
export type WorkerFactory = (init: { bootstrap?: Uint8Array }) => WorkerLike;

export type RequestKind = "read" | "write" | "get";

/** After a failed attempt: retry on a fresh circuit, skip to the next provider, or give up. */
export type RetryAction = "rotate" | "next-provider" | "stop";

/** One trace per attempt that reached (or tried to reach) the worker. */
export interface Trace {
  id: number;
  /** Logical request id; retries and failovers share it. */
  requestId: number;
  attempt: number;
  kind: RequestKind;
  /** JSON-RPC method, `batch:N`, `http:GET` and so on. */
  method: string;
  /** Identity label (never the full address). */
  identity: string;
  /** Provider id or host, plus circuit generation, e.g. `publicnode-mainnet#2`. */
  circuit: string;
  host: string;
  bytesOut: number;
  bytesIn: number;
  startedAt: number;
  /** Time to response headers, if they arrived. */
  headersMs?: number;
  durationMs: number;
  /** HTTP status, if a response arrived. */
  status?: number;
  ok: boolean;
  /** AnonRpcError code on failure. */
  code?: string;
  /** Arti error kind from the worker (fork only: error name `TorError.<kind>`). */
  torKind?: string;
  /** What the retry rule decided after this attempt failed. */
  retry?: RetryAction;
  /** Whether this attempt was sent with `anonOptions.idempotent`. */
  idempotent: boolean;
  workerGeneration: number;
}

export type TraceSink = (trace: Trace) => void;

export interface Deadlines {
  /** From sending the request to response headers. */
  headersMs: number;
  /** From sending the request to the last body byte. */
  totalMs: number;
}

export const DEFAULT_DEADLINES: Deadlines = { headersMs: 15_000, totalMs: 30_000 };
