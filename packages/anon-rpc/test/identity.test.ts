import { describe, expect, it } from "vitest";
import { IdentityRegistry } from "../src/identity";
import { ADDR_A, ADDR_B, setup, TX_1 } from "./fake-worker";

describe("rule 4: identity-based isolation", () => {
  it("derives the key from the identity, not the flow: two flows for one address share a key", async () => {
    const s = setup();
    const a = s.client.identities.account(ADDR_A);
    // "balances" flow and "address snapshot" flow in wabl used two keys for the same address.
    await s.client.read(a, 1, "eth_getBalance", [ADDR_A, "latest"]);
    await s.client.read(a, 1, "eth_getCode", [ADDR_A, "latest"]);
    await s.client.read(s.client.identities.account(ADDR_A.toUpperCase().replace("0X", "0x")), 1, "eth_getTransactionCount", [ADDR_A, "latest"]);
    expect(new Set(s.log.map((c) => c.key))).toEqual(new Set([`acct:${ADDR_A}@publicnode-mainnet#0`]));
  });

  it("gives different identities different keys, by kind", async () => {
    const s = setup();
    const ids = [
      s.client.identities.account(ADDR_A),
      s.client.identities.account(ADDR_B),
      s.client.identities.stealth(`0x${"cd".repeat(20)}`),
      s.client.identities.tx(TX_1),
      s.client.identities.publicScope("head:1"),
    ];
    for (const id of ids) await s.client.read(id, 1, "eth_blockNumber");
    const keys = s.log.map((c) => c.identityKey);
    expect(new Set(keys).size).toBe(ids.length);
    expect(keys.map((k) => k!.split(":")[0])).toEqual(["acct", "acct", "stealth", "tx", "public"]);
  });

  it("interns handles and never reuses an ephemeral identity", () => {
    const r = new IdentityRegistry();
    expect(r.account(ADDR_A)).toBe(r.account(ADDR_A));
    const e1 = r.ephemeral("railgun-submit");
    const e2 = r.ephemeral("railgun-submit");
    expect(e1.key).not.toBe(e2.key);
  });

  it("rejects forged handles and handles from another client, before anything is sent", async () => {
    const s = setup();
    const forged = { kind: "account", key: `acct:${ADDR_A}`, label: "x", subject: ADDR_A.slice(2) } as never;
    await expect(s.client.read(forged, 1, "eth_blockNumber")).rejects.toMatchObject({ code: "UNKNOWN_IDENTITY" });
    const other = new IdentityRegistry().account(ADDR_A);
    await expect(s.client.read(other, 1, "eth_blockNumber")).rejects.toMatchObject({ code: "UNKNOWN_IDENTITY" });
    expect(s.log).toHaveLength(0);
  });

  it("rejects a request under one identity that names another registered identity", async () => {
    const s = setup();
    const a = s.client.identities.account(ADDR_A);
    s.client.identities.account(ADDR_B);
    await expect(s.client.read(a, 1, "eth_getBalance", [ADDR_B, "latest"])).rejects.toMatchObject({ code: "CROSS_IDENTITY" });
    // in calldata, padded and lower-cased
    const calldata = `0x70a08231${"0".repeat(24)}${ADDR_B.slice(2)}`;
    await expect(s.client.read(a, 1, "eth_call", [{ to: ADDR_A, data: calldata }, "latest"])).rejects.toMatchObject({ code: "CROSS_IDENTITY" });
    // a public scope cannot carry an account either
    await expect(s.client.read(s.client.identities.publicScope("head:1"), 1, "eth_getBalance", [ADDR_A, "latest"])).rejects.toMatchObject({
      code: "CROSS_IDENTITY",
    });
    // nor can a tx identity carry a different tx hash
    s.client.identities.tx(TX_1);
    const tx2 = s.client.identities.tx(`0x${"22".repeat(32)}`);
    await expect(s.client.read(tx2, 1, "eth_getTransactionReceipt", [TX_1])).rejects.toMatchObject({ code: "CROSS_IDENTITY" });
    expect(s.log).toHaveLength(0);
  });

  it("refuses public scope names that embed an address", () => {
    const r = new IdentityRegistry();
    expect(() => r.publicScope(`balances:${ADDR_A.slice(2)}`)).toThrow(/invalid public scope/);
    expect(() => r.account("0x1234")).toThrow(/not an address/);
    expect(() => r.account(`0x${"0".repeat(40)}`)).toThrow(/zero address/);
  });
});
