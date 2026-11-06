/**
 * Time to first answer (2026-11-06): the pre-warm is the shared head read,
 * blockTag() never waits for a head, warm() opens an identity's own circuit
 * with a neutral request, and slow reads opt out of fork v3's reused-connection
 * stall deadline. None of this may weaken isolation: no address-naming read on
 * another identity's key, no cross-identity batch, no direct fallback.
 */
import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, parseAbi } from "viem";
import { aggregate3Read, calls, MULTICALL3 } from "../src/multicall";
import { ADDR_A, ADDR_B, okRpc, setup, sleep, type Handler } from "./fake-worker";

const methodOf = (c: { json: unknown }) => (c.json as { method?: string })?.method;
const ADDR_RE = /[0-9a-f]{40}/i;

/** Head reads answer after `headDelayMs`; everything else at once. */
const slowHead =
  (headDelayMs: number, head = "0x1000"): Handler =>
  (c) => {
    if (methodOf(c) === "eth_blockNumber") return { json: { jsonrpc: "2.0", id: 1, result: head }, delayMs: headDelayMs };
    return okRpc(c);
  };

describe("pre-warm is the shared head read", () => {
  it("by default start() sends eth_blockNumber on the public head scope, naming no address", async () => {
    const s = setup(okRpc, { client: { prewarmChainId: 1 } });
    s.client.start();
    await sleep(20);
    expect(s.log).toHaveLength(1);
    const warm = s.log[0]!;
    expect(methodOf(warm)).toBe("eth_blockNumber");
    expect(warm.identityKey).toBe("public:head:1");
    expect(warm.body).not.toMatch(ADDR_RE);
    expect(warm.anonOptions).toEqual({ isolationKey: warm.key, idempotent: true });
  });

  it("its answer is the head: pinnedBlock and head() within the TTL send nothing more", async () => {
    const s = setup(okRpc, { client: { prewarmChainId: 1 } });
    s.client.start();
    await sleep(20);
    expect(await s.client.pinnedBlock(1, 8)).toBe(`0x${(0x1000 - 8).toString(16)}`);
    expect(await s.client.head(1)).toBe(0x1000n);
    expect(s.log).toHaveLength(1);
  });

  it("a later head refresh uses the pre-warm's key (so a keep-alive worker can reuse its connection), and no identity ever does", async () => {
    let now = 0;
    const s = setup(okRpc, { client: { prewarmChainId: 1, headTtlMs: 1000, now: () => now } });
    s.client.start();
    await sleep(20);
    now = 5000;
    await s.client.head(1);
    expect(s.log).toHaveLength(2);
    expect(s.log[1]!.key).toBe(s.log[0]!.key);
    await s.client.read(s.client.identities.account(ADDR_A), 1, "eth_getBalance", [ADDR_A, "latest"]);
    expect(s.log[2]!.key).not.toBe(s.log[0]!.key);
    expect(s.log[2]!.identityKey).toMatch(/^acct:/);
  });

  it("an identity's first read does not wait for the pre-warm head", async () => {
    const s = setup(slowHead(300), { client: { prewarmChainId: 1, deadlines: { headersMs: 1000, totalMs: 2000 } } });
    s.client.start();
    const a = s.client.identities.account(ADDR_A);
    const t0 = performance.now();
    const tag = s.client.blockTag(1, 8);
    expect(tag).toBe("latest");
    await s.client.batch(a, 1, [aggregate3Read(a, [calls.ethBalance(a), calls.blockNumber()], tag), { method: "eth_getCode", params: [ADDR_A, tag] }]);
    expect(performance.now() - t0).toBeLessThan(250);
    // The batch went out on A's key first; the pre-warm head waited for A's answer (boot priority).
    expect(s.log.map((c) => c.identityKey)).toEqual([expect.stringMatching(/^acct:/), "public:head:1"]);
  });
});

describe("boot priority: the identity's first request claims the first circuit", () => {
  /** Worker ready after 30 ms, so requests queue at boot as they do live. */
  const bootSetup = (handler: Handler, client: Record<string, unknown> = {}) =>
    setup(handler, { ready: [30], client: { prewarmChainId: 1, deadlines: { headersMs: 1000, totalMs: 2000 }, ...client } });

  it("head reads queued at boot go out only after the account's first answer", async () => {
    const s = bootSetup((c) => (methodOf(c) === "eth_blockNumber" ? okRpc(c) : { ...(okRpc(c) as object), delayMs: 40 } as never));
    s.client.start(); // pre-warm head, queued first
    const sepoliaHead = s.client.head(11155111); // a scan's head, queued second
    const a = s.client.identities.account(ADDR_A);
    const batch = s.client.batch(a, 1, [aggregate3Read(a, [calls.ethBalance(a)], s.client.blockTag(1)), { method: "eth_getCode", params: [ADDR_A, "latest"] }]);
    await Promise.all([batch, sepoliaHead]);
    await sleep(20);
    const order = s.log.map((c) => c.identityKey);
    expect(order[0]).toMatch(/^acct:/);
    expect(new Set(order.slice(1))).toEqual(new Set(["public:head:1", "public:head:11155111"]));
    // Both heads were sent after A's answer arrived (A took 40 ms).
    const traces = s.traces;
    const aDone = traces.find((t) => t.identity.startsWith("acct:"))!;
    for (const t of traces.filter((t) => t.method === "eth_blockNumber")) expect(t.startedAt).toBeGreaterThanOrEqual(aDone.startedAt + 35);
  });

  it("the wait is bounded by headDeferMs when the identity's request hangs", async () => {
    const s = bootSetup((c) => (methodOf(c) === "eth_blockNumber" ? okRpc(c) : { hang: true }), { headDeferMs: 60 });
    s.client.start();
    const a = s.client.identities.account(ADDR_A);
    void s.client.read(a, 1, "eth_getBalance", [ADDR_A, "latest"]).catch(() => undefined);
    const t0 = performance.now();
    await sleep(25); // worker ready at 30 ms
    await vi.waitFor(() => expect(s.log.some((c) => c.identityKey === "public:head:1")).toBe(true), { timeout: 500 });
    const waited = performance.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(60);
    expect(waited).toBeLessThan(400);
  });

  it("with no identity request pending, a head read goes at once; after the first answer heads never wait again", async () => {
    const s = bootSetup(okRpc, { headDeferMs: 5_000, headTtlMs: 0 });
    const t0 = performance.now();
    await s.client.head(1);
    expect(performance.now() - t0).toBeLessThan(500);
    const a = s.client.identities.account(ADDR_A);
    await s.client.read(a, 1, "eth_getBalance", [ADDR_A, "latest"]);
    const t1 = performance.now();
    const pa = s.client.read(a, 1, "eth_getBalance", [ADDR_A, "latest"]);
    await s.client.head(1);
    await pa;
    expect(performance.now() - t1).toBeLessThan(500);
  });

  it("is off with bootPriority: false (the 2026-11-06 baseline order)", async () => {
    const s = bootSetup(okRpc, { bootPriority: false, prewarm: "chainId" });
    s.client.start();
    const a = s.client.identities.account(ADDR_A);
    const h = s.client.head(1);
    await s.client.read(a, 1, "eth_getBalance", [ADDR_A, "latest"]);
    await h;
    // FIFO as before: the head is not deferred behind the account (the old pre-warm re-queues after ready, so it is last).
    expect(s.log.map((c) => c.identityKey?.split(":")[0])).toEqual(["public", "acct", "eph"]);
  });

  it("never moves a head read onto an identity's key, and never delays identity requests", async () => {
    const s = bootSetup(okRpc);
    s.client.start();
    const a = s.client.identities.account(ADDR_A);
    const b = s.client.identities.account(ADDR_B);
    await Promise.all([s.client.read(a, 1, "eth_getBalance", [ADDR_A, "latest"]), s.client.read(b, 1, "eth_getBalance", [ADDR_B, "latest"])]);
    await sleep(20);
    for (const c of s.log) {
      if (methodOf(c) === "eth_blockNumber") expect(c.identityKey).toBe("public:head:1");
      else expect(c.body.toLowerCase()).toContain(c.identityKey!.slice(5));
    }
    expect(s.log.slice(0, 2).every((c) => c.identityKey!.startsWith("acct:"))).toBe(true);
  });
});

describe("blockTag() never waits", () => {
  it("returns latest with no head, and starts one head read in the background on the public scope only", async () => {
    const s = setup(slowHead(20));
    expect(s.client.blockTag(1)).toBe("latest");
    expect(s.client.blockTag(1)).toBe("latest"); // deduped with the in-flight head read
    await sleep(80);
    const heads = s.log.filter((c) => methodOf(c) === "eth_blockNumber");
    expect(heads).toHaveLength(1);
    expect(heads[0]!.identityKey).toBe("public:head:1");
    expect(s.client.blockTag(1, 8)).toBe(`0x${(0x1000 - 8).toString(16)}`);
  });

  it("pins to a stale head within headMaxStaleMs while refreshing it, and falls back to latest beyond", async () => {
    let now = 0;
    let head = "0x1000";
    const s = setup((c) => (methodOf(c) === "eth_blockNumber" ? { json: { jsonrpc: "2.0", id: 1, result: head } } : okRpc(c)), {
      client: { headTtlMs: 12_000, headMaxStaleMs: 60_000, now: () => now },
    });
    await s.client.head(1);
    expect(s.log).toHaveLength(1);
    now = 5_000;
    expect(s.client.blockTag(1, 0)).toBe("0x1000"); // fresh: no refresh
    await sleep(5);
    expect(s.log).toHaveLength(1);
    now = 30_000;
    head = "0x1002";
    expect(s.client.blockTag(1, 0)).toBe("0x1000"); // stale but usable, refresh started
    await sleep(5);
    expect(s.log).toHaveLength(2);
    expect(s.client.blockTag(1, 0)).toBe("0x1002");
    now = 200_000;
    head = "0x1003";
    expect(s.client.blockTag(1, 0)).toBe("latest"); // too old to pin
    await sleep(5);
    expect(s.log.filter((c) => methodOf(c) === "eth_blockNumber").every((c) => c.identityKey === "public:head:1")).toBe(true);
  });

  it("an aggregate3 at latest with getBlockNumber passes the cross-identity guard for its owner only", async () => {
    const s = setup();
    const a = s.client.identities.account(ADDR_A);
    const b = s.client.identities.account(ADDR_B);
    await s.client.batch(a, 1, [aggregate3Read(a, [calls.ethBalance(a), calls.blockNumber()], "latest")]);
    // B's address inside A's call is still refused.
    await expect(s.client.batch(a, 1, [aggregate3Read(a, [calls.ethBalance(b), calls.blockNumber()], "latest")])).rejects.toMatchObject({
      code: "CROSS_IDENTITY",
    });
    expect(s.log).toHaveLength(1);
  });

  it("calls.blockNumber() is Multicall3 getBlockNumber() and names nothing", () => {
    const c = calls.blockNumber();
    expect(c.target).toBe(MULTICALL3);
    expect(c.callData).toBe("0x42cbb15c");
    const abi = parseAbi(["function getBlockNumber() view returns (uint256)"]);
    expect(decodeFunctionData({ abi, data: c.callData }).functionName).toBe("getBlockNumber");
  });
});

describe("warm(identity)", () => {
  it("sends one eth_chainId on exactly the key the identity's own reads use", async () => {
    const s = setup();
    const a = s.client.identities.account(ADDR_A);
    await s.client.warm(a, 1);
    await s.client.read(a, 1, "eth_getBalance", [ADDR_A, "latest"]);
    expect(s.log).toHaveLength(2);
    expect(methodOf(s.log[0]!)).toBe("eth_chainId");
    expect(s.log[0]!.body).not.toMatch(ADDR_RE);
    expect(s.log[0]!.key).toBe(s.log[1]!.key);
    expect(s.traces[0]!.method).toBe("warm:eth_chainId");
  });

  it("is sent at most once per identity within the window, and never on another identity's key", async () => {
    let now = 0;
    const s = setup(okRpc, { client: { warmWindowMs: 50_000, now: () => now } });
    const a = s.client.identities.account(ADDR_A);
    const b = s.client.identities.account(ADDR_B);
    await s.client.warm(a, 1);
    await s.client.warm(a, 1);
    await s.client.warm(b, 1);
    expect(s.log.map((c) => c.identityKey)).toEqual([a.key, b.key]);
    now = 60_000;
    await s.client.warm(a, 1);
    expect(s.log).toHaveLength(3);
    expect(new Set(s.log.map((c) => c.identityKey))).toEqual(new Set([a.key, b.key]));
  });

  it("never fails over to a second provider, and swallows its own failure", async () => {
    const s = setup(() => ({ error: { code: "CONNECTION", message: "circuit failed" } }), { client: { failover: true } });
    const a = s.client.identities.account(ADDR_A);
    await expect(s.client.warm(a, 1)).resolves.toBeUndefined();
    expect(s.log.length).toBeGreaterThan(0);
    expect(new Set(s.log.map((c) => c.host))).toEqual(new Set(["ethereum-rpc.publicnode.com"]));
  });

  it("does nothing for an ephemeral identity and refuses a handle from another client", async () => {
    const s = setup();
    await s.client.warm(s.client.identities.ephemeral("x"), 1);
    expect(s.log).toHaveLength(0);
    const other = setup();
    await expect(s.client.warm(other.client.identities.account(ADDR_A), 1)).rejects.toMatchObject({ code: "UNKNOWN_IDENTITY" });
    expect(s.log).toHaveLength(0);
  });

  it("sends nothing outside the worker (no direct fallback)", async () => {
    const direct = vi.spyOn(globalThis, "fetch");
    const s = setup(okRpc, { ready: ["reject"], host: { maxBootAttempts: 1 } });
    await s.client.warm(s.client.identities.account(ADDR_A), 1);
    expect(direct).not.toHaveBeenCalled();
    direct.mockRestore();
  });
});

describe("reused-connection stall deadline (fork v3): slow reads opt out", () => {
  it("ordinary reads leave it to the worker's default; eth_getLogs sends 0; writes carry neither flag", async () => {
    const s = setup();
    const a = s.client.identities.account(ADDR_A);
    const scope = s.client.identities.publicScope("announcer-scan:sepolia");
    await s.client.read(a, 1, "eth_getBalance", [ADDR_A, "latest"]);
    await s.client.read(scope, 11155111, "eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x186a0" }]);
    await s.client.write(s.client.identities.ephemeral("send"), 1, "eth_sendRawTransaction", ["0x02f8"]);
    expect(s.log[0]!.anonOptions).toEqual({ isolationKey: s.log[0]!.key, idempotent: true });
    expect(s.log[1]!.anonOptions).toEqual({ isolationKey: s.log[1]!.key, idempotent: true, reusedHeadersTimeoutMs: 0 });
    expect(s.log[2]!.anonOptions).toEqual({ isolationKey: s.log[2]!.key });
  });

  it("an HTTP read with a raised headers deadline sends 0, a normal one does not", async () => {
    const s = setup(() => ({ bytes: "ok" }), { client: { httpHosts: ["squid.example"] } });
    const id = s.client.identities.publicScope("railgun:squid");
    await s.client.http(id, { url: "https://squid.example/graphql", method: "POST", body: "{}", deadlines: { headersMs: 20_000, totalMs: 90_000 } });
    await s.client.http(id, { url: "https://squid.example/health" });
    expect(s.log[0]!.anonOptions!.reusedHeadersTimeoutMs).toBe(0);
    expect(s.log[1]!.anonOptions!.reusedHeadersTimeoutMs).toBeUndefined();
  });
});
