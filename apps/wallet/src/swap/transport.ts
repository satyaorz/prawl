/** Network boundary for the FHE SDK. No request here uses the browser network. */
import type { AnonRpcClient } from "@prawl/anon-rpc";

export const FHE_SEPOLIA_CHAIN_ID = 11155111;
const RELAYER = "relayer.testnet.zama.org";
const KEY_STORE = "zama-mpc-testnet-public-efd88e2b.s3.eu-west-1.amazonaws.com";
const RPC_METHODS = new Set(["eth_chainId", "eth_blockNumber", "eth_call", "eth_getCode"]);

/** Both gateway requests and SDK contract reads use this wallet's isolated circuit. */
export function createFheTransport(client: AnonRpcClient, account: string, chainId: number) {
  if (chainId !== FHE_SEPOLIA_CHAIN_ID) throw new Error("FHE swap is not configured for this chain");
  const identity = client.identities.account(account);

  return {
    async rpc(method: string, params: unknown[] = []): Promise<unknown> {
      if (!RPC_METHODS.has(method)) throw new Error(`FHE RPC method not allowed: ${method}`);
      return client.read(identity, chainId, method, params);
    },

    async fetch(url: string, method: string, headers: [string, string][], body: ArrayBuffer | null): Promise<Response> {
      const target = new URL(url);
      const verb = method.toUpperCase();
      if (target.protocol !== "https:" || target.username || target.password || target.port || target.hash) {
        throw new Error("FHE endpoint is not allowed");
      }
      if (target.hostname !== RELAYER && target.hostname !== KEY_STORE) throw new Error("FHE endpoint is not allowed");
      if (verb !== "GET" && verb !== "POST") throw new Error("FHE HTTP method is not allowed");
      if (target.hostname === KEY_STORE && verb !== "GET") throw new Error("FHE key store is read only");
      if (verb === "GET" && body) throw new Error("FHE GET request cannot have a body");
      const result = await client.http(identity, {
        url: target.href,
        method: verb,
        headers: Object.fromEntries(headers),
        ...(body ? { body: new TextDecoder("utf-8", { fatal: true }).decode(body) } : {}),
        ...(verb === "POST" ? { kind: "write" as const } : {}),
        // The default 15 s / 30 s is too short for the ~4.6 MB key download or a
        // gateway call over Tor. These only lengthen this one request.
        deadlines: target.hostname === KEY_STORE ? { headersMs: 60_000, totalMs: 300_000 } : { headersMs: 60_000, totalMs: 180_000 },
        passHttpErrors: true,
      });
      const response = new Response(result.body as BodyInit, { status: result.status, statusText: result.statusText, headers: result.headers });
      Object.defineProperty(response, "url", { value: result.url });
      return response;
    },
  };
}
