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
  /** Block of the public pool snapshot a new wallet started from. */
  snapshotBlock?: bigint;
  lastSyncMs?: number;
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

async function start(root: Uint8Array, fresh: boolean): Promise<void> {
  keys = await deriveWalletKeys(root);
  root.fill(0);
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
    fresh,
  });
  update({
    railgunAddress: opened.address,
    syncedBlock: BigInt(opened.syncedBlock),
    deploymentBlock: BigInt(deployment.deploymentBlock),
    wrappedBaseToken: deployment.wrappedBaseToken.toLowerCase(),
    restored: opened.restored,
    ...(opened.snapshotBlock ? { snapshotBlock: BigInt(opened.snapshotBlock) } : {}),
  });
  await sync();
}

export async function sync(): Promise<void> {
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
  }
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
    const { root, credentialId } = await createPasskey();
    await store.set(CREDENTIAL_KEY, credentialId);
    update({ hasPasskey: true });
    await start(root, true);
  });
}

/** Unlock with the remembered passkey, or (recovery on a new device) let the user pick any Prawl passkey. */
export function unlockWallet(): Promise<void> {
  return guarded(async () => {
    const remembered = await store.get<string>(CREDENTIAL_KEY);
    const { root, credentialId } = await unlockWithPasskey(remembered);
    if (!remembered) await store.set(CREDENTIAL_KEY, credentialId);
    update({ hasPasskey: true });
    await start(root, false);
  });
}

export async function lockWallet(): Promise<void> {
  keys = undefined;
  await railgun().call("close", undefined as never);
  update({ phase: "locked", railgunAddress: undefined, evmAddress: undefined, balances: undefined, syncedBlock: undefined });
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
 * Private transfer or unshield, as a paymaster-sponsored UserOperation.
 * The UserOperation's sender is a fresh one-time EIP-7702 account, never the
 * wallet's public account: gas comes out of the private balance, so the
 * sender needs no ETH and has no history to link to.
 */
async function privateOp(kind: "send" | "unshield", run: (oneTimeKey: Hex) => Promise<{ signed: unknown; userOpHash: Hex }>): Promise<void> {
  if (!keys) throw new Error("wallet is locked");
  const status = (s: string) => update({ action: { kind, status: s } });
  try {
    status("Proving in your browser… (this takes a while)");
    const oneTimeKey = generatePrivateKey();
    const sender = privateKeyToAddress(oneTimeKey);
    railgun().useAccount(sender);
    const prepared = await run(oneTimeKey);
    status("Sending to the bundler over Tor…");
    const tx = await sendUserOp(anon, state.chainId, sender, prepared.signed, prepared.userOpHash, status);
    update({ action: { kind, status: tx.status === "success" ? "Done." : "The operation reverted", done: true, txs: [tx] } });
    await sync();
  } catch (e) {
    update({ action: { kind, status: kind === "send" ? "Send failed" : "Unshield failed", done: true, error: e instanceof Error ? e.message : String(e) } });
  }
}

/** Send private ETH (WETH notes) to another 0zk address. */
export function privateSendEth(recipient: string, amountWei: bigint): Promise<void> {
  const weth = state.wrappedBaseToken as Hex | undefined;
  if (!weth) throw new Error("wallet is not open");
  return privateOp("send", (accountPrivateKey) =>
    railgun().call("prepareTransfer", { recipient, token: weth, amount: amountWei.toString(), accountPrivateKey, bundlerUrl: BUNDLER_URL }),
  );
}

/** Withdraw private ETH to a public address (as WETH; the 0.25% RAILGUN fee is added on top). */
export function unshieldEth(recipient: Hex, amountWei: bigint): Promise<void> {
  const weth = state.wrappedBaseToken as Hex | undefined;
  if (!weth) throw new Error("wallet is not open");
  return privateOp("unshield", (accountPrivateKey) =>
    railgun().call("prepareUnshield", { recipient, token: weth, amount: amountWei.toString(), accountPrivateKey, bundlerUrl: BUNDLER_URL }),
  );
}
