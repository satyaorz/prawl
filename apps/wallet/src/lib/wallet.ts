/**
 * The unlocked wallet. Keys come from the passkey's PRF output and live only in
 * memory (here and in the RAILGUN worker) until lock(). Nothing secret is
 * stored: the passkey credential id (not secret) and sealed RAILGUN
 * checkpoints are all that touch disk.
 */
import { SEPOLIA } from "@prawl/anon-rpc";
import { createPasskey, deriveReclaimKey, deriveWalletKeys, unlockWithPasskey, type WalletKeys } from "@prawl/keys";
import type { Balance, Hex } from "@prawl/railgun";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { encodeFunctionData, getAddress, keccak256, parseAbi, toHex } from "viem";
import { anon } from "./anon";
import { store } from "./store";
import { ActivityLog, type Activity, type ActivityKind } from "./activity";
import { railgun } from "../railgun/controller";
import { publicBalance, sendCalls, sendUserOp, UnconfirmedError, type SentTx } from "./tx";
import { activateCall, coinStatus, commitCall, depositCall, erc20Balance, loadProblems, privateLoadProblems, redeemCall, redeemOutcome, redeemToShieldCall, refreshCall, revertReason, simulateRedeem } from "../offline/escrow";
import { OFFLINE_CHAIN_ID, payoutValue, type LoadPayload, type LoadPrivatePayload, type RedeemPayload, type RedeemShieldPayload, type RefreshPayload, type ShieldRequest } from "../offline/payload";
import { shieldRequestFromCall } from "../offline/shield";
import { tellPhone } from "../offline/bridge";
import { parseSwapDeployment } from "../swap/deployment";
import { SwapService } from "../swap/service";
import { validateDecryptAuthorization } from "../swap/fhe-authorization";

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
  /** RAILGUN smart wallet of this chain (target of shield calls). */
  smartWallet?: string;
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
  /** This wallet's own history, newest first (sealed on disk). */
  activity?: Activity[];
  /** RAILGUN unshield fee of this chain, basis points (from the chain config). */
  unshieldFeeBps?: number;
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
let activityLog: ActivityLog | undefined;
/**
 * Bumped whenever the unlocked wallet changes (unlock, lock, rescan). Work that
 * started under an earlier epoch (a sync, a private send, a history write)
 * must not touch the screen or another wallet's history after the change.
 */
let epoch = 0;
/** The swap session of the main account is keyed by this; swap accounts are keyed by their derivation index. */
const MAIN_SWAP_ACCOUNT = -1;
const swapServices = new Map<number, SwapService>();
const swapOpenings = new Map<number, Promise<SwapService>>();

/** Close every FHE worker and forget their decryption sessions on wallet changes. */
function closeSwapSession(): void {
  for (const service of swapServices.values()) service.close();
  swapServices.clear();
  const openings = [...swapOpenings.values()];
  swapOpenings.clear();
  for (const opening of openings) void opening.then((service) => service.close(), () => undefined);
}

/** A deployment is supplied at build time; the old mock-token pool is incompatible. */
export function swapConfigured(): boolean {
  return !!import.meta.env.VITE_PRAWL_SWAP_DEPLOYMENT;
}

/** The key of a swap participant: the main account, or a fresh account derived from the passkey (never the main one). */
async function swapKey(accountIndex: number): Promise<Hex> {
  if (!keys) throw new Error("Wallet was locked or changed");
  return accountIndex === MAIN_SWAP_ACCOUNT ? keys.evmAccount : deriveReclaimKey(keys.reclaimSeed, accountIndex);
}

/**
 * Open the confidential swap as the main account (default) or as one of this wallet's swap accounts.
 * A swap account is a fresh address derived from the passkey: funded from the private balance, it has
 * no on-chain link to the main account, and it talks to Tor and to the Zama gateway on a circuit of its own.
 */
export async function openSwapSession(accountIndex: number = MAIN_SWAP_ACCOUNT): Promise<SwapService> {
  if (!keys || !state.evmAddress || !state.wrappedBaseToken) throw new Error("Unlock and open the wallet first");
  const existing = swapServices.get(accountIndex);
  if (existing) return existing;
  const pending = swapOpenings.get(accountIndex);
  if (pending) return pending;
  const raw = import.meta.env.VITE_PRAWL_SWAP_DEPLOYMENT as string | undefined;
  if (!raw) throw new Error("No WETH/custom-token swap deployment is configured");
  let manifest: unknown;
  try { manifest = JSON.parse(raw); } catch { throw new Error("Invalid swap deployment configuration"); }
  const config = parseSwapDeployment(manifest, state.wrappedBaseToken);
  if (config.chainId !== state.chainId) throw new Error("Swap deployment is on a different network");
  const myEpoch = epoch;
  const ensureOpen = () => {
    if (!keys || myEpoch !== epoch) throw new Error("Wallet was locked or changed");
    return keys;
  };
  const account = getAddress(privateKeyToAddress(await swapKey(accountIndex)));
  const opening = SwapService.open(anon, account, config, {
    async signDecrypt(request, contracts) {
      ensureOpen();
      const key = await swapKey(accountIndex);
      const typedData = validateDecryptAuthorization(request, contracts);
      const signature = await privateKeyToAccount(key).signTypedData(typedData);
      ensureOpen();
      return signature;
    },
    async send(calls, onStatus) {
      ensureOpen();
      const key = await swapKey(accountIndex);
      const receipts = await sendCalls(anon, config.chainId, key, calls, onStatus, ensureOpen);
      ensureOpen();
      return receipts;
    },
  }).then((service) => {
    if (myEpoch !== epoch || !keys) { service.close(); throw new Error("Wallet was locked or changed"); }
    swapServices.set(accountIndex, service);
    return service;
  });
  swapOpenings.set(accountIndex, opening);
  try { return await opening; } finally { if (swapOpenings.get(accountIndex) === opening) swapOpenings.delete(accountIndex); }
}

/** Set the action result only if the wallet it belongs to is still the open one. */
function updateAction(forEpoch: number, action: NonNullable<WalletState["action"]>): void {
  if (forEpoch === epoch) update({ action });
}

/** The action result for a thrown error: "status unknown" when the submission may still land, else "failed". */
function failedAction(failure: string, e: unknown, message: string = e instanceof Error ? e.message : String(e)): NonNullable<WalletState["action"]> {
  if (e instanceof UnconfirmedError) {
    return {
      kind: "",
      status: "Status unknown",
      done: true,
      error: `${e.message}. Do not repeat it yet: after the next refresh check your balance and Activity, since a retry could pay twice.`,
    };
  }
  return { kind: "", status: failure, done: true, error: message };
}

/** Record finished transactions in the sealed history. Never fails the action. */
async function remember(log: ActivityLog | undefined, forEpoch: number, kind: ActivityKind, amountWei: bigint, to: string | undefined, txs: readonly SentTx[]): Promise<void> {
  try {
    for (const t of txs) {
      // `log` is the history of the wallet that started the action, never whichever is open now.
      const list = await log?.add({ at: Date.now(), kind, amount: amountWei.toString(), ...(to ? { to } : {}), txHash: t.hash, ok: t.status === "success" });
      if (list && forEpoch === epoch) update({ activity: list });
    }
  } catch {
    // history is a convenience; the transaction already happened
  }
}
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

/**
 * How far this device's clock runs ahead of the chain, measured once from the
 * latest block (best effort; 0 until known or when the clock is not ahead). The
 * passkey stores the wallet's creation time, and a fast clock would store a
 * time later than the real one.
 */
let clockSkewS = 0;
async function measureClockSkew(): Promise<void> {
  try {
    const block = (await anon.read(anon.identities.publicScope(`clock:${SEPOLIA}`), SEPOLIA, "eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    const skew = Math.floor(Date.now() / 1000) - Number(BigInt(block.timestamp));
    // A block is up to a slot and a bit of network delay old: only a clear lead counts.
    if (skew > 120) clockSkewS = skew;
  } catch {
    // unknown: the restore's 24 h slack still covers an ordinary error
  }
}
void measureClockSkew();

railgun().onProgress((p) => update({ syncedBlock: BigInt(p.synced), head: BigInt(p.head) }));

interface StartOptions {
  fresh: boolean;
  bornAt?: number;
  discardCheckpoint?: boolean;
}
async function start(root: Uint8Array, opts: StartOptions): Promise<void> {
  epoch += 1;
  closeSwapSession();
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
  const walletTag = `${state.chainId}:${keccak256(toHex(evmAddress)).slice(2, 18)}`;
  const checkpointName = `railgun:${walletTag}`;
  activityLog = new ActivityLog(store, keys.storage, `activity:${walletTag}`);
  void activityLog.load().then((activity) => update({ activity }), () => update({ activity: [] }));
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
    unshieldFeeBps: deployment.unshieldFeeBps,
    smartWallet: deployment.smartWallet,
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
/**
 * A sync waits on the Tor worker and the network. If one request never answers (a Tor guard that cannot be reached,
 * a stalled node), the single-flight below would stay pending forever: the screen says "Syncing…" for good and the
 * actions that need a ready wallet stay disabled. After this long, say so and let Refresh start a new attempt; the old
 * attempt is not cancelled and still updates the screen if it eventually finishes.
 */
const SYNC_WATCHDOG_MS = 180_000;

export function sync(): Promise<void> {
  if (running) return running;
  const attempt: Promise<void> = Promise.race([
    doSync(),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        if (running === attempt && (state.phase === "syncing" || state.phase === "opening")) {
          update({ phase: "error", error: "Syncing is taking longer than usual: the network may be slow. Press Refresh to try again." });
        }
        resolve();
      }, SYNC_WATCHDOG_MS),
    ),
  ]).finally(() => {
    if (running === attempt) running = undefined;
  });
  running = attempt;
  return attempt;
}

async function doSync(): Promise<void> {
  if (!keys) return;
  const rg = railgun();
  const myEpoch = epoch;
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
    if (myEpoch !== epoch) return; // locked or switched while we waited: show nothing of this wallet
    update({ phase: "ready", balances, lastSyncMs: performance.now() - t0, ...(publicWei !== undefined ? { publicWei } : {}) });
  } catch (e) {
    if (myEpoch === epoch) update({ phase: "error", error: e instanceof Error ? e.message : String(e) });
    return;
  }
  await submitPendingPoi(myEpoch);
}

/**
 * After our private send or unshield lands, its PPOI proofs must reach the
 * PPOI node, or the recipient's notes never become spendable. The queue lives
 * in the checkpoint; a proof the node cannot take yet (transaction not
 * indexed, input not valid yet) stays queued for the next sync. Failures here
 * never fail the sync.
 */
async function submitPendingPoi(myEpoch: number): Promise<void> {
  const rg = railgun();
  try {
    const queued = await rg.call("poiPendingCount", undefined as never);
    if (myEpoch !== epoch) return;
    update({ poiQueue: queued });
    if (queued === 0) return;
    const report = await rg.call("processPendingPoi", undefined as never);
    if (myEpoch !== epoch) return;
    update({ poiQueue: report.pendingAfter, poiError: report.failed[0]?.error });
    if (report.submitted.length > 0) {
      await rg.call("refreshPoi", undefined as never);
      const balances = await rg.call("balances", undefined as never);
      if (myEpoch === epoch) update({ balances });
    }
  } catch (e) {
    if (myEpoch === epoch) update({ poiError: e instanceof Error ? e.message : String(e) });
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
    const { root, credentialId, bornAt } = await createPasskey(undefined, { clockSkewS });
    await store.set(CREDENTIAL_KEY, credentialId);
    update({ hasPasskey: true });
    await start(root, { fresh: true, ...(bornAt !== undefined ? { bornAt } : {}) });
  });
}

/** Unlock with the remembered passkey, or (recovery on a new device) let the user pick any Prowl passkey. */
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
  epoch += 1;
  closeSwapSession();
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
  epoch += 1;
  closeSwapSession();
  stopAutoSync();
  keys = undefined;
  activityLog = undefined;
  await railgun().call("close", undefined as never);
  update({ phase: "locked", railgunAddress: undefined, evmAddress: undefined, balances: undefined, syncedBlock: undefined, poiQueue: undefined, poiError: undefined, activity: undefined, action: undefined, publicWei: undefined, privateGasWei: undefined });
}

/**
 * Send ETH from the public account to another public address (e.g. leftovers
 * after shielding). This links the two addresses on chain, like any transfer.
 */
export async function sendPublicEth(to: Hex, amountWei: bigint): Promise<void> {
  const kind = "public-send";
  const opLog = activityLog;
  const myEpoch = epoch;
  const status = (s: string) => updateAction(myEpoch, { kind, status: s });
  try {
    if (!keys) throw new Error("wallet is locked");
    const txs = await sendCalls(anon, state.chainId, keys.evmAccount, [{ to, data: "0x", value: amountWei }], status);
    await remember(opLog, myEpoch, "public-send", amountWei, to, txs);
    const ok = txs.every((t) => t.status === "success");
    updateAction(myEpoch, { kind, status: ok ? `Sent ${fmtEth(amountWei)} ETH.` : "The transfer reverted", done: true, txs });
    if (state.evmAddress) update({ publicWei: await publicBalance(anon, state.chainId, state.evmAddress).catch(() => state.publicWei) });
  } catch (e) {
    updateAction(myEpoch, { ...failedAction("Send failed", e), kind });
    if (e instanceof UnconfirmedError) void sync();
  }
}

/** Move public ETH from the wallet's EVM account into the private balance. */
export async function shieldEth(amountWei: bigint): Promise<void> {
  if (!keys || !state.railgunAddress) throw new Error("wallet is locked");
  const kind = "shield";
  const opLog = activityLog;
  const myEpoch = epoch;
  const status = (s: string) => updateAction(myEpoch, { kind, status: s });
  try {
    status("Building shield…");
    const calls = await railgun().call("buildShield", {
      recipient: state.railgunAddress,
      items: [{ token: "native", amount: amountWei.toString() }],
    });
    const txs = await sendCalls(anon, state.chainId, keys.evmAccount, calls, status);
    await remember(opLog, myEpoch, "shield", amountWei, undefined, txs);
    const ok = txs.every((t) => t.status === "success");
    updateAction(myEpoch, { kind, status: ok ? "Shielded. It shows as pending until the PPOI check clears." : "Shield transaction reverted", done: true, txs });
    await sync();
  } catch (e) {
    updateAction(myEpoch, { ...failedAction("Shield failed", e), kind });
    if (e instanceof UnconfirmedError) void sync();
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Reclaim accounts: a fresh address per private offline coin, derived from the passkey (see deriveReclaimKey). A coin that expires unspent
// is refunded to its reclaim address, so that address is not your main one and never appears next to it in the coin or the refund. The
// counter is stored per wallet; a restore on a new device starts it at 0 again, so reclaimAccounts() scans a window to find old ones.
// ---------------------------------------------------------------------------------------------------------------------------------

export interface ReclaimAccount {
  index: number;
  address: Hex;
  balanceWei: bigint;
}

const reclaimCounterKey = (): string => `reclaim:next:${state.evmAddress ?? "none"}`;
let reclaimQueue: Promise<unknown> = Promise.resolve();

/** The next unused reclaim address (and its index). Reserved at once: asking twice never returns the same one. */
export function nextReclaimAddress(): Promise<{ index: number; address: Hex }> {
  const run = async () => {
    if (!keys) throw new Error("wallet is locked");
    const key = reclaimCounterKey();
    const index = (await store.get<number>(key)) ?? 0;
    const address = privateKeyToAddress(await deriveReclaimKey(keys.reclaimSeed, index));
    await store.set(key, index + 1);
    return { index, address };
  };
  const next = reclaimQueue.then(run, run);
  reclaimQueue = next.catch(() => undefined);
  return next;
}

/** How far past the counter to look, and the window used when the counter is unknown (a restored wallet). */
const RECLAIM_SCAN_AHEAD = 3;
const RECLAIM_RESTORE_WINDOW = 12;

/** Balances of the reclaim accounts, each read over its own Tor identity. Slow on purpose: only when the user asks. */
export async function reclaimAccounts(): Promise<ReclaimAccount[]> {
  if (!keys) throw new Error("wallet is locked");
  const next = (await store.get<number>(reclaimCounterKey())) ?? 0;
  const upTo = Math.max(next + RECLAIM_SCAN_AHEAD, next === 0 ? RECLAIM_RESTORE_WINDOW : 0);
  const out: ReclaimAccount[] = [];
  for (let index = 0; index < upTo; index++) {
    const address = privateKeyToAddress(await deriveReclaimKey(keys.reclaimSeed, index));
    out.push({ index, address, balanceWei: await publicBalance(anon, state.chainId, address) });
  }
  return out;
}

/** Kept back to pay the shield transaction's gas from the account itself (~1.14M gas measured; the same reserve as the shield form). */
const RECLAIM_GAS_RESERVE_WEI = 3_000_000_000_000_000n;

/** Shield everything a reclaim account holds (minus gas) into the private balance, signed by that account's own key. */
export async function shieldFromReclaim(index: number): Promise<void> {
  if (!keys || !state.railgunAddress) throw new Error("wallet is locked");
  const kind = "shield";
  const opLog = activityLog;
  const myEpoch = epoch;
  const status = (s: string) => updateAction(myEpoch, { kind, status: s });
  try {
    const key = await deriveReclaimKey(keys.reclaimSeed, index);
    const address = privateKeyToAddress(key);
    status("Reading the reclaim account…");
    const balance = await publicBalance(anon, state.chainId, address);
    if (balance <= RECLAIM_GAS_RESERVE_WEI) throw new Error(`This reclaim account holds ${fmtEth(balance)} ETH, not enough to shield after gas`);
    const amountWei = balance - RECLAIM_GAS_RESERVE_WEI;
    status("Building shield…");
    const calls = await railgun().call("buildShield", {
      recipient: state.railgunAddress,
      items: [{ token: "native", amount: amountWei.toString() }],
    });
    const txs = await sendCalls(anon, state.chainId, key, calls, status);
    await remember(opLog, myEpoch, "shield", amountWei, undefined, txs);
    const ok = txs.every((t) => t.status === "success");
    updateAction(myEpoch, { kind, status: ok ? "Shielded from the reclaim account. It shows as pending until the PPOI check clears." : "Shield transaction reverted", done: true, txs });
    await sync();
  } catch (e) {
    updateAction(myEpoch, { ...failedAction("Shield failed", e), kind });
    if (e instanceof UnconfirmedError) void sync();
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Swap accounts: a fresh account per private swap, so the swap is not tied to the main public address. It is one of the passkey-derived
// accounts used for offline-cash reclaim (same counter, so an index is never reused). A restored wallet does not know which indices it
// used; reclaimAccounts() scans a window and shows their balances.
// ---------------------------------------------------------------------------------------------------------------------------------

export interface SwapAccount {
  index: number;
  address: Hex;
}

const swapAccountsKey = (): string => `swap:accounts:${state.evmAddress ?? "none"}`;

/** The swap accounts this wallet has created, oldest first. */
export async function swapAccounts(): Promise<SwapAccount[]> {
  return (await store.get<SwapAccount[]>(swapAccountsKey())) ?? [];
}

/** Reserve a fresh swap account. Nothing is sent: it has no balance and no on-chain trace yet. */
export async function newSwapAccount(): Promise<SwapAccount> {
  const account = await nextReclaimAddress();
  await store.set(swapAccountsKey(), [...(await swapAccounts()), account]);
  return account;
}

/** Gas the swap account keeps for its own transactions (wrap, fund, order, advance, exit): FHE calls cost up to ~3M gas each. */
export const SWAP_ACCOUNT_GAS_WEI = 3_000_000_000_000_000n;

const wethAbi = parseAbi(["function deposit() payable", "function withdraw(uint256)"]);

/** A token balance read over the account's own Tor circuit (not the shared public one), like the rest of a swap account's traffic. */
async function accountTokenBalance(token: Hex, owner: Hex): Promise<bigint> {
  const data = `0x70a08231${owner.slice(2).toLowerCase().padStart(64, "0")}`;
  const out = await anon.read(anon.identities.account(owner), state.chainId, "eth_call", [{ to: token, data }, "latest"]);
  if (typeof out !== "string" || !/^0x[0-9a-fA-F]*$/.test(out)) throw new Error("Invalid token balance response");
  return out === "0x" ? 0n : BigInt(out);
}

/**
 * Fund a swap account from the PRIVATE balance: the amount (plus gas) is unshielded straight to it, so no
 * transaction connects it to the main account, then it turns the ETH into WETH by itself. The user pays the
 * usual unshield fee out of the private balance. Returns whether everything completed.
 */
export async function fundSwapAccount(index: number, wethWei: bigint, onStatus?: (status: string) => void): Promise<boolean> {
  if (!keys || !state.wrappedBaseToken) throw new Error("Unlock and open the wallet first");
  const myEpoch = epoch;
  const weth = state.wrappedBaseToken as Hex;
  const key = await swapKey(index);
  const address = privateKeyToAddress(key);
  const total = wethWei + SWAP_ACCOUNT_GAS_WEI;
  onStatus?.("Moving the amount from your private balance to a fresh swap account…");
  if (!(await unshieldEth(address, total))) return false;
  // Public nodes can lag a block behind: wait until the account really shows the ETH.
  let balance = 0n;
  for (let i = 0; i < 30 && balance < total; i++) {
    balance = await publicBalance(anon, state.chainId, address).catch(() => 0n);
    if (balance < total) await new Promise((r) => setTimeout(r, 4000));
    if (myEpoch !== epoch) throw new Error("Wallet was locked or changed");
  }
  if (balance < total) throw new Error("The swap account has not received the funds yet. Try again in a minute.");
  onStatus?.("The swap account is turning the ETH into WETH…");
  const txs = await sendCalls(anon, state.chainId, key, [{ to: weth, value: wethWei, data: encodeFunctionData({ abi: wethAbi, functionName: "deposit" }) }], onStatus, () => {
    if (myEpoch !== epoch) throw new Error("Wallet was locked or changed");
  });
  return txs.every((t) => t.status === "success");
}

/** WETH and ETH a swap account holds, for display. */
export async function swapAccountBalances(index: number): Promise<{ address: Hex; ethWei: bigint; wethWei: bigint }> {
  if (!keys || !state.wrappedBaseToken) throw new Error("Unlock and open the wallet first");
  const address = privateKeyToAddress(await swapKey(index));
  const [ethWei, wethWei] = await Promise.all([
    publicBalance(anon, state.chainId, address),
    accountTokenBalance(state.wrappedBaseToken as Hex, address),
  ]);
  return { address, ethWei, wethWei };
}

/**
 * Return a swap account's WETH to the private balance: unwrap it to ETH there, then shield the ETH (minus the gas
 * the shield transaction needs), signed by that account. Anything above dust is shielded; the rest stays for gas.
 */
export async function shieldBackFromSwapAccount(index: number, onStatus?: (status: string) => void): Promise<void> {
  if (!keys || !state.wrappedBaseToken) throw new Error("Unlock and open the wallet first");
  const myEpoch = epoch;
  const key = await swapKey(index);
  const address = privateKeyToAddress(key);
  const weth = await accountTokenBalance(state.wrappedBaseToken as Hex, address);
  if (weth > 0n) {
    onStatus?.("Unwrapping WETH in the swap account…");
    const txs = await sendCalls(anon, state.chainId, key, [{ to: state.wrappedBaseToken as Hex, value: 0n, data: encodeFunctionData({ abi: wethAbi, functionName: "withdraw", args: [weth] }) }], onStatus, () => {
      if (myEpoch !== epoch) throw new Error("Wallet was locked or changed");
    });
    if (!txs.every((t) => t.status === "success")) throw new Error("Unwrapping reverted");
  }
  onStatus?.("Shielding it back into your private balance…");
  await shieldFromReclaim(index);
}

/**
 * Gas for a private operation is paid by the RAILGUN paymaster out of the
 * private balance (WETH), on top of the amount. Measured live on Sepolia:
 * an unshield used 2.05M gas, about 0.0033 ETH. Until this wallet has
 * measured its own, assume this much.
 */
export const DEFAULT_PRIVATE_GAS_WEI = 3_500_000_000_000_000n;
/** RAILGUN unshield fee in basis points when the chain config has not told us (Sepolia and mainnet: 25). */
export const UNSHIELD_FEE_BPS = 25n;
const feeBps = (): bigint => BigInt(state.unshieldFeeBps ?? Number(UNSHIELD_FEE_BPS));

/**
 * kohaku's gross_up: the smallest gross whose net after RAILGUN's fee,
 * gross - floor(gross * bps / 10000), is at least `amount`. The recipient gets
 * exactly `amount`; the fee is gross - amount.
 */
export function grossUp(amount: bigint, bps: bigint = feeBps()): bigint {
  if (amount <= 0n) return 0n;
  const net = (g: bigint) => g - (g * bps) / 10_000n;
  let g = (amount * 10_000n + (10_000n - bps) - 1n) / (10_000n - bps);
  while (g > 1n && net(g - 1n) >= amount) g -= 1n;
  while (net(g) < amount) g += 1n;
  return g;
}

export function privateFeeWei(kind: "send" | "unshield", amountWei: bigint): bigint {
  return kind === "unshield" ? grossUp(amountWei) - amountWei : 0n;
}

/** Gas to expect for the next private operation: the last one measured here, with 20% headroom, or the default. */
export function privateGasEstimateWei(): bigint {
  return state.privateGasWei !== undefined ? (state.privateGasWei * 12n) / 10n : DEFAULT_PRIVATE_GAS_WEI;
}

/** A measured gas outside this band is treated as noise (a note arrived or left mid-operation) and ignored. */
const GAS_MEASURE_MIN = DEFAULT_PRIVATE_GAS_WEI / 2n;
const GAS_MEASURE_MAX = DEFAULT_PRIVATE_GAS_WEI * 3n;

/** Largest amount that fits in `available` once gas and the fee are taken. */
export function maxPrivateAmountWei(kind: "send" | "unshield", available: bigint): bigint {
  const rest = available - privateGasEstimateWei();
  if (rest <= 0n) return 0n;
  // The net of a gross of `rest`: grossUp of it is at most `rest`.
  return kind === "unshield" ? rest - (rest * feeBps()) / 10_000n : rest;
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
  to: string,
  run: (oneTimeKey: Hex) => Promise<{ signed: unknown; userOpHash: Hex }>,
  /**
   * `inner`: this is one step of a larger action (a private load). Progress and failures
   * are reported under `inner.kind`, and success does not finish that action.
   */
  inner?: { kind: string },
): Promise<boolean> {
  if (!keys) throw new Error("wallet is locked");
  const opLog = activityLog;
  const myEpoch = epoch;
  const actionKind = inner?.kind ?? kind;
  const status = (s: string) => updateAction(myEpoch, { kind: actionKind, status: s });
  try {
    const before = wethTotal();
    status("Proving in your browser… (this takes a while)");
    const oneTimeKey = generatePrivateKey();
    const sender = privateKeyToAddress(oneTimeKey);
    railgun().useAccount(sender);
    const prepared = await run(oneTimeKey);
    status("Sending to the bundler over Tor…");
    const tx = await sendUserOp(anon, state.chainId, sender, prepared.signed, prepared.userOpHash, status);
    await remember(opLog, myEpoch, kind, amountWei, to, [tx]);
    if (!inner || tx.status !== "success") updateAction(myEpoch, { kind: actionKind, status: tx.status === "success" ? "Done." : "The operation reverted", done: true, txs: [tx] });
    await sync();
    // What the paymaster took: everything that left the balance beyond the amount and fee.
    const gas = before - wethTotal() - amountWei - privateFeeWei(kind, amountWei);
    if (tx.status === "success" && gas >= GAS_MEASURE_MIN && gas <= GAS_MEASURE_MAX && myEpoch === epoch) update({ privateGasWei: gas });
    return tx.status === "success";
  } catch (e) {
    updateAction(myEpoch, { ...failedAction(kind === "send" ? "Send failed" : "Unshield failed", e, explain(kind, e)), kind: actionKind });
    if (e instanceof UnconfirmedError) void sync();
    return false;
  }
}

/** Send private ETH (WETH notes) to another 0zk address. */
export function privateSendEth(recipient: string, amountWei: bigint): Promise<boolean> {
  const weth = state.wrappedBaseToken as Hex | undefined;
  if (!weth) throw new Error("wallet is not open");
  return privateOp("send", amountWei, recipient, (accountPrivateKey) =>
    railgun().call("prepareTransfer", { recipient, token: weth, amount: amountWei.toString(), accountPrivateKey, bundlerUrl: BUNDLER_URL }),
  );
}

/**
 * Withdraw private ETH to a public address; the 0.25% RAILGUN fee is added on top.
 * As native ETH (default): WETH is unshielded to the one-time account, unwrapped
 * there, and the ETH forwarded to the recipient in the same UserOperation.
 * With `asWeth`, the recipient gets WETH directly (cheaper).
 */
export function unshieldEth(recipient: Hex, amountWei: bigint, opts: { asWeth?: boolean; inner?: { kind: string } } = {}): Promise<boolean> {
  const weth = state.wrappedBaseToken as Hex | undefined;
  if (!weth) throw new Error("wallet is not open");
  return privateOp("unshield", amountWei, recipient, (accountPrivateKey) =>
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
    opts.inner,
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
  const opLog = activityLog;
  const myEpoch = epoch;
  const status = (s: string) => updateAction(myEpoch, { kind, status: s });
  try {
    if (!keys || !state.evmAddress) throw new Error("unlock the wallet first");
    status("Checking the coin over Tor…");
    const problems = await loadProblems(anon, p, state.evmAddress as Hex);
    if (problems.length) {
      updateAction(myEpoch, { kind, status: "Not loaded", done: true, error: problems.join(" ") });
      return;
    }
    const txs = await sendCalls(anon, OFFLINE_CHAIN_ID, keys.evmAccount, [depositCall(p)], status);
    await remember(opLog, myEpoch, "offline-load", p.value, p.coinId, txs);
    const ok = txs.every((t) => t.status === "success");
    const told = ok && (await tellPhone((b) => b.markDeposited({ coinId: p.coinId, txHash: txs.at(-1)!.hash })));
    updateAction(myEpoch, { kind, status: ok ? (told ? "Loaded. This phone was told." : "Loaded. Tap \"Deposited\" on the phone.") : "The deposit reverted", done: true, txs });
    if (state.evmAddress) update({ publicWei: await publicBalance(anon, state.chainId, state.evmAddress).catch(() => state.publicWei) });
  } catch (e) {
    updateAction(myEpoch, { ...failedAction("Load failed", e, revertReason(e)), kind });
  }
}

/**
 * Offline cash, cash out: submit a phone-signed redemption. The payout address
 * and amount are fixed by the phone's signature; this wallet only pays the
 * gas. Simulated first: a redemption that would freeze the coin (false) or
 * revert is never sent.
 */
export async function offlineRedeem(p: RedeemPayload | RedeemShieldPayload | RefreshPayload): Promise<void> {
  const kind = "offline-redeem";
  const toShield = p.t === "redeem-shield";
  const isRefresh = p.t === "refresh";
  const opLog = activityLog;
  const myEpoch = epoch;
  const status = (s: string) => updateAction(myEpoch, { kind, status: s });
  try {
    if (!keys || !state.evmAddress) throw new Error("unlock the wallet first");
    status("Simulating the cash-out over Tor…");
    const sim = await simulateRedeem(anon, p, state.evmAddress as Hex);
    if ("error" in sim) {
      updateAction(myEpoch, { kind, status: "Not sent", done: true, error: sim.error });
      return;
    }
    if (!sim.paid) {
      updateAction(myEpoch, { kind, status: "Not sent", done: true, error: "the escrow would not pay this: it records a double spend and freezes the coin instead" });
      return;
    }
    const call = p.t === "redeem-shield" ? redeemToShieldCall(p) : p.t === "refresh" ? refreshCall(p) : redeemCall(p);
    const txs = await sendCalls(anon, OFFLINE_CHAIN_ID, keys.evmAccount, [call], status);
    const amount = payoutValue(p);
    const mined = txs.at(-1);
    // The receipt status is not enough: a mined redeem may have frozen the coin or only deferred the payment.
    const outcome = mined?.status === "success" ? redeemOutcome(mined.logs ?? [], p) : undefined;
    const to = toShield ? "your private balance" : p.redemption.payout;
    // A refresh is only done when the new coin exists in the escrow: the phone marks it spendable on this word.
    const newCoinLive = p.t === "refresh" && outcome?.kind === "paid" ? (await coinStatus(anon, p.refresh.newCoinId, p.escrow).catch(() => undefined))?.deposited === true : false;
    if (p.t === "refresh" && newCoinLive && mined) void tellPhone((b) => b.markRefreshed({ coinId: p.header.coinId, newCoinId: p.refresh.newCoinId, txHash: mined.hash }));
    await remember(opLog, myEpoch, "offline-redeem", amount, toShield ? state.railgunAddress : isRefresh ? undefined : p.redemption.payout, txs.map((t) => ({ ...t, status: outcome?.kind === "paid" ? t.status : "reverted" as const })));
    const text =
      !outcome
        ? { status: "The cash-out reverted" }
        : outcome.kind === "paid"
          ? {
              status: p.t === "refresh"
                ? newCoinLive
                  ? `Refreshed: ${fmtEth(outcome.amount)} ETH now sits in a new coin until ${new Date(Number(p.refresh.newExpiry) * 1000).toLocaleString()}. Tell the phone it is done.`
                  : `The refresh was mined, but the new coin is not visible yet: check again before telling the phone.`
              : toShield
                ? `Cashed out ${fmtEth(outcome.amount)} ETH into your private balance (RAILGUN keeps its 0.25% shield fee). It shows as pending until the PPOI check clears.`
                : `Paid ${fmtEth(outcome.amount)} ETH to ${to}.`,
            }
          : outcome.kind === "deferred"
            ? { status: "Not paid out yet", error: `The payout address did not accept ETH; ${fmtEth(outcome.amount)} ETH is owed to it in the escrow and it can withdraw it (withdrawOwed).` }
            : outcome.kind === "blocked"
              ? { status: "Not paid", error: `The escrow found a double spend on this coin's path and ${outcome.frozen ? "froze the coin" : "blocked this cash-out"}. Nothing was paid.` }
              : { status: "Mined, but no payout was seen", error: "Check the coin's status before trying again." };
    updateAction(myEpoch, { kind, ...text, done: true, txs });
    await refreshPublicBalance(myEpoch);
    if (toShield && outcome?.kind === "paid") void sync(); // pick up the new shielded note
  } catch (e) {
    updateAction(myEpoch, { ...failedAction("Cash-out failed", e, revertReason(e)), kind });
  }
}

async function refreshPublicBalance(forEpoch: number): Promise<void> {
  if (!state.evmAddress) return;
  const wei = await publicBalance(anon, state.chainId, state.evmAddress).catch(() => undefined);
  if (wei !== undefined && forEpoch === epoch) update({ publicWei: wei });
}

/** Spendable private ETH: WETH notes whose PPOI status is Valid. */
function spendableWei(): bigint {
  return (state.balances ?? [])
    .filter((b) => b.token !== undefined && b.token === state.wrappedBaseToken && b.poiStatus === "Valid")
    .reduce((sum, b) => sum + BigInt(b.amount), 0n);
}

/**
 * Offline cash, private load: fund a coin from the private balance without the
 * public account ever holding the money.
 *   1. commitDeposit (reserves the coin id for exactly these parameters),
 *   2. a RAILGUN unshield of WETH to the coin's deposit address (a paymaster
 *      UserOperation from a one-time account, like any private withdrawal),
 *   3. activate (anyone may call it; the coin is created from what arrived).
 * Resumable: a commitment that is already ours is not repeated, and a deposit
 * address that already holds the amount is not funded twice.
 */
export async function offlineLoadPrivate(p: LoadPrivatePayload): Promise<void> {
  const kind = "offline-load";
  const opLog = activityLog;
  const myEpoch = epoch;
  const status = (s: string) => updateAction(myEpoch, { kind, status: s });
  try {
    if (!keys || !state.evmAddress || !state.wrappedBaseToken) throw new Error("unlock the wallet first");
    const weth = state.wrappedBaseToken as Hex;
    status("Checking the coin over Tor…");
    const { problems, fundWei, committed } = await privateLoadProblems(anon, p);
    if (problems.length) {
      updateAction(myEpoch, { kind, status: "Not loaded", done: true, error: problems.join(" ") });
      return;
    }
    const funded = (await erc20Balance(anon, weth, p.depositAddress)) >= fundWei;
    if (!funded) {
      const max = maxPrivateAmountWei("unshield", spendableWei());
      if (max < fundWei) {
        updateAction(myEpoch, {
          kind,
          status: "Not enough private ETH",
          done: true,
          error: `The coin needs ${fmtEth(fundWei)} ETH delivered, plus RAILGUN's 0.25% fee and about ${fmtEth(privateGasEstimateWei())} ETH of gas, all from your spendable private balance (at most ${fmtEth(max)} ETH can be sent now).`,
        });
        return;
      }
    }
    if (!committed) {
      status("Reserving the coin (commitDeposit)…");
      const txs = await sendCalls(anon, OFFLINE_CHAIN_ID, keys.evmAccount, [commitCall(p)], status);
      if (txs.some((t) => t.status !== "success")) {
        updateAction(myEpoch, { kind, status: "The commitment reverted", done: true, txs });
        return;
      }
    }
    if (!funded) {
      status("Funding the coin from your private balance…");
      const ok = await unshieldEth(p.depositAddress, fundWei, { asWeth: true, inner: { kind } });
      if (!ok) return; // privateOp already reported why
    }
    if (myEpoch !== epoch) return;
    status("Activating the coin…");
    // If the funds have not arrived yet the gas estimate reverts with Underfunded and nothing is sent.
    const txs = await sendCalls(anon, OFFLINE_CHAIN_ID, keys.evmAccount, [activateCall(p)], status);
    await remember(opLog, myEpoch, "offline-load", fundWei, p.params.coinId, txs);
    const ok = txs.every((t) => t.status === "success");
    const told = ok && (await tellPhone((b) => b.markDeposited({ coinId: p.params.coinId, txHash: txs.at(-1)!.hash })));
    updateAction(myEpoch, {
      kind,
      status: ok ? (told ? "Loaded privately. This phone was told." : "Loaded privately. Tap \"Deposited\" on the phone.") : "Activation reverted",
      done: true,
      ...(ok ? {} : { error: `The funds are at ${p.depositAddress}. Open the same link again to retry activation; the depositor ${p.params.depositor} can also refund.` }),
      txs,
    });
    await refreshPublicBalance(myEpoch);
  } catch (e) {
    const note = `The funds, if already sent, are at ${p.depositAddress}; open the same link again to continue.`;
    const failed = failedAction("Load failed", e, `${revertReason(e)} ${note}`);
    updateAction(myEpoch, { ...failed, kind, ...(e instanceof UnconfirmedError ? { error: `${failed.error} ${note}` } : {}) });
  }
}

/**
 * The target a phone must sign a cash-out into your private balance over
 * (HANDOFF §6): a RAILGUN ShieldRequest for exactly `valueWei` of WETH to this
 * wallet's own 0zk address, built by kohaku and decoded from its shield call.
 * The request is single-use: make a fresh one for each cash-out.
 */
export async function buildShieldTarget(valueWei: bigint): Promise<ShieldRequest> {
  if (!keys || !state.railgunAddress || !state.wrappedBaseToken || !state.smartWallet) throw new Error("unlock the wallet first");
  if (valueWei <= 0n) throw new Error("enter an amount above zero");
  const calls = await railgun().call("buildShield", {
    recipient: state.railgunAddress,
    items: [{ token: state.wrappedBaseToken as Hex, amount: valueWei.toString() }],
  });
  if (calls.length !== 1) throw new Error(`expected one shield call, got ${calls.length}`);
  return shieldRequestFromCall(calls[0]!, state.smartWallet as Hex);
}
