/**
 * Public transactions from the wallet's EVM account, entirely over Anon-RPC.
 * Every read and the broadcast use the account's own identity (its own Tor
 * circuit); waiting for the receipt uses the transaction's own identity.
 * Signing happens here, in memory; the key never leaves this tab.
 */
import type { AnonRpcClient } from "@prawl/anon-rpc";
import type { Call, Hex } from "@prawl/railgun";
import { privateKeyToAccount } from "viem/accounts";

export interface SentTx {
  hash: Hex;
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
}

const hexBig = (v: unknown): bigint => BigInt(v as string);

function unwrap(item: { result: unknown } | { error: Error } | undefined, what: string): unknown {
  if (!item) throw new Error(`${what}: no answer`);
  if ("error" in item) throw new Error(`${what}: ${item.error.message}`);
  return item.result;
}

/** Sign and send calls one after another (each waits for its receipt). */
export async function sendCalls(
  client: AnonRpcClient,
  chainId: number,
  privateKey: Hex,
  calls: readonly Call[],
  onStatus?: (s: string) => void,
): Promise<SentTx[]> {
  const account = privateKeyToAccount(privateKey);
  const id = client.identities.account(account.address);
  const out: SentTx[] = [];
  for (const [i, call] of calls.entries()) {
    const label = calls.length > 1 ? ` ${i + 1}/${calls.length}` : "";
    onStatus?.(`Preparing transaction${label}…`);
    const txReq = { from: account.address, to: call.to, data: call.data, value: `0x${call.value.toString(16)}` };
    const [nonceR, feeR, tipR, gasR] = await client.batch(id, chainId, [
      { method: "eth_getTransactionCount", params: [account.address, "pending"] },
      { method: "eth_getBlockByNumber", params: ["latest", false] },
      { method: "eth_maxPriorityFeePerGas", params: [] },
      { method: "eth_estimateGas", params: [txReq, "latest"] },
    ]);
    const nonce = Number(hexBig(unwrap(nonceR, "nonce")));
    const baseFee = hexBig((unwrap(feeR, "latest block") as { baseFeePerGas: string }).baseFeePerGas);
    const tip = hexBig(unwrap(tipR, "priority fee"));
    const gas = (hexBig(unwrap(gasR, "gas estimate")) * 12n) / 10n;
    const raw = await account.signTransaction({
      type: "eip1559",
      chainId,
      nonce,
      to: call.to,
      data: call.data,
      value: call.value,
      gas,
      maxPriorityFeePerGas: tip,
      maxFeePerGas: baseFee * 2n + tip,
    });
    onStatus?.(`Sending transaction${label} over Tor…`);
    const hash = (await client.write(id, chainId, "eth_sendRawTransaction", [raw])) as Hex;
    onStatus?.(`Waiting for transaction${label} to be mined…`);
    out.push(await waitForReceipt(client, chainId, hash));
    if (out.at(-1)!.status !== "success") break;
  }
  return out;
}

export async function waitForReceipt(client: AnonRpcClient, chainId: number, hash: Hex, timeoutMs = 300_000): Promise<SentTx> {
  const id = client.identities.tx(hash);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = (await client.read(id, chainId, "eth_getTransactionReceipt", [hash]).catch(() => null)) as
      | { status: string; blockNumber: string; gasUsed: string }
      | null;
    if (r) return { hash, status: r.status === "0x1" ? "success" : "reverted", blockNumber: hexBig(r.blockNumber), gasUsed: hexBig(r.gasUsed) };
    await new Promise((res) => setTimeout(res, 4000));
  }
  throw new Error(`no receipt for ${hash} after ${timeoutMs / 1000} s`);
}

/** Public ETH balance of an address, on that address's own circuit. */
export async function publicBalance(client: AnonRpcClient, chainId: number, address: string): Promise<bigint> {
  return hexBig(await client.read(client.identities.account(address), chainId, "eth_getBalance", [address, "latest"]));
}
