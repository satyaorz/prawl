import { describe, expect, it, vi } from "vitest";
import { scanLogs } from "../src/log-scan";
import { DEFAULT_POLICY, providersFor, validatePolicy, type ProviderPolicy } from "../src/providers";
import { ADDR_A, okRpc, setup } from "./fake-worker";

const hex = (n: number) => `0x${n.toString(16)}`;
const logs = (from: number, to: number) => [{ fromBlock: hex(from), toBlock: hex(to) }];

describe("rule 8: provider policy", () => {
  it("the default policy validates", () => {
    expect(() => validatePolicy(DEFAULT_POLICY)).not.toThrow();
  });

  it("bans Tenderly anywhere", () => {
    const p: ProviderPolicy = structuredClone(DEFAULT_POLICY);
    p.providers.t = { id: "t", url: "https://mainnet.gateway.tenderly.co", chainId: 1, maxBatch: 10, maxLogRange: 2_000_000 };
    expect(() => validatePolicy(p)).toThrow(/banned/);
  });

  it("bans Flashbots for logs", () => {
    const p: ProviderPolicy = structuredClone(DEFAULT_POLICY);
    p.providers.fb = { id: "fb", url: "https://rpc.flashbots.net", chainId: 1, maxBatch: 2, maxLogRange: 100_000 };
    p.chains[1]!.logs = ["fb"];
    expect(() => validatePolicy(p)).toThrow(/must not serve eth_getLogs/);
  });

  it("refuses plain http and cross-chain entries", () => {
    const p: ProviderPolicy = structuredClone(DEFAULT_POLICY);
    p.providers["publicnode-mainnet"]!.url = "http://ethereum-rpc.publicnode.com";
    expect(() => validatePolicy(p)).toThrow(/https only/);
    const q: ProviderPolicy = structuredClone(DEFAULT_POLICY);
    q.chains[1]!.read = ["onfinality-sepolia"];
    expect(() => validatePolicy(q)).toThrow(/serves chain/);
  });

  it("routes logs by measured range: publicnode ≤1k, MEV Blocker for deep mainnet, onfinality first on Sepolia", () => {
    expect(providersFor(DEFAULT_POLICY, 1, "eth_getLogs", logs(1, 1000)).map((p) => p.id)).toEqual(["publicnode-mainnet", "mevblocker-mainnet"]);
    expect(providersFor(DEFAULT_POLICY, 1, "eth_getLogs", logs(1, 100_000)).map((p) => p.id)).toEqual(["mevblocker-mainnet"]);
    expect(providersFor(DEFAULT_POLICY, 11155111, "eth_getLogs", logs(1, 2_000_000)).map((p) => p.id)).toEqual(["onfinality-sepolia"]);
    expect(providersFor(DEFAULT_POLICY, 11155111, "eth_getLogs", logs(1, 5_000))[0]!.id).toBe("onfinality-sepolia");
    expect(providersFor(DEFAULT_POLICY, 1, "eth_getLogs", logs(1, 1000)).some((p) => /drpc|flashbots|tenderly/.test(p.url))).toBe(false);
  });

  it("fails over only after a failure, in fixed order, with a per-provider key", async () => {
    const s = setup((c) => (c.host === "ethereum-rpc.publicnode.com" ? { error: { code: "CONNECTION", message: "x" } } : okRpc(c)));
    const a = s.client.identities.account(ADDR_A);
    await expect(s.client.read(a, 1, "eth_blockNumber")).resolves.toBe("0x1000");
    expect(s.log.map((c) => c.key)).toEqual([
      `acct:${ADDR_A}@publicnode-mainnet#0`,
      `acct:${ADDR_A}@publicnode-mainnet#1`,
      `acct:${ADDR_A}@drpc-mainnet#0`,
    ]);
    // The next request starts at the primary again: no sticky "hedge" to the second party.
    await s.client.read(a, 1, "eth_chainId").catch(() => undefined);
    expect(s.log[3]!.host).toBe("ethereum-rpc.publicnode.com");
  });

  it("does not touch a second provider when the first succeeds", async () => {
    const s = setup();
    await s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber");
    expect(new Set(s.log.map((c) => c.host))).toEqual(new Set(["ethereum-rpc.publicnode.com"]));
  });

  it("with failover disabled, a failing request stays on its provider", async () => {
    const s = setup(() => ({ error: { code: "CONNECTION", message: "x" } }), { client: { failover: false } });
    await expect(s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber")).rejects.toMatchObject({ code: "CONNECTION" });
    expect(s.log.map((c) => c.host)).toEqual(["ethereum-rpc.publicnode.com", "ethereum-rpc.publicnode.com"]);
  });

  it("never falls back to a direct connection, even when every attempt fails", async () => {
    const direct = vi.spyOn(globalThis, "fetch");
    const s = setup(() => ({ error: { code: "CONNECTION", message: "x" } }));
    await expect(s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber")).rejects.toMatchObject({ code: "CONNECTION" });
    expect(direct).not.toHaveBeenCalled();
    direct.mockRestore();
  });
});

describe("log scan", () => {
  it("uses the measured window (onfinality 2M → one request for 1.5M blocks)", async () => {
    const s = setup(() => ({ json: { jsonrpc: "2.0", id: 1, result: [{ n: 1 }] } }));
    const out = await scanLogs(s.client, s.client.identities.publicScope("announcer"), 11155111, { address: ADDR_A }, 1n, 1_500_000n);
    expect(out.requests).toBe(1);
    expect(s.log[0]!.host).toBe("eth-sepolia.api.onfinality.io");
  });

  it("only a range error shrinks the window; a transport failure fails closed after the client's retries", async () => {
    let n = 0;
    const s = setup((c) =>
      n++ === 0 ? { json: { jsonrpc: "2.0", id: 1, error: { code: -32701, message: "exceed maximum block range: 50000" } } } : { json: { jsonrpc: "2.0", id: 1, result: [] } },
    );
    const out = await scanLogs(s.client, s.client.identities.publicScope("announcer2"), 1, { address: ADDR_A }, 1n, 100_000n, { window: 100_000 });
    expect(out.requests).toBe(3); // 100k fails, then two 50k windows
    const t = setup(() => ({ error: { code: "IO_ERROR", message: "x" } }));
    await expect(scanLogs(t.client, t.client.identities.publicScope("announcer3"), 11155111, {}, 1n, 10n)).rejects.toMatchObject({ code: "IO_ERROR" });
  });
});
