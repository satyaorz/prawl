import { describe, expect, it } from "vitest";
import { AnonRpcError } from "../src/errors";
import { ADDR_A, ADDR_B, okRpc, setup, sleep } from "./fake-worker";

describe("rule 1: one request path, traced", () => {
  it("reads, writes and HTTP GETs all go through the same worker path and each attempt is traced", async () => {
    const s = setup(
      (c) => (c.host === "ppoi.fdi.network" ? { bytes: "ok", headers: { "content-type": "text/plain" } } : okRpc(c)),
      { client: { httpHosts: ["ppoi.fdi.network"] } },
    );
    const a = s.client.identities.account(ADDR_A);
    await s.client.read(a, 1, "eth_getBalance", [ADDR_A, "latest"]);
    await s.client.write(s.client.identities.ephemeral("send"), 1, "eth_sendRawTransaction", ["0x02"]);
    const got = await s.client.http(s.client.identities.publicScope("railgun"), { url: "https://ppoi.fdi.network/health" });
    expect(new TextDecoder().decode(got.body)).toBe("ok");

    expect(s.workers).toHaveLength(1);
    expect(s.log.map((c) => c.host)).toEqual(["ethereum-rpc.publicnode.com", "rpc.mevblocker.io", "ppoi.fdi.network"]);
    expect(s.traces.map((t) => [t.kind, t.method])).toEqual([
      ["read", "eth_getBalance"],
      ["write", "eth_sendRawTransaction"],
      ["get", "http:GET"],
    ]);
    const t = s.traces[0]!;
    expect(t.identity).toBe("acct:0x0000…00aa");
    expect(t.host).toBe("ethereum-rpc.publicnode.com");
    expect(t.bytesOut).toBeGreaterThan(40);
    expect(t.bytesIn).toBeGreaterThan(10);
    expect(t.status).toBe(200);
    expect(t.ok).toBe(true);
    expect(t.durationMs).toBeGreaterThanOrEqual(0);
    expect(t.circuit).toBe("publicnode-mainnet#0");
  });

  it("records the error code on a failed attempt", async () => {
    const s = setup(() => ({ error: { code: "TLS", message: "handshake failed" } }), { client: { failover: false } });
    const a = s.client.identities.account(ADDR_A);
    await expect(s.client.read(a, 1, "eth_blockNumber")).rejects.toMatchObject({ code: "TLS" });
    expect(s.traces.map((t) => t.code)).toEqual(["TLS", "TLS"]);
    expect(s.traces.every((t) => t.ok === false && t.status === undefined)).toBe(true);
  });

  it("refuses methods outside the read and write allowlists", async () => {
    const s = setup();
    const a = s.client.identities.account(ADDR_A);
    await expect(s.client.read(a, 1, "eth_sign", [ADDR_A, "0x00"])).rejects.toMatchObject({ code: "POLICY" });
    await expect(s.client.read(a, 1, "eth_sendRawTransaction", ["0x"])).rejects.toMatchObject({ code: "POLICY" });
    await expect(s.client.write(a, 1, "eth_call", [])).rejects.toMatchObject({ code: "POLICY" });
    expect(s.log).toHaveLength(0);
  });

  it("sends a constant user agent", async () => {
    const s = setup();
    await s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber");
    expect(s.log[0]!.headers["user-agent"]).toBe("Mozilla/5.0");
  });
});

describe("rule 2: deadlines", () => {
  it("a headers timeout aborts only that request; the worker stays and other identities' calls finish", async () => {
    const s = setup((c) =>
      c.identityKey === `acct:${ADDR_A}` ? { hang: true } : { ...(okRpc(c) as object), delayMs: 20 } as never,
    );
    const a = s.client.identities.account(ADDR_A);
    const b = s.client.identities.account(ADDR_B);
    const pa = s.client.read(a, 1, "eth_blockNumber");
    const pb = s.client.read(b, 1, "eth_blockNumber");
    await expect(pa).rejects.toMatchObject({ code: "TIMEOUT_HEADERS" });
    await expect(pb).resolves.toBe("0x1000");
    expect(s.workers).toHaveLength(1);
    expect(s.workers[0]!.closed).toBe(false);
    expect(s.host.stats.boots).toBe(1);
  });

  it("a silent hang that ignores abort still ends at our deadline", async () => {
    const s = setup(() => ({ hang: true }), { client: { failover: false } });
    const t0 = performance.now();
    await expect(s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber")).rejects.toMatchObject({
      code: "TIMEOUT_HEADERS",
    });
    // two attempts × 40 ms headers deadline, nowhere near "forever"
    expect(performance.now() - t0).toBeLessThan(400);
  });

  it("the body timer cancels the reader when headers arrived but the body stalls", async () => {
    const s = setup(() => ({ stallBody: true }), { client: { failover: false } });
    await expect(s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber")).rejects.toMatchObject({
      code: "TIMEOUT_BODY",
    });
    expect(s.workers[0]!.bodyCancels).toBe(2);
    expect(s.workers[0]!.closed).toBe(false);
  });

  it("the request deadline starts after boot: a 120 ms boot does not eat a 40 ms headers budget", async () => {
    const s = setup(okRpc, { ready: [120] });
    await expect(s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber")).resolves.toBe("0x1000");
    expect(s.traces).toHaveLength(1);
  });

  it("aborting through the caller's signal ends the request with ABORTED and is not retried", async () => {
    const s = setup(() => ({ hang: true }), { client: { httpHosts: ["rail-squid.squids.live"], deadlines: { headersMs: 5_000, totalMs: 5_000 } } });
    const ac = new AbortController();
    const p = s.client.http(s.client.identities.publicScope("railgun"), { url: "https://rail-squid.squids.live/x", signal: ac.signal });
    await sleep(10);
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AnonRpcError);
    await expect(p).rejects.toMatchObject({ code: "ABORTED" });
    expect(s.log).toHaveLength(1);
  });
});
