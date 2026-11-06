import { describe, expect, it, vi } from "vitest";
import { loadOwnBootstrap } from "../src/bootstrap";
import { workerBundleResponse } from "../src/bundle-serving";
import { ADDR_A, okRpc, setup, sleep } from "./fake-worker";

const ZST = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]);

describe("rule 9: boot", () => {
  it("start() boots at app load, passes our snapshot, and (prewarm: \"chainId\") pre-warms on a throwaway key", async () => {
    // The 2026-11-06 baseline pre-warm, kept as an option. The default is now the head read (first-answer.test.ts).
    const s = setup(okRpc, { host: { bootstrapLoader: async () => ZST }, client: { prewarmChainId: 1, prewarm: "chainId" } });
    expect(s.workers).toHaveLength(0);
    s.client.start();
    await sleep(20);
    expect(s.workers).toHaveLength(1);
    expect(s.workers[0]!.bootstrap).toEqual(ZST);
    expect(s.log).toHaveLength(1);
    const warm = s.log[0]!;
    expect((warm.json as { method: string }).method).toBe("eth_chainId");
    expect(warm.key).toMatch(/^eph:prewarm:/);
    // Real identities never share the pre-warm key.
    await s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber");
    expect(s.log[1]!.key).not.toBe(warm.key);
    expect(s.workers).toHaveLength(1);
  });

  it("boots without a snapshot when ours is unavailable", async () => {
    const s = setup(okRpc, { host: { bootstrapLoader: async () => undefined } });
    await s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber");
    expect(s.workers[0]!.bootstrap).toBeUndefined();
    const t = setup(okRpc, { host: { bootstrapLoader: async () => Promise.reject(new Error("404")) } });
    await expect(t.client.read(t.client.identities.account(ADDR_A), 1, "eth_blockNumber")).resolves.toBe("0x1000");
  });

  it("replaces a worker whose boot misses the deadline (and closes it)", async () => {
    const s = setup(okRpc, { ready: ["never", "resolve"], host: { bootDeadlineMs: 50 } });
    await expect(s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber")).resolves.toBe("0x1000");
    expect(s.workers).toHaveLength(2);
    expect(s.workers[0]!.closed).toBe(true);
    expect(s.workers[1]!.closed).toBe(false);
    expect(s.events.find((e) => e.type === "boot-failed")).toMatchObject({ code: "BOOT_TIMEOUT" });
  });

  it("replaces a worker whose boot fails", async () => {
    const s = setup(okRpc, { ready: ["reject", "resolve"] });
    await expect(s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber")).resolves.toBe("0x1000");
    expect(s.workers).toHaveLength(2);
    expect(s.events.find((e) => e.type === "boot-failed")).toMatchObject({ code: "BOOT_FAILED" });
  });

  it("fails loudly (no direct fallback) when every boot fails", async () => {
    const direct = vi.spyOn(globalThis, "fetch");
    const s = setup(okRpc, { ready: ["reject"], host: { maxBootAttempts: 2 } });
    await expect(s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber")).rejects.toMatchObject({ code: "BOOT_FAILED" });
    expect(s.log).toHaveLength(0);
    expect(direct).not.toHaveBeenCalled();
    direct.mockRestore();
  });

  it("after a failed boot cycle, fails fast for the cool-down, then boots again", async () => {
    const s = setup(okRpc, { ready: ["reject", "reject", "resolve"], host: { maxBootAttempts: 2, coolDownMs: 60 } });
    const a = s.client.identities.account(ADDR_A);
    await expect(s.client.read(a, 1, "eth_blockNumber")).rejects.toMatchObject({ code: "BOOT_FAILED" });
    await expect(s.client.read(a, 1, "eth_blockNumber")).rejects.toMatchObject({ code: "BOOT_FAILED" });
    expect(s.workers).toHaveLength(2); // the second call did not boot
    await sleep(80);
    await expect(s.client.read(a, 1, "eth_blockNumber")).resolves.toBe("0x1000");
    expect(s.workers).toHaveLength(3);
  });

  it("replaces the worker only after repeated failures across fresh circuits", async () => {
    let healthy = false;
    const s = setup((c) => (healthy || c.workerIndex > 0 ? okRpc(c) : { error: { code: "CONNECTION", message: "x" } }), {
      client: { failover: false },
      host: { failureThreshold: 3 },
    });
    const a = s.client.identities.account(ADDR_A);
    for (let i = 0; i < 2; i++) await expect(s.client.read(a, 1, "eth_blockNumber")).rejects.toBeTruthy();
    expect(s.workers).toHaveLength(1); // two bad requests: keep the worker
    await expect(s.client.read(a, 1, "eth_blockNumber")).rejects.toBeTruthy();
    expect(s.events.some((e) => e.type === "replace")).toBe(true);
    await expect(s.client.read(a, 1, "eth_blockNumber")).resolves.toBe("0x1000");
    expect(s.workers).toHaveLength(2);
    await sleep(80);
    expect(s.workers[0]!.closed).toBe(true);
    healthy = true;
  });

  it("a success in between resets the failure count", async () => {
    let n = 0;
    const s = setup((c) => ((n++ % 3) < 2 ? { error: { code: "CONNECTION", message: "x" } } : okRpc(c)), {
      client: { failover: false },
      host: { failureThreshold: 2 },
    });
    const a = s.client.identities.account(ADDR_A);
    for (let i = 0; i < 4; i++) {
      await s.client.read(a, 1, "eth_blockNumber").catch(() => undefined);
      await s.client.read(a, 1, "eth_chainId").catch(() => undefined);
    }
    expect(s.workers).toHaveLength(1);
  });
});

describe("own snapshot loader", () => {
  const origin = "https://prawl.example";
  const fake = (res: Response) => vi.fn(async () => res) as unknown as typeof fetch;

  it("returns the bytes from our own origin", async () => {
    const f = fake(new Response(ZST));
    expect(await loadOwnBootstrap({ origin, fetchFn: f })).toEqual(ZST);
    expect((f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]).toBe("https://prawl.example/tor/bootstrap.zip.zst");
  });

  it("skips it on 404, on non-zstd bytes, and for another origin", async () => {
    expect(await loadOwnBootstrap({ origin, fetchFn: fake(new Response("nope", { status: 404 })) })).toBeUndefined();
    expect(await loadOwnBootstrap({ origin, fetchFn: fake(new Response("<html>")) })).toBeUndefined();
    const f = fake(new Response(ZST));
    expect(await loadOwnBootstrap({ origin, url: "https://cdn.example/tor/bootstrap.zip.zst", fetchFn: f })).toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("rule 10: bundle serving", () => {
  const path = `/anon-rpc/worker-0x${"5b".repeat(32)}.js`;
  it("serves brotli first, then gzip, with immutable caching", () => {
    const br = workerBundleResponse(path, "gzip, deflate, br, zstd", { br: true, gz: true })!;
    expect(br.suffix).toBe(".br");
    expect(br.headers["content-encoding"]).toBe("br");
    expect(br.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(br.headers.vary).toBe("accept-encoding");
    expect(workerBundleResponse(path, "gzip", { br: true, gz: true })!.suffix).toBe(".gz");
    expect(workerBundleResponse(path, "br;q=0, gzip", { br: true, gz: true })!.suffix).toBe(".gz");
    expect(workerBundleResponse(path, "", { br: true, gz: true })!.suffix).toBe("");
  });
  it("only applies to hash-named worker files", () => {
    expect(workerBundleResponse("/anon-rpc/worker-latest.js", "br", { br: true, gz: true })).toBeUndefined();
  });
});
