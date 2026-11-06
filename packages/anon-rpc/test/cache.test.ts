import { describe, expect, it } from "vitest";
import { blockRefOf } from "../src/cache";
import { ADDR_A, ADDR_B, okRpc, setup } from "./fake-worker";

const slow = (c: Parameters<typeof okRpc>[0]) => ({ ...(okRpc(c) as object), delayMs: 10 }) as never;
// These tests count requests; the default 40 ms test deadlines can fire on a loaded machine and add a retry.
const relaxed = { client: { deadlines: { headersMs: 5_000, totalMs: 10_000 } } };

describe("rule 7: dedupe and finalized cache", () => {
  it("joins identical in-flight reads pinned to a block number", async () => {
    const s = setup(slow, relaxed);
    const a = s.client.identities.account(ADDR_A);
    const p = [ADDR_A, "0x1234"];
    const [x, y] = await Promise.all([s.client.read(a, 1, "eth_getBalance", p), s.client.read(a, 1, "eth_getBalance", p)]);
    expect(x).toBe(y);
    expect(s.log).toHaveLength(1);
    expect(s.client.stats().cache.deduped).toBe(1);
  });

  it("does not dedupe or cache 'latest' reads", async () => {
    const s = setup(slow, relaxed);
    const a = s.client.identities.account(ADDR_A);
    await Promise.all([s.client.read(a, 1, "eth_getBalance", [ADDR_A, "latest"]), s.client.read(a, 1, "eth_getBalance", [ADDR_A, "latest"])]);
    await s.client.read(a, 1, "eth_getBalance", [ADDR_A, "latest"]);
    expect(s.log).toHaveLength(3);
  });

  it("caches results at or below the finalized block, not above", async () => {
    const s = setup(okRpc, relaxed); // head 0x1000 = 4096, finalized = 4096 - 96 = 4000
    await s.client.head(1);
    const a = s.client.identities.account(ADDR_A);
    const final = [ADDR_A, `0x${(4000).toString(16)}`];
    const fresh = [ADDR_A, `0x${(4090).toString(16)}`];
    await s.client.read(a, 1, "eth_getBalance", final);
    await s.client.read(a, 1, "eth_getBalance", final);
    await s.client.read(a, 1, "eth_getBalance", fresh);
    await s.client.read(a, 1, "eth_getBalance", fresh);
    const balanceCalls = s.log.filter((c) => (c.json as { method: string }).method === "eth_getBalance");
    expect(balanceCalls).toHaveLength(3);
    expect(s.client.stats().cache.hits).toBe(1);
  });

  it("caches reads pinned by block hash and immutable eth_chainId", async () => {
    const s = setup(okRpc, relaxed);
    const a = s.client.identities.account(ADDR_A);
    const byHash = [ADDR_A, { blockHash: `0x${"ab".repeat(32)}` }];
    await s.client.read(a, 1, "eth_getBalance", byHash);
    await s.client.read(a, 1, "eth_getBalance", byHash);
    await s.client.read(a, 1, "eth_chainId");
    await s.client.read(a, 1, "eth_chainId");
    expect(s.log).toHaveLength(2);
  });

  it("never caches errors", async () => {
    let n = 0;
    const s = setup((c) => (n++ === 0 ? { json: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "header not found" } } } : okRpc(c)), relaxed);
    const a = s.client.identities.account(ADDR_A);
    s.client.setFinalizedBlock(1, 10_000n);
    await expect(s.client.read(a, 1, "eth_getBalance", [ADDR_A, "0x10"])).rejects.toMatchObject({ code: "RPC_ERROR" });
    await expect(s.client.read(a, 1, "eth_getBalance", [ADDR_A, "0x10"])).resolves.toBe("0x1");
    expect(s.log).toHaveLength(2);
  });

  it("still runs the cross-identity guard before joining a deduped read", async () => {
    const s = setup(slow, relaxed);
    const a = s.client.identities.account(ADDR_A);
    const b = s.client.identities.account(ADDR_B);
    const first = s.client.read(a, 1, "eth_getBalance", [ADDR_A, "0x1234"]);
    await expect(s.client.read(b, 1, "eth_getBalance", [ADDR_A, "0x1234"])).rejects.toMatchObject({ code: "CROSS_IDENTITY" });
    await first;
  });

  it("recognises pinned block params per method", () => {
    expect(blockRefOf("eth_call", [{}, "0x10"])).toEqual({ kind: "number", n: 16n });
    expect(blockRefOf("eth_call", [{}, "latest"])).toBeUndefined();
    expect(blockRefOf("eth_getStorageAt", ["0x", "0x0", "0x10"])).toEqual({ kind: "number", n: 16n });
    expect(blockRefOf("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x10" }])).toEqual({ kind: "number", n: 16n });
    expect(blockRefOf("eth_getLogs", [{ fromBlock: "0x1", toBlock: "latest" }])).toBeUndefined();
    expect(blockRefOf("eth_getTransactionReceipt", ["0x"])).toBeUndefined();
  });
});
