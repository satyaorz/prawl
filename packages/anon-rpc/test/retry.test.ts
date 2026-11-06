import { describe, expect, it } from "vitest";
import { ADDR_A, okRpc, setup, type Behavior } from "./fake-worker";

const failing: Record<string, Behavior> = {
  CONNECTION: { error: { code: "CONNECTION", message: "END cell with reason RESOLVEFAILED" } },
  TLS: { error: { code: "TLS", message: "tls" } },
  HTTP_REQUEST: { error: { code: "HTTP_REQUEST", message: "peer closed connection" } },
  IO_ERROR: { error: { code: "IO_ERROR", message: "io" } },
  "timeout (silent hang)": { hang: true },
  "HTTP 403": { bytes: "<html>blocked</html>", status: 403, headers: { "content-type": "text/html" } },
  "HTTP 429": { json: { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "Too Many Requests" } }, status: 429 },
  "HTTP 502": { bytes: "bad gateway", status: 502 },
};

describe("rule 3: one retry on a fresh circuit", () => {
  for (const [name, behavior] of Object.entries(failing)) {
    it(`retries once on a fresh circuit after ${name}`, async () => {
      let n = 0;
      const s = setup((c) => (n++ === 0 ? behavior : okRpc(c)));
      await expect(s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber")).resolves.toBe("0x1000");
      expect(s.log).toHaveLength(2);
      expect(s.log[0]!.key).toBe(`acct:${ADDR_A}@publicnode-mainnet#0`);
      expect(s.log[1]!.key).toBe(`acct:${ADDR_A}@publicnode-mainnet#1`);
      expect(s.log[1]!.host).toBe(s.log[0]!.host); // same provider; only the circuit changed
    });
  }

  it("later calls for the identity keep using the rotated circuit", async () => {
    let n = 0;
    const s = setup((c) => (n++ === 0 ? failing.CONNECTION! : okRpc(c)));
    const a = s.client.identities.account(ADDR_A);
    await s.client.read(a, 1, "eth_blockNumber");
    await s.client.read(a, 1, "eth_chainId");
    expect(s.log.map((c) => c.key!.split("#")[1])).toEqual(["0", "1", "1"]);
  });

  it("never retries a JSON-RPC error", async () => {
    const s = setup(() => ({ json: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" } } }));
    await expect(s.client.read(s.client.identities.account(ADDR_A), 1, "eth_call", [{ to: ADDR_A }, "latest"])).rejects.toMatchObject({
      code: "RPC_ERROR",
      rpcCode: -32000,
    });
    expect(s.log).toHaveLength(1);
  });

  it("does not retry HTTP 400 (provider policy, e.g. dRPC's batch cap) and reports the JSON-RPC message", async () => {
    const s = setup(() => ({ json: { jsonrpc: "2.0", id: 1, error: { code: 31, message: "Batch of more than 3 requests are not allowed on free plan" } }, status: 400 }));
    await expect(s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber")).rejects.toMatchObject({ code: "RPC_ERROR", status: 400 });
    expect(s.log).toHaveLength(1);
  });

  it("does not retry an unclassified worker error", async () => {
    const s = setup(() => ({ error: { message: "something odd" } }));
    await expect(s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber")).rejects.toMatchObject({ code: "WORKER_ERROR" });
    expect(s.log).toHaveLength(1);
  });

  it("never retries writes, for any failure", async () => {
    for (const behavior of Object.values(failing)) {
      const s = setup(() => behavior);
      await expect(
        s.client.write(s.client.identities.ephemeral("send"), 1, "eth_sendRawTransaction", ["0x02f8"]),
      ).rejects.toBeTruthy();
      expect(s.log).toHaveLength(1);
      expect(s.traces).toHaveLength(1);
    }
  });
});
