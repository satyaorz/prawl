import { describe, expect, it, vi } from "vitest";
import type { AnonRpcClient } from "@prawl/anon-rpc";
import { createFheTransport, FHE_SEPOLIA_CHAIN_ID } from "../src/swap/transport";

const account = "0x1111111111111111111111111111111111111111";
const relayer = "https://relayer.testnet.zama.org/v2/user-decrypt";

function client() {
  const identity = { key: "account-circuit" };
  const fake = {
    identities: { account: vi.fn(() => identity) },
    read: vi.fn(async () => "0x1234"),
    http: vi.fn(async (_id: unknown, req: { url: string }) => ({
      status: 200, statusText: "OK", headers: new Headers({ "content-type": "application/json" }),
      body: new TextEncoder().encode('{"ok":true}'), url: req.url,
    })),
  };
  return { fake, identity, transport: createFheTransport(fake as unknown as AnonRpcClient, account, FHE_SEPOLIA_CHAIN_ID) };
}

describe("FHE transport", () => {
  it("sends relayer writes and contract reads through the account's Tor identity", async () => {
    const { fake, identity, transport } = client();
    const body = new TextEncoder().encode('{"handle":"0x01"}').buffer;
    const res = await transport.fetch(relayer, "POST", [["content-type", "application/json"]], body);
    expect(await res.json()).toEqual({ ok: true });
    expect(fake.http).toHaveBeenCalledWith(identity, expect.objectContaining({ url: relayer, method: "POST", kind: "write", body: '{"handle":"0x01"}' }));
    expect(await transport.rpc("eth_call", [{ to: account }, "latest"])).toBe("0x1234");
    expect(fake.read).toHaveBeenCalledWith(identity, FHE_SEPOLIA_CHAIN_ID, "eth_call", [{ to: account }, "latest"]);
  });

  it("rejects untrusted endpoints and methods before sending anything", async () => {
    const { fake, transport } = client();
    for (const [url, method] of [
      ["https://attacker.example/key", "GET"],
      ["http://relayer.testnet.zama.org/key", "GET"],
      ["https://relayer.testnet.zama.org.evil.example/key", "GET"],
      ["https://zama-mpc-testnet-public-efd88e2b.s3.eu-west-1.amazonaws.com/key", "POST"],
      [relayer, "DELETE"],
    ] as const) await expect(transport.fetch(url, method, [], null)).rejects.toThrow();
    await expect(transport.rpc("eth_sendRawTransaction", ["0x1234"])).rejects.toThrow();
    expect(fake.http).not.toHaveBeenCalled();
    expect(fake.read).not.toHaveBeenCalled();
  });

  it("does not send a non-UTF8 POST body or accept a different chain", async () => {
    const { fake, transport } = client();
    await expect(transport.fetch(relayer, "POST", [], new Uint8Array([0xff]).buffer)).rejects.toThrow();
    expect(fake.http).not.toHaveBeenCalled();
    expect(() => createFheTransport(fake as unknown as AnonRpcClient, account, 1)).toThrow();
  });
});
