/**
 * Prawl offline-cash escrow v3 on Sepolia: read state, simulate, and build
 * the calls the website sends (load = deposit, cash out = redeem). Every read
 * goes over Anon-RPC: calls that name the wallet's account on its own
 * identity, coin lookups on a shared public scope.
 */
import type { AnonRpcClient, Identity } from "@prawl/anon-rpc";
import type { Call } from "@prawl/railgun";
import { BaseError, decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import { ESCROW_V3, OFFLINE_CHAIN_ID, configProblems, type LoadPayload, type RedeemPayload } from "./payload";

export const ESCROW_ABI = parseAbi([
  "struct Output { uint256 value; bytes32 keyHash; }",
  "struct Header { bytes32 coinId; uint256 value; uint64 expiry; uint256 k0x; uint256 k0y; address depositor; }",
  "struct Spend { Output[] outputs; uint256 index; bytes32 r; bytes32 s; bytes32 nextX; bytes32 nextY; }",
  "struct Redemption { Output[] outputs; uint256 index; address payout; bytes32 r; bytes32 s; }",
  "function deposit(bytes32 coinId, uint64 expiry, uint256 k0x, uint256 k0y) payable",
  "function redeem(Header h, Spend[] path, Redemption rd) returns (bool paid)",
  "function deposits(bytes32 coinId) view returns (bytes32)",
  "function coins(bytes32 coinId) view returns (uint128 paid, bool frozen, bool closed)",
  "function maxLifetime() view returns (uint256)",
  "function grace() view returns (uint256)",
  "event Redeemed(bytes32 indexed coinId, address indexed payout, bytes32 indexed noteId, uint256 outputIndex, uint256 amount, bytes32 msgHash, uint256 totalPaid)",
  "event RedeemBlocked(bytes32 indexed coinId, bytes32 indexed keyHash, uint256 depth)",
  "event CoinFrozen(bytes32 indexed coinId, bytes32 indexed keyHash)",
  "event PaymentDeferred(address indexed to, uint256 amount)",
  "error BadValue()",
  "error BadExpiry()",
  "error CoinExists()",
  "error BadHeader()",
  "error RedeemWindowClosed()",
  "error ZeroPayout()",
  "error ConservationViolated(uint256 depth, uint256 outputsSum, uint256 noteValue)",
  "error ZeroOutput(uint256 depth)",
  "error BadSig(uint256 depth)",
  "error BadIndex(uint256 depth)",
  "error OutputKeyMismatch(uint256 depth)",
  "error NotRedeemOutput()",
  "error AlreadyRedeemed(bytes32 redemptionId)",
  "error CapExceeded(uint256 paid, uint256 amount, uint256 deposit)",
  "error KeyBroken(uint256 depth, bytes32 keyHash)",
  "error TooEarly()",
  "error AlreadyClosed()",
  "error PayFailed()",
]);

/** What each escrow error means for the person holding the payload. */
const ERROR_TEXT: Record<string, string> = {
  BadValue: "the amount does not match the coin",
  BadExpiry: "the coin's expiry is outside what the escrow accepts",
  CoinExists: "this coin is already loaded",
  BadHeader: "the escrow does not know this coin, or its details differ from the deposit",
  RedeemWindowClosed: "the coin expired and its redemption window has closed",
  ZeroPayout: "the payout address is empty",
  ConservationViolated: "a payment on the path spends more than the note holds",
  ZeroOutput: "a payment on the path has a zero output",
  BadSig: "a signature on the path is invalid",
  BadIndex: "the path points at an output that does not exist",
  OutputKeyMismatch: "a key on the path does not match the output it claims",
  NotRedeemOutput: "the redeemed output is not a cash-out to this payout on this escrow",
  AlreadyRedeemed: "this cash-out was already paid",
  CapExceeded: "this would pay out more than the coin holds",
  KeyBroken: "a key on the path was used twice (double spend): the coin is frozen",
  TooEarly: "too early",
  AlreadyClosed: "the coin is closed",
  PayFailed: "the payout transfer failed",
};

/** Readable reason from a revert (escrow custom errors by name), else the raw message. */
export function revertReason(e: unknown): string {
  const data = revertData(e);
  if (data) {
    try {
      const d = decodeErrorResult({ abi: ESCROW_ABI, data });
      return `${ERROR_TEXT[d.errorName] ?? d.errorName} (${d.errorName})`;
    } catch {
      // not one of ours
    }
  }
  if (e instanceof BaseError) return e.shortMessage;
  return e instanceof Error ? e.message : String(e);
}

function revertData(e: unknown): Hex | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const c = cur as { rpcData?: unknown; data?: unknown; cause?: unknown };
    for (const v of [c.rpcData, c.data]) {
      if (typeof v === "string" && /^0x[0-9a-fA-F]{8,}$/.test(v)) return v as Hex;
      if (v && typeof v === "object" && typeof (v as { data?: unknown }).data === "string") return (v as { data: Hex }).data;
    }
    cur = c.cause;
  }
  const m = e instanceof Error ? /(0x[0-9a-fA-F]{8,})/.exec(e.message) : null;
  return m ? (m[1] as Hex) : undefined;
}

export function depositCall(p: LoadPayload): Call {
  return {
    to: ESCROW_V3,
    data: encodeFunctionData({ abi: ESCROW_ABI, functionName: "deposit", args: [p.coinId, p.expiry, p.k0x, p.k0y] }),
    value: p.value,
  };
}

export function redeemCall(p: RedeemPayload): Call {
  return {
    to: ESCROW_V3,
    data: encodeFunctionData({ abi: ESCROW_ABI, functionName: "redeem", args: [p.header, p.path, p.redemption] }),
    value: 0n,
  };
}

/**
 * What a mined redeem actually did. A redeem can succeed as a transaction yet
 * pay nothing: it returns false (RedeemBlocked) when the path holds a double
 * spend, freezing the coin; or it pays into `owed` (PaymentDeferred) when the
 * payout address refuses ETH. Only a Redeemed event for this coin and payout
 * with no deferral counts as paid.
 */
export type RedeemOutcome =
  | { kind: "paid"; amount: bigint }
  | { kind: "deferred"; amount: bigint }
  | { kind: "blocked"; frozen: boolean }
  | { kind: "unknown" };

export function redeemOutcome(logs: ReadonlyArray<{ address: Hex; topics: Hex[]; data: Hex }>, p: RedeemPayload): RedeemOutcome {
  let paid: bigint | undefined;
  let deferred: bigint | undefined;
  let blocked = false;
  let frozen = false;
  for (const l of logs) {
    if (l.address.toLowerCase() !== ESCROW_V3.toLowerCase()) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: ESCROW_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    const a = ev.args as Record<string, unknown>;
    if (ev.eventName === "Redeemed" && a.coinId === p.header.coinId && String(a.payout).toLowerCase() === p.redemption.payout.toLowerCase()) paid = a.amount as bigint;
    if (ev.eventName === "PaymentDeferred" && String(a.to).toLowerCase() === p.redemption.payout.toLowerCase()) deferred = a.amount as bigint;
    if (ev.eventName === "RedeemBlocked" && a.coinId === p.header.coinId) blocked = true;
    if (ev.eventName === "CoinFrozen" && a.coinId === p.header.coinId) frozen = true;
  }
  if (blocked || (frozen && paid === undefined)) return { kind: "blocked", frozen };
  if (paid !== undefined && deferred !== undefined) return { kind: "deferred", amount: deferred };
  if (paid !== undefined) return { kind: "paid", amount: paid };
  return { kind: "unknown" };
}

async function ethCall(client: AnonRpcClient, id: Identity, call: { to: Hex; data: Hex; from?: Hex; value?: bigint }): Promise<Hex> {
  const tx: Record<string, string> = { to: call.to, data: call.data };
  if (call.from) tx.from = call.from;
  if (call.value) tx.value = `0x${call.value.toString(16)}`;
  return (await client.read(id, OFFLINE_CHAIN_ID, "eth_call", [tx, "latest"])) as Hex;
}

const publicId = (client: AnonRpcClient) => client.identities.publicScope("offline-escrow");

export interface CoinStatus {
  deposited: boolean;
  paid: bigint;
  frozen: boolean;
  closed: boolean;
}

export async function coinStatus(client: AnonRpcClient, coinId: Hex): Promise<CoinStatus> {
  const id = publicId(client);
  const [dep, coin] = await Promise.all([
    ethCall(client, id, { to: ESCROW_V3, data: encodeFunctionData({ abi: ESCROW_ABI, functionName: "deposits", args: [coinId] }) }),
    ethCall(client, id, { to: ESCROW_V3, data: encodeFunctionData({ abi: ESCROW_ABI, functionName: "coins", args: [coinId] }) }),
  ]);
  const commitment = decodeFunctionResult({ abi: ESCROW_ABI, functionName: "deposits", data: dep });
  const [paid, frozen, closed] = decodeFunctionResult({ abi: ESCROW_ABI, functionName: "coins", data: coin });
  return { deposited: BigInt(commitment) !== 0n, paid, frozen, closed };
}

/** Everything that would stop a load from this account, checked before signing. Empty means go. */
export async function loadProblems(client: AnonRpcClient, p: LoadPayload, account: Hex, nowS = Math.floor(Date.now() / 1000)): Promise<string[]> {
  const out = configProblems(p);
  if (p.depositor.toLowerCase() !== account.toLowerCase()) {
    out.push(`the phone minted this coin for depositor ${p.depositor}, but this wallet's account is ${account}. Mint again with this account.`);
  }
  if (out.length) return out;
  const status = await coinStatus(client, p.coinId);
  if (status.deposited) return ["this coin is already loaded"];
  const maxLife = decodeFunctionResult({
    abi: ESCROW_ABI,
    functionName: "maxLifetime",
    data: await ethCall(client, publicId(client), { to: ESCROW_V3, data: encodeFunctionData({ abi: ESCROW_ABI, functionName: "maxLifetime" }) }),
  });
  if (p.expiry <= BigInt(nowS)) out.push("the coin has already expired");
  else if (p.expiry > BigInt(nowS) + maxLife) out.push("the coin's expiry is further away than the escrow allows");
  if (out.length) return out;
  try {
    await ethCall(client, client.identities.account(account), { ...depositCall(p), from: account });
  } catch (e) {
    out.push(`the escrow would refuse it: ${revertReason(e)}`);
  }
  return out;
}

/**
 * Simulate a cash-out. `paid: false` means the escrow would record a double
 * spend and freeze instead of paying: never send that.
 */
export async function simulateRedeem(client: AnonRpcClient, p: RedeemPayload, from: Hex): Promise<{ paid: boolean } | { error: string }> {
  const problems = configProblems(p);
  if (problems.length) return { error: problems.join("; ") };
  try {
    const data = await ethCall(client, client.identities.account(from), { ...redeemCall(p), from });
    return { paid: decodeFunctionResult({ abi: ESCROW_ABI, functionName: "redeem", data }) };
  } catch (e) {
    return { error: revertReason(e) };
  }
}

