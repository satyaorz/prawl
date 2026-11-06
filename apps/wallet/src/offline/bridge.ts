/**
 * The native bridge of the Prawl Android app (`window.prawlOffline`), when this
 * page runs inside it. Same payloads as the QR and link handoffs (HANDOFF v1.1 /
 * v1.2), so everything a bridge returns goes through the same parser and the
 * same simulate-then-send checks as a scanned code. Without the bridge the page
 * falls back to QR and pasted links.
 *
 * Rules of the bridge (agreed with the Android side):
 *  - every call is async and resolves with JSON;
 *  - cashOut and refresh never sign by themselves: the phone shows its own
 *    confirmation (full payout address or npk, value) and a biometric prompt, and
 *    the page only asks. A refusal rejects: shown as "declined", never retried;
 *  - the bridge exists only for the exact allowed origin, never in iframes, and
 *    coins() returns no keys or certificates.
 */
import { encodeD, parsePayload, type OfflinePayload, type ShieldRequest, shieldRequestWire } from "./payload";

export interface BridgeCoin {
  coinId: string;
  /** Wei, decimal string. */
  valueWei: string;
  /** Unix seconds. */
  expiry: number;
  /** The phone's own wording, e.g. "unspent", "waiting for deposit". */
  state: string;
  /** Notes the coin has been split into; absent while the coin is whole. */
  notes?: Array<{ noteId: string; valueWei: string }>;
}

export interface PrawlOfflineBridge {
  mint(req: { depositor: string; valueWei: string; mode: "public" | "private" }): Promise<unknown>;
  coins(): Promise<BridgeCoin[]>;
  cashOut(req: { coinId: string; noteId?: string; to: { address: string } | { shield: Record<string, unknown> } }): Promise<unknown>;
  refresh(req: { coinId: string; noteId?: string }): Promise<unknown>;
  shieldAsk(req: { valueWei: string }): Promise<{ nonce: string }>;
  acceptShieldTarget(target: unknown): Promise<unknown>;
  markDeposited(req: { coinId: string; txHash: string }): Promise<unknown>;
  markRefreshed(req: { coinId: string; newCoinId?: string; txHash?: string }): Promise<unknown>;
}

const METHODS = ["mint", "coins", "cashOut", "refresh", "shieldAsk", "acceptShieldTarget", "markDeposited", "markRefreshed"] as const;

/** The bridge, if this page runs inside the Prawl app and it offers every method. */
export function getBridge(host: { prawlOffline?: unknown } | undefined = typeof window === "undefined" ? undefined : (window as unknown as { prawlOffline?: unknown })): PrawlOfflineBridge | undefined {
  const b = host?.prawlOffline as Record<string, unknown> | undefined;
  if (!b || typeof b !== "object") return undefined;
  return METHODS.every((m) => typeof b[m] === "function") ? (b as unknown as PrawlOfflineBridge) : undefined;
}

/** The user (or the phone's security check) refused on the phone. */
export class BridgeDeclined extends Error {
  override name = "BridgeDeclined";
  constructor() {
    super("declined on the phone");
  }
}

export class BridgeError extends Error {
  override name = "BridgeError";
}

const DECLINE = /declin|denied|cancel|reject|refus|not approved|user(?:_| )abort/i;

/** Run one bridge call: a refusal becomes BridgeDeclined, anything else BridgeError with the phone's message. */
export async function ask<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    const o = e as { code?: unknown; message?: unknown };
    const text = `${typeof o?.code === "string" ? o.code : ""} ${typeof o?.message === "string" ? o.message : String(e)}`;
    if (DECLINE.test(text)) throw new BridgeDeclined();
    throw new BridgeError(text.trim() || "the phone reported an error");
  }
}

/** A payload from the bridge, validated exactly like one from a scanned code. */
export function payloadFromBridge(raw: unknown, expect: ReadonlyArray<OfflinePayload["t"]>): OfflinePayload {
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  const p = parsePayload(value);
  if (!expect.includes(p.t)) throw new BridgeError(`the phone returned a ${p.t}, expected ${expect.join(" or ")}`);
  return p;
}

/** The link form of a payload, which the Offline card opens like a scanned one. */
export const payloadLink = (raw: unknown): string => {
  const t = (raw as { t?: string }).t;
  return `prawl://offline/${t}?d=${encodeD(raw)}`;
};

const NONCE = /^[0-9a-f]{32}$/;

/** Phone → website: mint a coin for this wallet's account. */
export async function mintOnPhone(b: PrawlOfflineBridge, req: { depositor: string; valueWei: bigint; mode: "public" | "private" }): Promise<{ payload: OfflinePayload; link: string }> {
  const raw = await ask(() => b.mint({ depositor: req.depositor, valueWei: req.valueWei.toString(), mode: req.mode }));
  const payload = payloadFromBridge(raw, [req.mode === "private" ? "load-private" : "load"]);
  return { payload, link: payloadLink(typeof raw === "string" ? JSON.parse(raw) : raw) };
}

/** Cash a coin out to a public address. The phone confirms the full address and amount itself. */
export async function cashOutToAddress(b: PrawlOfflineBridge, req: { coinId: string; noteId?: string; address: string }): Promise<{ payload: OfflinePayload; link: string }> {
  const raw = await ask(() => b.cashOut({ coinId: req.coinId, ...(req.noteId ? { noteId: req.noteId } : {}), to: { address: req.address } }));
  return { payload: payloadFromBridge(raw, ["redeem"]), link: payloadLink(typeof raw === "string" ? JSON.parse(raw) : raw) };
}

/**
 * Cash a note out into this wallet's private balance: the phone's nonce binds the shield target to this
 * request, the target is handed to the phone, and the phone signs over exactly it.
 */
export async function cashOutToShield(
  b: PrawlOfflineBridge,
  req: { coinId: string; noteId?: string; valueWei: bigint; escrow: `0x${string}`; chainId: number; buildTarget: (valueWei: bigint) => Promise<ShieldRequest> },
): Promise<{ payload: OfflinePayload; link: string }> {
  const { nonce } = await ask(() => b.shieldAsk({ valueWei: req.valueWei.toString() }));
  if (!NONCE.test(nonce)) throw new BridgeError("the phone's nonce is not 32 lowercase hex characters");
  const request = await req.buildTarget(req.valueWei);
  const wire = shieldRequestWire(request);
  await ask(() => b.acceptShieldTarget({ v: 1, t: "shield-target", chainId: req.chainId, escrow: req.escrow, nonce, request: wire }));
  const raw = await ask(() => b.cashOut({ coinId: req.coinId, ...(req.noteId ? { noteId: req.noteId } : {}), to: { shield: wire } }));
  const payload = payloadFromBridge(raw, ["redeem-shield"]);
  // The phone must have signed over exactly the request we gave it.
  if (payload.t === "redeem-shield" && JSON.stringify(shieldRequestWire(payload.shield)) !== JSON.stringify(wire)) {
    throw new BridgeError("the phone signed over a different shield request than the one it was given");
  }
  return { payload, link: payloadLink(typeof raw === "string" ? JSON.parse(raw) : raw) };
}

/** Ask the phone to refresh a coin before it expires. */
export async function refreshOnPhone(b: PrawlOfflineBridge, req: { coinId: string; noteId?: string }): Promise<{ payload: OfflinePayload; link: string }> {
  const raw = await ask(() => b.refresh({ coinId: req.coinId, ...(req.noteId ? { noteId: req.noteId } : {}) }));
  return { payload: payloadFromBridge(raw, ["refresh"]), link: payloadLink(typeof raw === "string" ? JSON.parse(raw) : raw) };
}

/** Best effort: tell the phone a coin is live (or refreshed). A failure here never undoes the transaction. */
export async function tellPhone(call: (b: PrawlOfflineBridge) => Promise<unknown>): Promise<void> {
  const b = getBridge();
  if (!b) return;
  try {
    await call(b);
  } catch {
    // The phone keeps the signed payload and can be told again.
  }
}
