import { describe, expect, it, vi } from "vitest";
import { IdentityRegistry, type AnonRpcClient } from "@prawl/anon-rpc";
import { parseTransaction, recoverTransactionAddress, type TransactionSerialized } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { InsufficientFundsError, sendCalls } from "../src/lib/tx";

const KEY = `0x${"42".repeat(32)}` as const;
const ME = privateKeyToAddress(KEY);

function stub(receiptStatus = "0x1", balance = "0xde0b6b3a7640000") {
  const identities = new IdentityRegistry();
  const sent: string[] = [];
  const labels: string[] = [];
  const client = {
    identities,
    batch: vi.fn(async (id: { label: string }) => {
      labels.push(id.label);
      return [{ result: "0x7" }, { result: { baseFeePerGas: "0x3b9aca00" } }, { result: "0x5f5e100" }, { result: "0x5208" }, { result: balance }];
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
    expect(out).toEqual([{ hash: `0x${"ab".repeat(32)}`, status: "success", blockNumber: 16n, gasUsed: 21000n, logs: [] }]);
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

  it("refuses before signing when value plus worst-case gas exceeds the balance, and says how much fits", async () => {
    // gas 25,200 x maxFee 2.1 gwei = 0.00005292 ETH; balance 0.0001 ETH; value 0.00005 ETH.
    const { client, sent } = stub("0x1", "0x5af3107a4000");
    const err = await sendCalls(client, 11155111, KEY, [{ to: "0x000000000000000000000000000000000000dEaD", data: "0x", value: 50_000_000_000_000n }]).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect(err.message).toBe("Not enough ETH for gas: this needs up to 0.000052 ETH of gas on top. Try at most 0.000047 ETH.");
    expect(sent).toHaveLength(0);
  });

  it("asks again when a lagging node says 'insufficient funds' although the balance covers it", async () => {
    vi.useFakeTimers();
    try {
      const { client, sent } = stub();
      const ok = [{ result: "0x7" }, { result: { baseFeePerGas: "0x3b9aca00" } }, { result: "0x5f5e100" }, { result: "0x5208" }, { result: "0xde0b6b3a7640000" }];
      // First answer: gas estimated by a node that has not seen the funding yet (balance 0), while the balance read says 1 ETH.
      const stale = [...ok.slice(0, 3), { error: new Error("insufficient funds for gas * price + value: have 0 want 5") }, ok[4]!];
      (client.batch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(stale);
      const pending = sendCalls(client, 11155111, KEY, [{ to: "0x000000000000000000000000000000000000dEaD", data: "0x", value: 5n }]);
      await vi.advanceTimersByTimeAsync(6000);
      const out = await pending;
      expect(out.map((t) => t.status)).toEqual(["success"]);
      expect(client.batch).toHaveBeenCalledTimes(2);
      expect(sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry an account that really is short of funds", async () => {
    const { client, sent } = stub("0x1", "0x0");
    const real = [{ result: "0x7" }, { result: { baseFeePerGas: "0x3b9aca00" } }, { result: "0x5f5e100" }, { error: new Error("insufficient funds for gas * price + value: have 0 want 5") }, { result: "0x0" }];
    (client.batch as ReturnType<typeof vi.fn>).mockResolvedValue(real);
    const err = await sendCalls(client, 11155111, KEY, [{ to: "0x000000000000000000000000000000000000dEaD", data: "0x", value: 5n }]).catch((e) => e);
    expect(String(err.message)).toMatch(/insufficient funds/);
    expect(client.batch).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
  });
});
