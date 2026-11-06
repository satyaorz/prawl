/**
 * The "unsafe at any speed" list from the report, as executable checks.
 */
import { describe, expect, it, vi } from "vitest";
import { aggregate3, calls } from "../src/multicall";
import { ADDR_A, ADDR_B, okRpc, setup, sleep } from "./fake-worker";

const TOKEN = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

describe("unsafe cases are refused", () => {
  it("cross-identity JSON-RPC batch is rejected", async () => {
    const s = setup();
    const a = s.client.identities.account(ADDR_A);
    s.client.identities.account(ADDR_B);
    await expect(
      s.client.batch(a, 1, [
        { method: "eth_getBalance", params: [ADDR_A, "latest"] },
        { method: "eth_getBalance", params: [ADDR_B, "latest"] },
      ]),
    ).rejects.toMatchObject({ code: "CROSS_IDENTITY" });
    expect(s.log).toHaveLength(0);
  });

  it("cross-identity Multicall is rejected", async () => {
    const s = setup();
    const a = s.client.identities.account(ADDR_A);
    const b = s.client.identities.account(ADDR_B);
    await expect(aggregate3(s.client, a, 1, [calls.balanceOf(TOKEN, a), calls.balanceOf(TOKEN, b)], "0x10")).rejects.toMatchObject({
      code: "CROSS_IDENTITY",
    });
    expect(s.log).toHaveLength(0);
  });

  it("there is no direct fallback: a dead route fails loudly and global fetch is never called", async () => {
    const direct = vi.spyOn(globalThis, "fetch");
    const s = setup(() => ({ hang: true }));
    await expect(s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber")).rejects.toMatchObject({ code: "TIMEOUT_HEADERS" });
    expect(s.log.length).toBe(3); // primary, fresh circuit, one failover: all through the worker
    expect(direct).not.toHaveBeenCalled();
    direct.mockRestore();
  });

  it("writes are not retried", async () => {
    const s = setup(() => ({ error: { code: "CONNECTION", message: "x" } }));
    await expect(s.client.write(s.client.identities.ephemeral("send"), 1, "eth_sendRawTransaction", ["0x02"])).rejects.toMatchObject({
      code: "CONNECTION",
    });
    expect(s.log).toHaveLength(1);
  });

  it("a timeout keeps the worker: in-flight calls of other identities complete and no re-boot happens", async () => {
    const s = setup((c) => (c.identityKey === `acct:${ADDR_A}` ? { hang: true } : { ...(okRpc(c) as object), delayMs: 25 }) as never, {
      client: { deadlines: { headersMs: 30, totalMs: 200 }, failover: false },
    });
    const pa = s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber");
    await sleep(20);
    // B starts at ~20 ms and answers at ~45 ms; A's first timeout fires at 30 ms while B is in flight.
    const pb = s.client.read(s.client.identities.account(ADDR_B), 1, "eth_blockNumber");
    await expect(pa).rejects.toMatchObject({ code: "TIMEOUT_HEADERS" });
    await expect(pb).resolves.toBe("0x1000");
    expect(s.workers).toHaveLength(1);
    expect(s.workers[0]!.closed).toBe(false);
    expect(s.host.stats.boots).toBe(1);
  });

  it("identities cannot be merged through a forged or shared key string", async () => {
    const s = setup();
    await expect(s.client.read({ key: "acct:shared" } as never, 1, "eth_blockNumber")).rejects.toMatchObject({ code: "UNKNOWN_IDENTITY" });
  });
});
