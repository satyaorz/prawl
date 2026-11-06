import { describe, expect, it, vi } from "vitest";
import { AnonRpcError, IdentityRegistry, type AnonRpcClient } from "@prawl/anon-rpc";
import { createRailgunTransport } from "../src";

const ACCOUNT = "0x00000000000000000000000000000000000000a1";

function stubClient(answer: (identity: string, method: string, params: unknown[]) => unknown) {
  const identities = new IdentityRegistry();
  const read = vi.fn(async (id: { label: string }, _chain: number, method: string, params: unknown[]) => answer(id.label, method, params));
  const http = vi.fn();
  return { client: { identities, read, http } as unknown as AnonRpcClient, read, http };
}

function transport(client: AnonRpcClient, accountAddress?: string) {
  return createRailgunTransport({
    client,
    chainId: 11155111,
    subsquidEndpoint: "https://squid.example/graphql",
    poiEndpoint: "https://ppoi.example/",
    ...(accountAddress ? { accountAddress } : {}),
  });
}

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("RAILGUN transport", () => {
  it("answers the virtual RPC URL with Anon-RPC reads on the public RAILGUN scope", async () => {
    const { client, read } = stubClient(() => "0xaa36a7");
    const t = transport(client);
    expect(t.rpcUrl).toBe("https://rpc.railgun.prawl.invalid/11155111");
    const res = await t.fetch(t.rpcUrl, post({ jsonrpc: "2.0", id: 42, method: "eth_chainId", params: [] }));
    expect(res.url).toBe(t.rpcUrl);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 42, result: "0xaa36a7" });
    expect(read.mock.calls[0]![0].label).toBe("public:railgun-11155111");
  });

  it("uses the account identity only for calls that name the account", async () => {
    const seen: string[] = [];
    const { client } = stubClient((label) => (seen.push(label), "0x1"));
    const t = transport(client, ACCOUNT);
    await t.fetch(t.rpcUrl, post([
      { jsonrpc: "2.0", id: 1, method: "eth_getTransactionCount", params: [ACCOUNT, "latest"] },
      { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
    ]));
    expect(seen[0]).toMatch(/^acct:/);
    expect(seen[1]).toBe("public:railgun-11155111");
  });

  it("keeps batch ids and turns errors into JSON-RPC errors", async () => {
    const { client } = stubClient((_l, method) => {
      if (method === "eth_call") throw new AnonRpcError("execution reverted", "RPC_ERROR", { rpcCode: 3, rpcData: "0x08c379a0" });
      return "0x10";
    });
    const t = transport(client);
    const res = await t.fetch(t.rpcUrl, post([
      { jsonrpc: "2.0", id: 7, method: "eth_blockNumber" },
      { jsonrpc: "2.0", id: 8, method: "eth_call", params: [{}, "latest"] },
    ]));
    expect(await res.json()).toEqual([
      { jsonrpc: "2.0", id: 7, result: "0x10" },
      { jsonrpc: "2.0", id: 8, error: { code: 3, message: "execution reverted", data: "0x08c379a0" } },
    ]);
  });

  it("never sends writes from RAILGUN's provider", async () => {
    const { client } = stubClient(() => {
      throw new AnonRpcError("eth_sendRawTransaction is not an allowed read", "POLICY");
    });
    const t = transport(client);
    const body = await (await t.fetch(t.rpcUrl, post({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x"] }))).json();
    expect(body.error.message).toMatch(/POLICY/);
  });

  it("refuses unknown hosts like a network error, without touching the network", async () => {
    const { client, http } = stubClient(() => null);
    const t = transport(client);
    await expect(t.fetch("https://evil.example/x")).rejects.toBeInstanceOf(TypeError);
    await expect(t.fetch(t.rpcUrl.replace("11155111", "1"), post({ id: 1, method: "eth_chainId" }))).rejects.toBeInstanceOf(TypeError);
    expect(http).not.toHaveBeenCalled();
  });
});
