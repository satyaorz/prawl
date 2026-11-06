/**
 * Error model. Every failure carries a `code`; retry and replacement decisions
 * are made from the code (and HTTP status), never from message text.
 *
 * The browser harness forwards only `name`, `code` and `message` from the
 * worker (`torKind` never crosses it), so the transport codes below are the
 * ones tor-js sets on its errors: CONNECTION, TLS, HTTP_REQUEST, IO_ERROR.
 *
 * Our tor-js fork also puts Arti's error kind into `name` as
 * `TorError.<kind>` (experiments/torjs-keepalive). When it is there, the kind
 * refines the retry rule: see `retryAction`. The stock worker leaves `name`
 * as "Error", and the code-based rule applies unchanged.
 */
import type { RetryAction } from "./types";
export type ErrorCode =
  // Our own deadlines (the worker returned nothing in time).
  | "TIMEOUT_HEADERS"
  | "TIMEOUT_BODY"
  | "TIMEOUT_TOTAL"
  // Transport codes passed through from the worker.
  | "CONNECTION"
  | "TLS"
  | "HTTP_REQUEST"
  | "IO_ERROR"
  // Worker errors we cannot classify (no retry).
  | "WORKER_ERROR"
  | "WORKER_CLOSED"
  // Destination answered, but not usefully.
  | "HTTP_STATUS"
  | "RPC_ERROR"
  | "INVALID_RESPONSE"
  | "RESPONSE_TOO_LARGE"
  // Boot.
  | "BOOT_FAILED"
  | "BOOT_TIMEOUT"
  // Refused locally, nothing was sent.
  | "CROSS_IDENTITY"
  | "UNKNOWN_IDENTITY"
  | "POLICY"
  | "ABORTED";

export const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "CONNECTION",
  "TLS",
  "HTTP_REQUEST",
  "IO_ERROR",
]);

export const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  "TIMEOUT_HEADERS",
  "TIMEOUT_BODY",
  "TIMEOUT_TOTAL",
]);

export type ErrorDetails = {
  status?: number;
  rpcCode?: number;
  rpcData?: unknown;
  provider?: string;
  host?: string;
  cause?: unknown;
  torKind?: string;
};

export class AnonRpcError extends Error {
  readonly code: ErrorCode;
  /** Arti error kind, when the worker reported one (fork: `TorError.<kind>` in `name`). */
  readonly torKind: string | undefined;
  readonly status: number | undefined;
  readonly rpcCode: number | undefined;
  readonly rpcData: unknown;
  readonly provider: string | undefined;
  readonly host: string | undefined;

  constructor(message: string, code: ErrorCode, details: ErrorDetails = {}) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "AnonRpcError";
    this.code = code;
    this.status = details.status;
    this.rpcCode = details.rpcCode;
    this.rpcData = details.rpcData;
    this.provider = details.provider;
    this.host = details.host;
    this.torKind = details.torKind;
  }
}

/** HTTP statuses that suggest a per-exit or transient problem: 403 (exit blocked), 429, 5xx. */
export function isRetryableStatus(status: number): boolean {
  return status === 403 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * The retry rule, in one place: our deadlines, the four transport codes and
 * HTTP 403/429/5xx. A JSON-RPC error is an answer, not a transport failure,
 * and is never retried.
 */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof AnonRpcError)) return false;
  if (TIMEOUT_CODES.has(error.code) || TRANSPORT_CODES.has(error.code)) return true;
  if (error.code === "HTTP_STATUS" && error.status !== undefined) {
    return isRetryableStatus(error.status);
  }
  return false;
}

/**
 * Arti error kinds (tor-error 0.47 `ErrorKind`) that say the failure was on
 * our side of the destination: the circuit, a relay, or the exit (its
 * resolver, its network, its policy, its timeouts). Another circuit, and so
 * another exit, may well succeed, so these retry on a fresh circuit.
 *
 * RemoteHostNotFound is here too: Tor does not tell an exit's broken resolver
 * from a real NXDOMAIN, and our providers are fixed hostnames that exist.
 * RemoteStreamClosed/Reset/Error are here because a Tor-hostile front end or
 * a sick exit looks the same from the client; tor-js already resends on its
 * own when a pooled keep-alive connection closes.
 */
export const EXIT_SIDE_TOR_KINDS: ReadonlySet<string> = new Set([
  "TorAccessFailed",
  "TorNetworkTimeout",
  "TorProtocolViolation",
  "CircuitCollapse",
  "CircuitRefused",
  "RelayIdMismatch",
  "RelayTooBusy",
  "TransientFailure",
  "ExitPolicyRejected",
  "ExitTimeout",
  "RemoteNetworkTimeout",
  "RemoteNetworkFailed",
  "RemoteHostResolutionFailed",
  "RemoteHostNotFound",
  "RemoteStreamClosed",
  "RemoteStreamReset",
  "RemoteStreamError",
  "RemoteProtocolViolation",
]);

/**
 * Kinds where the destination itself answered, through a working exit. A new
 * circuit to the same provider would get the same answer, so the circuit is
 * kept (no rotation, which would also needlessly burn a clean circuit) and
 * the same-provider retry is skipped. Failover to the next provider is still
 * allowed, since that is a different destination.
 */
export const DESTINATION_TOR_KINDS: ReadonlySet<string> = new Set(["RemoteConnectionRefused"]);

/**
 * Kinds that are refused locally or are bugs: the same request fails the same
 * way on any circuit and any provider route through this worker.
 */
export const FATAL_TOR_KINDS: ReadonlySet<string> = new Set([
  "InvalidStreamTarget",
  "ForbiddenStreamTarget",
  "BadApiUsage",
  "InvalidConfig",
  "NotImplemented",
  "FeatureDisabled",
]);

const TOR_KIND_RE = /^[A-Za-z0-9]{1,64}$/;

/** `TorError.<kind>` in an error name (the fork's convention), or a `torKind` property, else undefined. */
export function torKindOf(error: unknown): string | undefined {
  const e = (error ?? {}) as { name?: unknown; torKind?: unknown };
  if (typeof e.torKind === "string" && TOR_KIND_RE.test(e.torKind)) return e.torKind;
  if (typeof e.name === "string" && e.name.startsWith("TorError.")) {
    const kind = e.name.slice("TorError.".length);
    if (TOR_KIND_RE.test(kind)) return kind;
  }
  return undefined;
}

/**
 * The retry decision for a failed attempt, in one place.
 *
 *  - caller abort: stop;
 *  - a destination answer (RemoteConnectionRefused): keep the circuit and go
 *    to the next provider if failover allows, else stop;
 *  - a fatal/local kind: stop;
 *  - an exit-side kind: rotate (fresh circuit, then failover), even when the
 *    worker's `code` alone would not have been retried;
 *  - no kind (stock worker) or an unlisted kind: the code rule (`isRetryable`).
 */
export function retryAction(error: unknown): RetryAction {
  if (!(error instanceof AnonRpcError)) return "stop";
  if (error.code === "ABORTED") return "stop";
  const kind = error.torKind;
  if (kind !== undefined) {
    if (DESTINATION_TOR_KINDS.has(kind)) return "next-provider";
    if (FATAL_TOR_KINDS.has(kind)) return "stop";
    if (EXIT_SIDE_TOR_KINDS.has(kind)) return "rotate";
  }
  return isRetryable(error) ? "rotate" : "stop";
}

/** Maps whatever the worker threw into an AnonRpcError, keeping the worker's `code` and any Arti kind. */
export function fromWorkerError(error: unknown, host?: string): AnonRpcError {
  if (error instanceof AnonRpcError) return error;
  const e = (error ?? {}) as { name?: unknown; code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : undefined;
  const message = typeof e.message === "string" ? e.message : String(error);
  const torKind = torKindOf(error);
  const details: ErrorDetails = { cause: error, ...(host ? { host } : {}), ...(torKind ? { torKind } : {}) };
  if (code && TRANSPORT_CODES.has(code)) {
    return new AnonRpcError(message, code as ErrorCode, details);
  }
  if (/worker closed/i.test(message)) {
    return new AnonRpcError(message, "WORKER_CLOSED", details);
  }
  return new AnonRpcError(message, "WORKER_ERROR", details);
}
