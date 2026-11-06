import { describe, expect, it } from "vitest";
import { createRailgunFetch } from "../src/railgun-fetch";
import { setup, type Handler } from "./fake-worker";

const SQUID = "rail-squid.squids.live";
const POI = "ppoi.fdi.network";
const GH = "raw.githubusercontent.com";
const BUNDLER = "public.pimlico.io";

function shim(handler: Handler) {
  const s = setup(handler, { client: { httpHosts: [SQUID, POI, GH, BUNDLER], deadlines: { headersMs: 40, totalMs: 80 } } });
  const f = createRailgunFetch({ client: s.client, squidHosts: [SQUID], poiHosts: [POI], artifactHosts: [GH], bundlerHosts: [BUNDLER] });
  return { ...s, f };
}

describe("rule 11: RAILGUN fetch shim", () => {
  it("refuses hosts outside the exact allowlist, and http:, without touching the worker", async () => {
    const s = shim(() => ({ json: {} }));
    await expect(s.f("https://evil.example/x")).rejects.toBeInstanceOf(TypeError);
    await expect(s.f(`https://sub.${POI}/x`)).rejects.toBeInstanceOf(TypeError);
    await expect(s.f(`http://${POI}/x`)).rejects.toBeInstanceOf(TypeError);
    expect(s.log).toHaveLength(0);
  });

  it("returns a real Response with url set, constant UA and a constant JSON-RPC id restored on the way back", async () => {
    const s = shim((c) => ({ json: { jsonrpc: "2.0", id: (c.json as { id: number }).id, result: true } }));
    const res = await s.f(`https://${POI}/`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "reqwest/0.12 wasm", "x-trace": "abc" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4711, method: "ppoi_validated_txid", params: {} }),
    });
    expect(res).toBeInstanceOf(Response);
    expect(res.url).toBe(`https://${POI}/`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 4711, result: true });
    const sent = s.log[0]!;
    expect((sent.json as { id: number }).id).toBe(1);
    expect(sent.headers["user-agent"]).toBe("Mozilla/5.0");
    expect(sent.headers["x-trace"]).toBeUndefined();
    expect(sent.key).toMatch(/^public:railgun:ppoi\.fdi\.network@/);
  });

  it("asks Subsquid for gzip and decompresses the answer", async () => {
    const page = JSON.stringify({ data: { commitments: Array.from({ length: 50 }, (_, i) => ({ id: i })) } });
    const gz = new Uint8Array(await new Response(new Blob([page]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    const s = shim(() => ({ bytes: gz, headers: { "content-type": "application/json", "content-encoding": "gzip" } }));
    const res = await s.f(`https://${SQUID}/squid-railgun-eth-sepolia-v2/v/v1/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ commitments(limit: 50) { id } }" }),
    });
    expect(s.log[0]!.headers["accept-encoding"]).toBe("gzip");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe(page);
  });

  it("gives each proof submission a fresh identity and never retries it", async () => {
    const s = shim(() => ({ error: { code: "CONNECTION", message: "x" } }));
    const submit = () =>
      s.f(`https://${POI}/`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ppoi_submit_transact_proof", params: {} }) });
    await expect(submit()).rejects.toBeInstanceOf(TypeError);
    await expect(submit()).rejects.toBeInstanceOf(TypeError);
    expect(s.log).toHaveLength(2); // one attempt each
    expect(s.log[0]!.key).toMatch(/^eph:railgun-submit:/);
    expect(s.log[0]!.identityKey).not.toBe(s.log[1]!.identityKey);
  });

  it("gives each bundler call a fresh identity", async () => {
    const s = shim((c) => ({ json: { jsonrpc: "2.0", id: (c.json as { id: number }).id, result: [] } }));
    for (let i = 0; i < 2; i++) {
      await s.f(`https://${BUNDLER}/v2/11155111/rpc`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "eth_supportedEntryPoints", params: [] }) });
    }
    expect(s.log[0]!.identityKey).not.toBe(s.log[1]!.identityKey);
    expect(s.log.every((c) => c.key!.startsWith("eph:railgun-submit:"))).toBe(true);
  });

  it("retries public sync reads once on a fresh circuit and passes HTTP errors through as a Response", async () => {
    let n = 0;
    const s = shim(() => (n++ === 0 ? { error: { code: "HTTP_REQUEST", message: "x" } } : { bytes: "not found", status: 404, headers: {} }));
    const res = await s.f(`https://${GH}/kassandraoftroy/kohaku-artifacts/x/vkey.json`);
    expect(res.status).toBe(404);
    expect(res.url).toContain(GH);
    expect(s.log).toHaveLength(2);
  });
});
