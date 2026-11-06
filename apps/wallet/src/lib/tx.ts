/**
 * Public transactions from the wallet's EVM account, entirely over Anon-RPC.
 * Every read and the broadcast use the account's own identity (its own Tor
 * circuit); waiting for the receipt uses the transaction's own identity.
 * Signing happens here, in memory; the key never leaves this tab.
 */
import { AnonRpcError, type AnonRpcClient } from "@prawl/anon-rpc";
import type { Call, Hex } from "@prawl/railgun";
import { privateKeyToAccount } from "viem/accounts";

export interface ReceiptLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
}

export interface SentTx {
  hash: Hex;
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  /** Logs of the mined transaction, for callers whose outcome is not just the status (e.g. a redeem that returns false). */
  logs?: ReceiptLog[];
}

const hexBig = (v: unknown): bigint => BigInt(v as string);

/**
 * A submission whose outcome we cannot tell: the answer never came back, the
 * transaction was not seen mined in time, or the bundler returned another hash.
 * It may still land, so callers must say "status unknown" rather than "failed",
 * and must not offer a blind retry (a retry could pay twice).
 */
export class UnconfirmedError extends Error {
  override name = "UnconfirmedError";
  constructor(
    message: string,
    readonly hash?: Hex,
  ) {
    super(message);
  }
}

/** A JSON-RPC error answer means the node or bundler refused it: safe to say it was not sent. */
const refused = (e: unknown): boolean => e instanceof AnonRpcError && e.code === "RPC_ERROR";

/** ETH with up to 6 decimals, rounded down. */
function eth(wei: bigint): string {
  const s = (wei < 0n ? 0n : wei).toString().padStart(19, "0");
  return `${s.slice(0, -18)}.${s.slice(-18, -12)}`.replace(/\.?0+$/, "") || "0";
}

/** Thrown before signing when value plus the worst-case gas cost exceeds the balance. */
export class InsufficientFundsError extends Error {
  constructor(
    readonly balance: bigint,
    readonly value: bigint,
    readonly maxGasCost: bigint,
  ) {
    super(
      value > 0n && balance > maxGasCost
        ? `Not enough ETH for gas: this needs up to ${eth(maxGasCost)} ETH of gas on top. Try at most ${eth(balance - maxGasCost)} ETH.`
        : `Not enough ETH: have ${eth(balance)}, need ${eth(value + maxGasCost)} including gas.`,
    );
    this.name = "InsufficientFundsError";
  }
}

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
  checkAuthorized?: () => void,
): Promise<SentTx[]> {
  const account = privateKeyToAccount(privateKey);
  const id = client.identities.account(account.address);
  const out: SentTx[] = [];
  for (const [i, call] of calls.entries()) {
    checkAuthorized?.();
    const label = calls.length > 1 ? ` ${i + 1}/${calls.length}` : "";
    onStatus?.(`Preparing transaction${label}…`);
    const txReq = { from: account.address, to: call.to, data: call.data, value: `0x${call.value.toString(16)}` };
    const [nonceR, feeR, tipR, gasR, balR] = await client.batch(id, chainId, [
      { method: "eth_getTransactionCount", params: [account.address, "pending"] },
      { method: "eth_getBlockByNumber", params: ["latest", false] },
      { method: "eth_maxPriorityFeePerGas", params: [] },
      { method: "eth_estimateGas", params: [txReq, "latest"] },
      { method: "eth_getBalance", params: [account.address, "latest"] },
    ]);
    const nonce = Number(hexBig(unwrap(nonceR, "nonce")));
    const baseFee = hexBig((unwrap(feeR, "latest block") as { baseFeePerGas: string }).baseFeePerGas);
    const tip = hexBig(unwrap(tipR, "priority fee"));
    const gas = (hexBig(unwrap(gasR, "gas estimate")) * 12n) / 10n;
    const maxFeePerGas = baseFee * 2n + tip;
    const balance = hexBig(unwrap(balR, "balance"));
    if (call.value + gas * maxFeePerGas > balance) throw new InsufficientFundsError(balance, call.value, gas * maxFeePerGas);
    checkAuthorized?.();
    const raw = await account.signTransaction({
      type: "eip1559",
      chainId,
      nonce,
      to: call.to,
      data: call.data,
      value: call.value,
      gas,
      maxPriorityFeePerGas: tip,
      maxFeePerGas,
    });
    onStatus?.(`Sending transaction${label} over Tor…`);
    checkAuthorized?.();
    let hash: Hex;
    try {
      hash = (await client.write(id, chainId, "eth_sendRawTransaction", [raw])) as Hex;
    } catch (e) {
      if (refused(e)) throw e;
      throw new UnconfirmedError(`no answer when sending the transaction (${e instanceof Error ? e.message : String(e)}); it may still be mined`);
    }
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
      | { status: string; blockNumber: string; gasUsed: string; logs?: ReceiptLog[] }
      | null;
    if (r) {
      return {
        hash,
        status: r.status === "0x1" ? "success" : "reverted",
        blockNumber: hexBig(r.blockNumber),
        gasUsed: hexBig(r.gasUsed),
        logs: (r.logs ?? []).map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
      };
    }
    await new Promise((res) => setTimeout(res, 4000));
  }
  throw new UnconfirmedError(`transaction ${hash} was not seen mined after ${timeoutMs / 1000} s; it may still land`, hash);
}

/** Public ETH balance of an address, on that address's own circuit. */
export async function publicBalance(client: AnonRpcClient, chainId: number, address: string): Promise<bigint> {
  return hexBig(await client.read(client.identities.account(address), chainId, "eth_getBalance", [address, "latest"]));
}

/**
 * Send a signed UserOperation and wait for it. The bundler call names the
 * one-time sender, so it goes on that sender's own identity (fresh circuit);
 * the receipt wait uses the UserOperation hash's identity.
 */
export async function sendUserOp(
  client: AnonRpcClient,
  chainId: number,
  sender: string,
  signed: unknown,
  expectedHash: Hex,
  onStatus?: (s: string) => void,
  timeoutMs = 300_000,
): Promise<SentTx> {
  const op = signed as { userOp: unknown; entryPoint: string };
  if (!op?.userOp || !op.entryPoint) throw new Error("malformed signed UserOperation");
  const id = client.identities.account(sender);
  let hash: Hex;
  try {
    hash = (await client.write(id, chainId, "eth_sendUserOperation", [op.userOp, op.entryPoint])) as Hex;
  } catch (e) {
    if (refused(e)) throw e;
    throw new UnconfirmedError(`no answer from the bundler (${e instanceof Error ? e.message : String(e)}); the operation may still be accepted`, expectedHash);
  }
  if (hash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new UnconfirmedError(`the bundler returned ${hash}, expected ${expectedHash}; the operation may have been accepted`, hash);
  }
  onStatus?.("Waiting for the bundler to include it…");
  const wait = client.identities.tx(hash);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = (await client.read(wait, chainId, "eth_getUserOperationReceipt", [hash]).catch(() => null)) as
      | { success: boolean; receipt: { transactionHash: Hex; blockNumber: string; gasUsed: string } }
      | null;
    if (r) {
      return { hash: r.receipt.transactionHash, status: r.success ? "success" : "reverted", blockNumber: hexBig(r.receipt.blockNumber), gasUsed: hexBig(r.receipt.gasUsed) };
    }
    await new Promise((res) => setTimeout(res, 4000));
  }
  throw new UnconfirmedError(`UserOperation ${hash} was not seen included after ${timeoutMs / 1000} s; it may still land`, hash);
}
