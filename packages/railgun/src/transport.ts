/**
 * All of RAILGUN's network I/O, over Anon-RPC.
 *
 * kohaku-railgun-wasm calls the global `fetch` (reqwest) for four things:
 *  - its JSON-RPC provider, given as one URL. We give it a virtual URL
 *    (https://<rpcHost>/<chainId>) and answer it here by sending each call
 *    as an Anon-RPC read: on the wallet's own account identity when the call
 *    names the account address, else on a public RAILGUN scope (commitment
 *    logs, contract reads that name nobody). Writes are refused: Prawl sends
 *    transactions and UserOperations itself.
 *  - Subsquid history, the PPOI node, and circuit artifacts, and
 *  - the bundler, all handled by @prawl/anon-rpc's createRailgunFetch.
 * Anything else fails like a network error and never reaches the real fetch.
 */
import { AnonRpcError, createRailgunFetch, type AnonRpcClient, type Identity } from "@prawl/anon-rpc";

export const DEFAULT_RPC_HOST = "rpc.railgun.prawl.invalid";
export const ARTIFACT_HOSTS = ["raw.githubusercontent.com", "ipfs-lb.com"];

export interface TransportOptions {
  client: AnonRpcClient;
  chainId: number;
  subsquidEndpoint: string;
  poiEndpoint: string;
  /** The wallet's EVM account (signs UserOperations), if it has one. */
  accountAddress?: string;
  bundlerHosts?: readonly string[];
  artifactHosts?: readonly string[];
  rpcHost?: string;
}

export interface RailgunTransport {
  fetch: typeof fetch;
  /** Pass to RailgunWallet.open as rpcUrl. */
  rpcUrl: string;
}

interface JsonRpcCall {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function hostOf(url: string): string {
  return new URL(url).host.toLowerCase();
}

function jsonResponse(body: unknown, url: string): Response {
  const res = new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  // reqwest's wasm client rejects a Response whose url is empty.
  Object.defineProperty(res, "url", { value: url });
  return res;
}

function toRpcError(e: unknown): { code: number; message: string; data?: unknown } {
  if (e instanceof AnonRpcError) {
    if (e.code === "RPC_ERROR") return { code: e.rpcCode ?? -32000, message: e.message, ...(e.rpcData !== undefined ? { data: e.rpcData } : {}) };
    return { code: -32603, message: `${e.code}: ${e.message}` };
  }
  return { code: -32603, message: e instanceof Error ? e.message : String(e) };
}

export function createRailgunTransport(opts: TransportOptions): RailgunTransport {
  const rpcHost = (opts.rpcHost ?? DEFAULT_RPC_HOST).toLowerCase();
  const rpcUrl = `https://${rpcHost}/${opts.chainId}`;
  const client = opts.client;
  const account = opts.accountAddress?.toLowerCase().replace(/^0x/, "");
  const publicId = client.identities.publicScope(`railgun-${opts.chainId}`);
  const accountId = opts.accountAddress ? client.identities.account(opts.accountAddress) : undefined;

  const identityFor = (call: JsonRpcCall): Identity => {
    if (accountId && account && JSON.stringify(call.params ?? []).toLowerCase().includes(account)) return accountId;
    return publicId;
  };

  const answer = async (call: JsonRpcCall): Promise<unknown> => {
    const id = call.id ?? null;
    if (typeof call.method !== "string") return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } };
    const params = Array.isArray(call.params) ? call.params : [];
    try {
      const result = await client.read(identityFor(call), opts.chainId, call.method, params);
      return { jsonrpc: "2.0", id, result };
    } catch (e) {
      return { jsonrpc: "2.0", id, error: toRpcError(e) };
    }
  };

  const rpcFetch = async (url: string, init?: RequestInit, request?: Request): Promise<Response> => {
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if (method !== "POST") throw new TypeError("railgun rpc: POST only");
    // The body may be a string, ArrayBuffer, typed array or Blob (the worker bridge sends an ArrayBuffer).
    const text =
      init?.body !== undefined && init.body !== null
        ? typeof init.body === "string"
          ? init.body
          : await new Response(init.body).text()
        : request
          ? await request.text()
          : "";
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, url);
    }
    if (new URL(url).pathname !== `/${opts.chainId}`) throw new TypeError("railgun rpc: wrong chain path");
    if (Array.isArray(body)) return jsonResponse(await Promise.all(body.map((c) => answer(c as JsonRpcCall))), url);
    return jsonResponse(await answer(body as JsonRpcCall), url);
  };

  const other = createRailgunFetch({
    client,
    squidHosts: [hostOf(opts.subsquidEndpoint)],
    poiHosts: [hostOf(opts.poiEndpoint)],
    artifactHosts: opts.artifactHosts ?? ARTIFACT_HOSTS,
    bundlerHosts: opts.bundlerHosts ?? [],
  });

  const transportFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
    const url = request ? request.url : String(input);
    let host: string;
    try {
      host = new URL(url).host.toLowerCase();
    } catch {
      throw new TypeError("railgun fetch: invalid URL");
    }
    if (host === rpcHost) return rpcFetch(url, init, request);
    return other(input, init);
  };

  return { fetch: transportFetch as typeof fetch, rpcUrl };
}
