/**
 * The unlocked wallet. Keys come from the passkey's PRF output and live only in
 * memory (here and in the RAILGUN worker) until lock(). Nothing secret is
 * stored: the passkey credential id (not secret) and sealed RAILGUN
 * checkpoints are all that touch disk.
 */
import { SEPOLIA } from "@prawl/anon-rpc";
import { createPasskey, deriveWalletKeys, unlockWithPasskey, type WalletKeys } from "@prawl/keys";
import type { Balance, Hex } from "@prawl/railgun";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { keccak256, toHex } from "viem";
import { anon } from "./anon";
import { store } from "./store";
import { railgun } from "../railgun/controller";
import { publicBalance, sendCalls, sendUserOp, type SentTx } from "./tx";
import { depositCall, loadProblems, redeemCall, revertReason, simulateRedeem } from "../offline/escrow";
import { OFFLINE_CHAIN_ID, payoutValue, type LoadPayload, type RedeemPayload } from "../offline/payload";

/** ERC-4337 bundler (the RAILGUN paymaster pays gas from the private balance). */
export const BUNDLER_URL = "https://public.pimlico.io/v2/11155111/rpc";

export type WalletPhase = "locked" | "unlocking" | "opening" | "syncing" | "ready" | "error";

export interface WalletState {
  phase: WalletPhase;
  hasPasskey: boolean;
  chainId: number;
  railgunAddress?: string;
  /** The wallet's public EVM account: the way in and out, never the main balance. */
  evmAddress?: string;
  syncedBlock?: bigint;
  head?: bigint;
  deploymentBlock?: bigint;
  balances?: Balance[];
  wrappedBaseToken?: string;
  restored?: boolean;
  /** True when this open scans RAILGUN history from the start (no checkpoint, no usable snapshot). */
  fullScan?: boolean;
  /** A restored wallet's scan restarts here (its birth, bounded) on top of the snapshot. */
  replayFrom?: bigint;
  /** Block of the public pool snapshot a new or restored wallet started from. */
  snapshotBlock?: bigint;
  lastSyncMs?: number;
  /** Our operations whose PPOI proofs are still queued (submitted on each sync). */
  poiQueue?: number;
  /** Gas the paymaster took from the private balance for this wallet's last private operation. */
  privateGasWei?: bigint;
  /** Last PPOI submission problem, if any. The proofs stay queued. */
  poiError?: string;
  /** Public ETH on the EVM account (the way in and out). */
  publicWei?: bigint;
  /** Progress or result of the current shield/unshield/send. */
  action?: { kind: string; status: string; done?: boolean; error?: string; txs?: SentTx[] };
  error?: string;
}

const CREDENTIAL_KEY = "passkey:credential-id";

let keys: WalletKeys | undefined;
let state: WalletState = { phase: "locked", hasPasskey: false, chainId: SEPOLIA };
const listeners = new Set<() => void>();

function update(patch: Partial<WalletState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const walletState = {
  get: (): WalletState => state,
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

void store.get<string>(CREDENTIAL_KEY).then((id) => update({ hasPasskey: !!id }));

railgun().onProgress((p) => update({ syncedBlock: BigInt(p.synced), head: BigInt(p.head) }));

interface StartOptions {
  fresh: boolean;
  bornAt?: number;
  discardCheckpoint?: boolean;
}
async function start(root: Uint8Array, opts: StartOptions): Promise<void> {
  keys = await deriveWalletKeys(root);
  root.fill(0);
  await openRailgun(opts);
}

async function openRailgun(opts: StartOptions): Promise<void> {
  if (!keys) throw new Error("wallet is locked");
  const evmAddress = privateKeyToAddress(keys.evmAccount);
  update({ phase: "opening", evmAddress, error: undefined });
  const rg = railgun();
  const { deployment, rpcUrl } = await rg.prepare(state.chainId, evmAddress);
  // Record name derived from the account, so two wallets on one device never share a checkpoint.
  const checkpointName = `railgun:${state.chainId}:${keccak256(toHex(evmAddress)).slice(2, 18)}`;
  const opened = await rg.call("open", {
    chainId: state.chainId,
    rpcUrl,
    spendingKey: keys.railgunSpending,
    viewingKey: keys.railgunViewing,
    storageKey: keys.storage,
    checkpointName,
    fresh: opts.fresh,
    ...(opts.bornAt !== undefined ? { bornAt: opts.bornAt } : {}),
    ...(opts.discardCheckpoint ? { discardCheckpoint: true } : {}),
  });
  update({
    railgunAddress: opened.address,
    syncedBlock: BigInt(opened.syncedBlock),
    deploymentBlock: BigInt(deployment.deploymentBlock),
    wrappedBaseToken: deployment.wrappedBaseToken.toLowerCase(),
    restored: opened.restored,
    fullScan: opened.fullScan,
    snapshotBlock: opened.snapshotBlock ? BigInt(opened.snapshotBlock) : undefined,
    replayFrom: opened.replayFrom ? BigInt(opened.replayFrom) : undefined,
  });
  await sync();
  startAutoSync();
}

/** One sync at a time: a second caller (button, timer, after an action) waits for the running one. */
let running: Promise<void> | undefined;
export function sync(): Promise<void> {
  running ??= doSync().finally(() => (running = undefined));
  return running;
}

async function doSync(): Promise<void> {
  if (!keys) return;
  const rg = railgun();
  update({ phase: "syncing", error: undefined });
  try {
    const t0 = performance.now();
    const head = await anon.head(state.chainId);
    update({ head });
    await rg.call("sync", { head: head.toString() });
    const [balances, publicWei] = await Promise.all([
      rg.call("balances", undefined as never),
      state.evmAddress ? publicBalance(anon, state.chainId, state.evmAddress).catch(() => state.publicWei) : undefined,
    ]);
    update({ phase: "ready", balances, lastSyncMs: performance.now() - t0, ...(publicWei !== undefined ? { publicWei } : {}) });
  } catch (e) {
    update({ phase: "error", error: e instanceof Error ? e.message : String(e) });
    return;
  }
  await submitPendingPoi();
}

/**
 * After our private send or unshield lands, its PPOI proofs must reach the
 * PPOI node, or the recipient's notes never become spendable. The queue lives
 * in the checkpoint; a proof the node cannot take yet (transaction not
 * indexed, input not valid yet) stays queued for the next sync. Failures here
 * never fail the sync.
 */
async function submitPendingPoi(): Promise<void> {
  const rg = railgun();
  try {
    const queued = await rg.call("poiPendingCount", undefined as never);
    update({ poiQueue: queued });
    if (queued === 0) return;
    const report = await rg.call("processPendingPoi", undefined as never);
    update({ poiQueue: report.pendingAfter, poiError: report.failed[0]?.error });
    if (report.submitted.length > 0) {
      await rg.call("refreshPoi", undefined as never);
      update({ balances: await rg.call("balances", undefined as never) });
    }
  } catch (e) {
    update({ poiError: e instanceof Error ? e.message : String(e) });
  }
}

/** Background refresh while unlocked: new notes, PPOI status, queued proofs. Paused while hidden or busy. */
const AUTO_SYNC_MS = 60_000;
let timer: ReturnType<typeof setInterval> | undefined;
function startAutoSync(): void {
  stopAutoSync();
  timer = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    // Also retries after a failed sync (a Tor hiccup), once the wallet is open.
    const idle = state.phase === "ready" || (state.phase === "error" && !!state.railgunAddress);
    if (!idle || (state.action && !state.action.done)) return;
    void sync();
  }, AUTO_SYNC_MS);
}
function stopAutoSync(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
}

async function guarded(fn: () => Promise<void>): Promise<void> {
  update({ phase: "unlocking", error: undefined });
  try {
    await fn();
  } catch (e) {
    keys = undefined;
    update({ phase: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

export function createWallet(): Promise<void> {
  return guarded(async () => {
    const { root, credentialId, bornAt } = await createPasskey();
    await store.set(CREDENTIAL_KEY, credentialId);
    update({ hasPasskey: true });
    await start(root, { fresh: true, ...(bornAt !== undefined ? { bornAt } : {}) });
  });
}

/** Unlock with the remembered passkey, or (recovery on a new device) let the user pick any Prawl passkey. */
export function unlockWallet(): Promise<void> {
  return guarded(async () => {
    const remembered = await store.get<string>(CREDENTIAL_KEY);
    const { root, credentialId, bornAt } = await unlockWithPasskey(remembered);
    if (!remembered) await store.set(CREDENTIAL_KEY, credentialId);
    update({ hasPasskey: true });
    await start(root, { fresh: false, ...(bornAt !== undefined ? { bornAt } : {}) });
  });
}

/**
 * Forget the saved checkpoint and scan all RAILGUN history again, ignoring the
 * snapshot and the passkey's creation time. The escape hatch if a balance
 * looks wrong.
 */
export async function rescanWallet(): Promise<void> {
  stopAutoSync();
  update({ phase: "opening", balances: undefined, poiQueue: undefined, poiError: undefined, error: undefined });
  try {
    await railgun().call("close", undefined as never);
    await openRailgun({ fresh: false, discardCheckpoint: true });
  } catch (e) {
    update({ phase: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

export async function lockWallet(): Promise<void> {
  stopAutoSync();
  keys = undefined;
  await railgun().call("close", undefined as never);
  update({ phase: "locked", railgunAddress: undefined, evmAddress: undefined, balances: undefined, syncedBlock: undefined, poiQueue: undefined, poiError: undefined });
}

/** Move public ETH from the wallet's EVM account into the private balance. */
export async function shieldEth(amountWei: bigint): Promise<void> {
  if (!keys || !state.railgunAddress) throw new Error("wallet is locked");
  const kind = "shield";
  const status = (s: string) => update({ action: { kind, status: s } });
  try {
    status("Building shield…");
    const calls = await railgun().call("buildShield", {
      recipient: state.railgunAddress,
      items: [{ token: "native", amount: amountWei.toString() }],
    });
    const txs = await sendCalls(anon, state.chainId, keys.evmAccount, calls, status);
    const ok = txs.every((t) => t.status === "success");
    update({ action: { kind, status: ok ? "Shielded. It shows as pending until the PPOI check clears." : "Shield transaction reverted", done: true, txs } });
    await sync();
  } catch (e) {
    update({ action: { kind, status: "Shield failed", done: true, error: e instanceof Error ? e.message : String(e) } });
  }
}

/**
 * Gas for a private operation is paid by the RAILGUN paymaster out of the
 * private balance (WETH), on top of the amount. Measured live on Sepolia:
 * an unshield used 2.05M gas, about 0.0033 ETH. Until this wallet has
 * measured its own, assume this much.
 */
export const DEFAULT_PRIVATE_GAS_WEI = 3_500_000_000_000_000n;
/** RAILGUN unshield fee, basis points, added on top of the amount. */
export const UNSHIELD_FEE_BPS = 25n;

export function privateFeeWei(kind: "send" | "unshield", amountWei: bigint): bigint {
  return kind === "unshield" ? (amountWei * UNSHIELD_FEE_BPS) / 10_000n : 0n;
}

/** Gas to expect for the next private operation: the last one measured here, with 20% headroom, or the default. */
export function privateGasEstimateWei(): bigint {
  return state.privateGasWei !== undefined ? (state.privateGasWei * 12n) / 10n : DEFAULT_PRIVATE_GAS_WEI;
}

/** Largest amount that fits in `available` once gas and the fee are taken. */
export function maxPrivateAmountWei(kind: "send" | "unshield", available: bigint): bigint {
  const rest = available - privateGasEstimateWei();
  if (rest <= 0n) return 0n;
  return kind === "unshield" ? (rest * 10_000n) / (10_000n + UNSHIELD_FEE_BPS) : rest;
}

function wethTotal(): bigint {
  return (state.balances ?? []).filter((b) => b.token !== undefined && b.token === state.wrappedBaseToken).reduce((sum, b) => sum + BigInt(b.amount), 0n);
}

function fmtEth(wei: bigint): string {
  const s = (wei < 0n ? 0n : wei).toString().padStart(19, "0");
  return `${s.slice(0, -18)}.${s.slice(-18, -14)}`.replace(/\.?0+$/, "") || "0";
}

/** kohaku's "Insufficient balance for intent" in words, with what would fit. */
function explain(kind: "send" | "unshield", e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (!/Insufficient balance for intent/i.test(msg)) return msg;
  const spendable = (state.balances ?? [])
    .filter((b) => b.token !== undefined && b.token === state.wrappedBaseToken && b.poiStatus === "Valid")
    .reduce((sum, b) => sum + BigInt(b.amount), 0n);
  const max = maxPrivateAmountWei(kind, spendable);
  return (
    `Not enough spendable private ETH for this amount plus gas (about ${fmtEth(privateGasEstimateWei())} ETH, paid from your private balance)` +
    (kind === "unshield" ? " and the 0.25% fee" : "") +
    (max > 0n ? `. Try at most ${fmtEth(max)} ETH.` : ".")
  );
}

/**
 * Private transfer or unshield, as a paymaster-sponsored UserOperation.
 * The UserOperation's sender is a fresh one-time EIP-7702 account, never the
 * wallet's public account: gas comes out of the private balance, so the
 * sender needs no ETH and has no history to link to.
 */
async function privateOp(
  kind: "send" | "unshield",
  amountWei: bigint,
  run: (oneTimeKey: Hex) => Promise<{ signed: unknown; userOpHash: Hex }>,
): Promise<void> {
  if (!keys) throw new Error("wallet is locked");
  const status = (s: string) => update({ action: { kind, status: s } });
  try {
    const before = wethTotal();
    status("Proving in your browser… (this takes a while)");
    const oneTimeKey = generatePrivateKey();
    const sender = privateKeyToAddress(oneTimeKey);
    railgun().useAccount(sender);
    const prepared = await run(oneTimeKey);
    status("Sending to the bundler over Tor…");
    const tx = await sendUserOp(anon, state.chainId, sender, prepared.signed, prepared.userOpHash, status);
    update({ action: { kind, status: tx.status === "success" ? "Done." : "The operation reverted", done: true, txs: [tx] } });
    await sync();
    // What the paymaster took: everything that left the balance beyond the amount and fee.
    const gas = before - wethTotal() - amountWei - privateFeeWei(kind, amountWei);
    if (tx.status === "success" && gas > 0n && gas < 50_000_000_000_000_000n) update({ privateGasWei: gas });
  } catch (e) {
    update({ action: { kind, status: kind === "send" ? "Send failed" : "Unshield failed", done: true, error: explain(kind, e) } });
  }
}

/** Send private ETH (WETH notes) to another 0zk address. */
export function privateSendEth(recipient: string, amountWei: bigint): Promise<void> {
  const weth = state.wrappedBaseToken as Hex | undefined;
  if (!weth) throw new Error("wallet is not open");
  return privateOp("send", amountWei, (accountPrivateKey) =>
    railgun().call("prepareTransfer", { recipient, token: weth, amount: amountWei.toString(), accountPrivateKey, bundlerUrl: BUNDLER_URL }),
  );
}

/**
 * Withdraw private ETH to a public address; the 0.25% RAILGUN fee is added on top.
 * As native ETH (default): WETH is unshielded to the one-time account, unwrapped
 * there, and the ETH forwarded to the recipient in the same UserOperation.
 * With `asWeth`, the recipient gets WETH directly (cheaper).
 */
export function unshieldEth(recipient: Hex, amountWei: bigint, opts: { asWeth?: boolean } = {}): Promise<void> {
  const weth = state.wrappedBaseToken as Hex | undefined;
  if (!weth) throw new Error("wallet is not open");
  return privateOp("unshield", amountWei, (accountPrivateKey) =>
    railgun().call(
      "prepareUnshield",
      opts.asWeth
        ? { recipient, token: weth, amount: amountWei.toString(), accountPrivateKey, bundlerUrl: BUNDLER_URL }
        : {
            recipient: privateKeyToAddress(accountPrivateKey),
            token: weth,
            amount: amountWei.toString(),
            unwrapNative: true,
            tailCalls: [{ target: recipient, value: amountWei.toString(), data: "0x" }],
            accountPrivateKey,
            bundlerUrl: BUNDLER_URL,
          },
    ),
  );
}

/** Forget a finished action's result (e.g. when a new offline payload is opened). A running action stays. */
export function clearFinishedAction(): void {
  if (state.action?.done) update({ action: undefined });
}

/**
 * Offline cash, load: deposit a phone-minted coin into the escrow from this
 * wallet's public account (the coin commits to it as depositor). Checked and
 * simulated before signing; sent over the account's own Tor circuit.
 */
export async function offlineLoad(p: LoadPayload): Promise<void> {
  const kind = "offline-load";
  const status = (s: string) => update({ action: { kind, status: s } });
  try {
    if (!keys || !state.evmAddress) throw new Error("unlock the wallet first");
    status("Checking the coin over Tor…");
    const problems = await loadProblems(anon, p, state.evmAddress as Hex);
    if (problems.length) {
      update({ action: { kind, status: "Not loaded", done: true, error: problems.join(" ") } });
      return;
    }
    const txs = await sendCalls(anon, OFFLINE_CHAIN_ID, keys.evmAccount, [depositCall(p)], status);
    const ok = txs.every((t) => t.status === "success");
    update({ action: { kind, status: ok ? "Loaded. Tap \"Deposited\" on the phone." : "The deposit reverted", done: true, txs } });
    if (state.evmAddress) update({ publicWei: await publicBalance(anon, state.chainId, state.evmAddress).catch(() => state.publicWei) });
  } catch (e) {
    update({ action: { kind, status: "Load failed", done: true, error: revertReason(e) } });
  }
}

/**
 * Offline cash, cash out: submit a phone-signed redemption. The payout address
 * and amount are fixed by the phone's signature; this wallet only pays the
 * gas. Simulated first: a redemption that would freeze the coin (false) or
 * revert is never sent.
 */
export async function offlineRedeem(p: RedeemPayload): Promise<void> {
  const kind = "offline-redeem";
  const status = (s: string) => update({ action: { kind, status: s } });
  try {
    if (!keys || !state.evmAddress) throw new Error("unlock the wallet first");
    status("Simulating the cash-out over Tor…");
    const sim = await simulateRedeem(anon, p, state.evmAddress as Hex);
    if ("error" in sim) {
      update({ action: { kind, status: "Not sent", done: true, error: sim.error } });
      return;
    }
    if (!sim.paid) {
      update({ action: { kind, status: "Not sent", done: true, error: "the escrow would not pay this: it records a double spend and freezes the coin instead" } });
      return;
    }
    const txs = await sendCalls(anon, OFFLINE_CHAIN_ID, keys.evmAccount, [redeemCall(p)], status);
    const ok = txs.every((t) => t.status === "success");
    const amount = payoutValue(p);
    update({
      action: { kind, status: ok ? `Paid ${fmtEth(amount)} ETH to ${p.redemption.payout}.` : "The cash-out reverted", done: true, txs },
    });
    if (state.evmAddress) update({ publicWei: await publicBalance(anon, state.chainId, state.evmAddress).catch(() => state.publicWei) });
  } catch (e) {
    update({ action: { kind, status: "Cash-out failed", done: true, error: revertReason(e) } });
  }
}
