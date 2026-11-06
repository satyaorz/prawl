/**
 * A `fetch` replacement for `kohaku-railgun-wasm`, which calls the global
 * fetch with no injection API. Install it only around the RAILGUN module (or
 * as its global fetch); it routes every call through the Anon-RPC client.
 *
 * Rules:
 *  - exact-host allowlist, https only; anything else fails like a network
 *    error (TypeError), never falls through to the real fetch;
 *  - returns a real `Response` with a non-empty `url` (reqwest throws otherwise);
 *  - constant user agent, and a constant JSON-RPC id (1, or 1..n in a batch)
 *    restored in the answer so the caller's id matching still works;
 *  - asks Subsquid for gzip (measured 11 MB → 4.07 MB, 38 s → 14 s over Tor)
 *    and decompresses here, since tor-js passes the compressed body through;
 *  - proof submission and bundler calls get a fresh one-time identity each,
 *    unless the body names an account the caller registered (a one-time
 *    UserOperation sender): then the call goes on that account's own
 *    identity, as the cross-identity guard requires. Only actual submissions
 *    (eth_sendUserOperation, PPOI submits) are never retried; bundler reads
 *    such as gas estimates are. Public sync reads share one scope per host.
 */
import type { AnonRpcClient } from "./client";
import { AnonRpcError } from "./errors";
import type { Identity } from "./identity";
import type { Deadlines } from "./types";

export interface RailgunFetchOptions {
  client: AnonRpcClient;
  /** Subsquid GraphQL hosts (gzip requested). */
  squidHosts: readonly string[];
  /** POI node hosts. */
  poiHosts: readonly string[];
  /** Artifact hosts (raw GitHub). */
  artifactHosts: readonly string[];
  /** ERC-4337 bundler hosts; every call gets a fresh identity (see accountFor). */
  bundlerHosts?: readonly string[];
  /**
   * For bundler calls: the identity of an account the request body names,
   * if any. Such a call must travel on that account's identity.
   */
  accountFor?: (body: string) => Identity | undefined;
  /** POI JSON-RPC methods that submit something; fresh identity, no retry. */
  submitMethods?: readonly string[];
  /** Deadlines for large Subsquid pages (default 20 s headers, 90 s total). */
  squidDeadlines?: Partial<Deadlines>;
  decompress?: (bytes: Uint8Array, encoding: string) => Promise<Uint8Array>;
}

export const DEFAULT_SUBMIT_METHODS = [
  "ppoi_submit_poi",
  "ppoi_submit_transact_proof",
  "ppoi_submit_legacy_transact_proofs",
  "ppoi_submit_single_commitment_proofs",
];

/** Bundler methods that submit something: one attempt only. */
const BUNDLER_SUBMIT_METHODS: ReadonlySet<string> = new Set(["eth_sendUserOperation"]);

const PASS_HEADERS = new Set(["content-type", "accept"]);

export function createRailgunFetch(options: RailgunFetchOptions): typeof fetch {
  const lower = (xs: readonly string[] | undefined) => new Set((xs ?? []).map((h) => h.toLowerCase()));
  const squid = lower(options.squidHosts);
  const poi = lower(options.poiHosts);
  const artifacts = lower(options.artifactHosts);
  const bundlers = lower(options.bundlerHosts);
  const submitMethods = new Set(options.submitMethods ?? DEFAULT_SUBMIT_METHODS);
  const decompress = options.decompress ?? gunzip;
  const client = options.client;

  const railgunFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    let url: URL;
    try {
      url = new URL(request ? request.url : String(input));
    } catch {
      throw new TypeError("railgun fetch: invalid URL");
    }
    const host = url.host.toLowerCase();
    const known = squid.has(host) || poi.has(host) || artifacts.has(host) || bundlers.has(host);
    if (url.protocol !== "https:" || !known) {
      throw new TypeError(`railgun fetch: ${url.host} is not on the allowlist`);
    }

    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") throw new TypeError(`railgun fetch: ${method} not allowed`);
    const rawHeaders = new Headers(init?.headers ?? request?.headers);
    const headers: Record<string, string> = {};
    rawHeaders.forEach((v, k) => {
      if (PASS_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
    });
    const wantGzip = squid.has(host);
    if (wantGzip) headers["accept-encoding"] = "gzip";

    let body: string | undefined;
    if (init?.body !== undefined && init.body !== null) body = await bodyText(init.body);
    else if (request && method === "POST") body = await request.clone().text();

    // Constant JSON-RPC ids.
    let restoreIds: ((payload: unknown) => unknown) | undefined;
    let rpcMethods: string[] = [];
    if (body) {
      const rewritten = rewriteIds(body);
      if (rewritten) {
        body = rewritten.body;
        restoreIds = rewritten.restore;
        rpcMethods = rewritten.methods;
      }
    }

    const isBundler = bundlers.has(host);
    const isSubmit =
      (isBundler && (rpcMethods.length === 0 || rpcMethods.some((m) => BUNDLER_SUBMIT_METHODS.has(m)))) ||
      (poi.has(host) && rpcMethods.some((m) => submitMethods.has(m)));
    const identity = isBundler
      ? ((body !== undefined ? options.accountFor?.(body) : undefined) ?? client.identities.ephemeral("railgun-submit"))
      : isSubmit
        ? client.identities.ephemeral("railgun-submit")
        : client.identities.publicScope(`railgun:${host.replace(/[^a-z0-9.-]/g, "-")}`);

    let result;
    try {
      result = await client.http(identity, {
        url: url.href,
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        kind: isSubmit ? "write" : "read",
        ...(squid.has(host) ? { deadlines: { headersMs: 20_000, totalMs: 90_000, ...options.squidDeadlines } } : {}),
        ...(init?.signal ? { signal: init.signal } : {}),
        passHttpErrors: true,
      });
    } catch (error) {
      if (error instanceof AnonRpcError && error.code === "ABORTED") {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      throw new TypeError(`railgun fetch failed: ${(error as Error).message}`, { cause: error });
    }

    let bytes = result.body;
    const outHeaders = new Headers(result.headers);
    const encoding = (outHeaders.get("content-encoding") ?? "").toLowerCase();
    if (encoding === "gzip" || (wantGzip && bytes[0] === 0x1f && bytes[1] === 0x8b)) {
      bytes = await decompress(bytes, "gzip");
      outHeaders.delete("content-encoding");
      outHeaders.delete("content-length");
    }
    if (restoreIds && bytes.byteLength > 0) {
      try {
        const payload = JSON.parse(new TextDecoder().decode(bytes));
        bytes = new TextEncoder().encode(JSON.stringify(restoreIds(payload)));
        outHeaders.delete("content-length");
      } catch {
        /* not JSON; pass through */
      }
    }
    const nullBody = result.status === 204 || result.status === 304;
    const response = new Response(nullBody ? null : (bytes as BodyInit), {
      status: result.status,
      statusText: result.statusText,
      headers: outHeaders,
    });
    Object.defineProperty(response, "url", { value: url.href });
    return response;
  };
  return railgunFetch as typeof fetch;
}

async function bodyText(body: BodyInit): Promise<string> {
  if (typeof body === "string") return body;
  return new Response(body).text();
}

function rewriteIds(text: string): { body: string; restore: (p: unknown) => unknown; methods: string[] } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (Array.isArray(parsed) && parsed.every((x) => x && typeof x === "object" && "jsonrpc" in x)) {
    const original = parsed.map((x) => (x as { id?: unknown }).id);
    const body = JSON.stringify(parsed.map((x, i) => ({ ...(x as object), id: i + 1 })));
    return {
      body,
      methods: parsed.map((x) => String((x as { method?: unknown }).method)),
      restore: (p) => (Array.isArray(p) ? p.map((r) => (r && typeof r === "object" && typeof (r as { id?: unknown }).id === "number" ? { ...(r as object), id: original[(r as { id: number }).id - 1] } : r)) : p),
    };
  }
  if (parsed && typeof parsed === "object" && "jsonrpc" in parsed) {
    const original = (parsed as { id?: unknown }).id;
    return {
      body: JSON.stringify({ ...(parsed as object), id: 1 }),
      methods: [String((parsed as { method?: unknown }).method)],
      restore: (p) => (p && typeof p === "object" && !Array.isArray(p) ? { ...(p as object), id: original } : p),
    };
  }
  return undefined;
}

async function gunzip(bytes: Uint8Array, encoding: string): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(encoding as CompressionFormat));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
