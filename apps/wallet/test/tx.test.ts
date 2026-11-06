import { describe, expect, it, vi } from "vitest";
import { IdentityRegistry, type AnonRpcClient } from "@prawl/anon-rpc";
import { parseTransaction, recoverTransactionAddress, type TransactionSerialized } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { sendCalls } from "../src/lib/tx";

const KEY = `0x${"42".repeat(32)}` as const;
const ME = privateKeyToAddress(KEY);

function stub(receiptStatus = "0x1") {
  const identities = new IdentityRegistry();
  const sent: string[] = [];
  const labels: string[] = [];
  const client = {
    identities,
    batch: vi.fn(async (id: { label: string }) => {
      labels.push(id.label);
      return [{ result: "0x7" }, { result: { baseFeePerGas: "0x3b9aca00" } }, { result: "0x5f5e100" }, { result: "0x5208" }];
    }),
    write: vi.fn(async (id: { label: string }, _c: number, method: string, params: string[]) => {
      labels.push(id.label);
      expect(method).toBe("eth_sendRawTransaction");
      sent.push(params[0]!);
      return `0x${"ab".repeat(32)}`;
    }),
    read: vi.fn(async (id: { label: string }) => {
      labels.push(id.label);
      return { status: receiptStatus, blockNumber: "0x10", gasUsed: "0x5208" };
    }),
  } as unknown as AnonRpcClient;
  return { client, sent, labels };
}

describe("sendCalls", () => {
  it("signs with the right nonce, chain and fees, broadcasts once, waits on the tx identity", async () => {
    const { client, sent, labels } = stub();
    const out = await sendCalls(client, 11155111, KEY, [{ to: "0x000000000000000000000000000000000000dEaD", data: "0x1234", value: 5n }]);
    expect(out).toEqual([{ hash: `0x${"ab".repeat(32)}`, status: "success", blockNumber: 16n, gasUsed: 21000n }]);
    expect(sent).toHaveLength(1);
    const tx = parseTransaction(sent[0] as TransactionSerialized);
    expect(tx).toMatchObject({ chainId: 11155111, nonce: 7, value: 5n, data: "0x1234", gas: 25200n, maxPriorityFeePerGas: 100000000n, maxFeePerGas: 2100000000n });
    expect(await recoverTransactionAddress({ serializedTransaction: sent[0] as TransactionSerialized })).toBe(ME);
    expect(labels[0]).toMatch(/^acct:/);
    expect(labels[1]).toMatch(/^acct:/);
    expect(labels[2]).toMatch(/^tx:/);
  });

  it("stops after a reverted transaction", async () => {
    const { client, sent } = stub("0x0");
    const calls = [
      { to: "0x000000000000000000000000000000000000dEaD" as const, data: "0x" as const, value: 1n },
      { to: "0x000000000000000000000000000000000000dEaD" as const, data: "0x" as const, value: 2n },
    ];
    const out = await sendCalls(client, 11155111, KEY, calls);
    expect(out.map((t) => t.status)).toEqual(["reverted"]);
    expect(sent).toHaveLength(1);
  });
});
