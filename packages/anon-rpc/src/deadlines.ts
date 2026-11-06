/**
 * One fetch through the worker with three deadlines:
 *   - headers: no response headers within `headersMs` aborts the call;
 *   - total:   the whole exchange, including the body, within `totalMs`;
 *   - body:    once headers arrived the harness drops its abort listener, so
 *              the total timer also cancels the body reader.
 *
 * A deadline ends this request only. It never touches the worker: other
 * identities' calls on the same worker keep going.
 *
 * We also race our own timer against the worker's promise, because the
 * measured failure mode is a silent hang where the worker never settles.
 */
import { AnonRpcError, fromWorkerError } from "./errors";
import type { AnonOptions, Deadlines, WorkerLike } from "./types";

export interface RawResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: Uint8Array;
  headersMs: number;
  totalMs: number;
}

export interface FetchOptions {
  deadlines: Deadlines;
  /** Caller's own cancellation, e.g. from the RAILGUN shim's caller. */
  signal?: AbortSignal;
  maxBytes?: number;
  now?: () => number;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export async function fetchWithDeadlines(
  worker: WorkerLike,
  url: string,
  init: RequestInit & { anonOptions?: AnonOptions },
  options: FetchOptions,
): Promise<RawResponse> {
  const now = options.now ?? (() => performance.now());
  const { headersMs, totalMs } = options.deadlines;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const host = safeHost(url);
  const controller = new AbortController();
  const started = now();
  let phase: "headers" | "body" = "headers";
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stopError: AnonRpcError | undefined;
  let rejectStop!: (e: AnonRpcError) => void;
  const stopped = new Promise<never>((_, reject) => {
    rejectStop = reject;
  });
  stopped.catch(() => undefined);

  const stop = (error: AnonRpcError) => {
    if (stopError) return;
    stopError = error;
    controller.abort(error);
    reader?.cancel(error).catch(() => undefined);
    rejectStop(error);
  };

  const headersTimer = setTimeout(() => {
    if (phase === "headers") {
      stop(new AnonRpcError(`no response headers within ${headersMs} ms`, "TIMEOUT_HEADERS", { host }));
    }
  }, headersMs);
  const totalTimer = setTimeout(() => {
    stop(
      phase === "headers"
        ? new AnonRpcError(`no response within ${totalMs} ms`, "TIMEOUT_TOTAL", { host })
        : new AnonRpcError(`body not complete within ${totalMs} ms`, "TIMEOUT_BODY", { host }),
    );
  }, totalMs);
  const onOuterAbort = () => stop(new AnonRpcError("aborted by caller", "ABORTED", { host }));
  if (options.signal?.aborted) onOuterAbort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const response = await Promise.race([
      worker.fetch(url, { ...init, signal: controller.signal }),
      stopped,
    ]);
    phase = "body";
    const headersAt = now() - started;
    clearTimeout(headersTimer);
    if (stopError) throw stopError;
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      reader = response.body.getReader();
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), stopped]);
        // A cancel resolves the pending read as `done` in the same tick the
        // stop promise rejects; never mistake that for a complete body.
        if (stopError) throw stopError;
        if (done) break;
        if (!value) continue;
        size += value.byteLength;
        if (size > maxBytes) {
          stop(new AnonRpcError(`response over ${maxBytes} bytes`, "RESPONSE_TOO_LARGE", { host }));
          throw stopError;
        }
        chunks.push(value);
      }
    }
    if (stopError) throw stopError;
    const body = concat(chunks, size);
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body,
      headersMs: headersAt,
      totalMs: now() - started,
    };
  } catch (error) {
    if (stopError) throw stopError;
    throw fromWorkerError(error, host);
  } finally {
    clearTimeout(headersTimer);
    clearTimeout(totalTimer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}
