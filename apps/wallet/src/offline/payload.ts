/**
 * Phone ↔ website handoff for offline cash (HANDOFF v1). Payloads are UTF-8
 * JSON, base64url without padding, carried as
 *   https://<site>/#/offline/<kind>?d=<d>   or   prawl://offline/<kind>?d=<d>
 * The fragment keeps the payload out of server logs. Pure parsing and checks
 * here; chain calls live in escrow.ts.
 */
import { getAddress, isAddress, type Hex } from "viem";

export const OFFLINE_CHAIN_ID = 11_155_111;
export const ESCROW_V3 = "0x70b3B7EdCD18087C999ec80e3C3B0227c7e0D6E5" as const;
/** v3.1 adds private load (commit, fund by RAILGUN unshield, activate) and cash-out into a shield. Plain load/redeem work on both. */
export const ESCROW_V31 = "0x236b1dC3b1a90E23728DA6E361b0Ab1C386cd779" as const;
/** v3.2 = v3.1 plus the audit's contract fixes: same ABI and storage layout, so every v3.1 flow works on it. */
export const ESCROW_V32 = "0x2492B9199d7029a0e0801bf226Fd5afc75C99B12" as const;
export const KNOWN_ESCROWS: readonly Hex[] = [ESCROW_V3, ESCROW_V31, ESCROW_V32];
/** Escrows with commit-then-fund, shield cash-out and refresh. */
export const RAILGUN_ESCROWS: readonly Hex[] = [ESCROW_V31, ESCROW_V32];
const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface Output {
  value: bigint;
  keyHash: Hex;
}
export interface Header {
  coinId: Hex;
  value: bigint;
  expiry: bigint;
  k0x: bigint;
  k0y: bigint;
  depositor: Hex;
}
export interface Spend {
  outputs: Output[];
  index: bigint;
  r: Hex;
  s: Hex;
  nextX: Hex;
  nextY: Hex;
}
export interface Redemption {
  outputs: Output[];
  index: bigint;
  payout: Hex;
  r: Hex;
  s: Hex;
}

export interface LoadPayload {
  t: "load";
  chainId: number;
  escrow: Hex;
  coinId: Hex;
  value: bigint;
  expiry: bigint;
  k0x: bigint;
  k0y: bigint;
  depositor: Hex;
}
export interface RedeemPayload {
  t: "redeem";
  chainId: number;
  escrow: Hex;
  header: Header;
  path: Spend[];
  redemption: Redemption;
}
/** Parameters of a commit-then-fund deposit: fix the coin and where its funds must arrive. */
export interface DepositParams {
  coinId: Hex;
  expiry: bigint;
  k0x: bigint;
  k0y: bigint;
  /** Reclaim/refund address only (not the funder): use a fresh public address. */
  depositor: Hex;
  minValue: bigint;
  maxValue: bigint;
  tip: bigint;
}
export interface LoadPrivatePayload {
  t: "load-private";
  chainId: number;
  escrow: Hex;
  params: DepositParams;
  depositAddress: Hex;
}

/** A RAILGUN ShieldRequest, as the phone signs over it (HANDOFF §8). */
export interface ShieldRequest {
  npk: Hex;
  tokenType: number;
  tokenAddress: Hex;
  tokenSubID: bigint;
  value: bigint;
  encryptedBundle: [Hex, Hex, Hex];
  shieldKey: Hex;
}
export interface RedeemShieldPayload extends Omit<RedeemPayload, "t"> {
  t: "redeem-shield";
  shield: ShieldRequest;
}
/** Move a note's value into a NEW coin with a new expiry; no ETH moves (HANDOFF §12). */
export interface RefreshPayload extends Omit<RedeemPayload, "t"> {
  t: "refresh";
  refresh: { newCoinId: Hex; newExpiry: bigint; newK0x: bigint; newK0y: bigint };
}
export type OfflinePayload = LoadPayload | RedeemPayload | LoadPrivatePayload | RedeemShieldPayload | RefreshPayload;

/** A phone's "shield-ask": the note value it wants a shield target for (HANDOFF §11). */
export class ShieldAsk extends Error {
  override name = "ShieldAsk";
  constructor(
    readonly valueWei: bigint,
    readonly escrow: Hex,
    /** 16 random bytes as 32 lowercase hex chars, new for each ask; the target must echo it. */
    readonly nonce?: string,
  ) {
    super("a shield request from the phone");
  }
}

export class PayloadError extends Error {
  override name = "PayloadError";
}

type Json = Record<string, unknown>;
const obj = (v: unknown, what: string): Json => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new PayloadError(`${what}: not an object`);
  return v as Json;
};
const b32 = (v: unknown, what: string): Hex => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new PayloadError(`${what}: not 32 bytes of hex`);
  return v.toLowerCase() as Hex;
};
const addr = (v: unknown, what: string): Hex => {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new PayloadError(`${what}: not an address`);
  return getAddress(v);
};
const wei = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" || !/^\d{1,78}$/.test(v)) throw new PayloadError(`${what}: not a decimal amount`);
  return BigInt(v);
};
const uint = (v: unknown, what: string): bigint => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d{1,20}$/.test(v)) return BigInt(v);
  throw new PayloadError(`${what}: not a whole number`);
};
const word = (v: unknown, what: string): bigint => BigInt(b32(v, what));
const list = <T>(v: unknown, what: string, item: (x: unknown, w: string) => T, min = 1): T[] => {
  if (!Array.isArray(v) || v.length < min || v.length > 64) throw new PayloadError(`${what}: not a list`);
  return v.map((x, i) => item(x, `${what}[${i}]`));
};
const output = (v: unknown, w: string): Output => {
  const o = obj(v, w);
  return { value: wei(o.value, `${w}.value`), keyHash: b32(o.keyHash, `${w}.keyHash`) };
};

function shieldRequest(v: unknown, w: string): ShieldRequest {
  const o = obj(v, w);
  const bundle = o.encryptedBundle;
  if (!Array.isArray(bundle) || bundle.length !== 3) throw new PayloadError(`${w}.encryptedBundle: not three words`);
  return {
    npk: b32(o.npk, `${w}.npk`),
    tokenType: Number(uint(o.tokenType, `${w}.tokenType`)),
    tokenAddress: addr(o.tokenAddress, `${w}.tokenAddress`),
    tokenSubID: uint(o.tokenSubID, `${w}.tokenSubID`),
    value: wei(o.value, `${w}.value`),
    encryptedBundle: [b32(bundle[0], `${w}.encryptedBundle[0]`), b32(bundle[1], `${w}.encryptedBundle[1]`), b32(bundle[2], `${w}.encryptedBundle[2]`)],
    shieldKey: b32(o.shieldKey, `${w}.shieldKey`),
  };
}

/** The wire form of a ShieldRequest: hex words, decimal strings for tokenType, tokenSubID and value. */
export function shieldRequestWire(r: ShieldRequest): Record<string, unknown> {
  return {
    npk: r.npk,
    tokenType: r.tokenType,
    tokenAddress: r.tokenAddress,
    tokenSubID: r.tokenSubID.toString(),
    value: r.value.toString(),
    encryptedBundle: [...r.encryptedBundle],
    shieldKey: r.shieldKey,
  };
}

/** base64url (no padding) → UTF-8 JSON. */
export function decodeD(d: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(d) || d.length > 8000) throw new PayloadError("not a base64url payload");
  const b64 = d.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((d.length + 3) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PayloadError("payload is not JSON");
  }
}

export function encodeD(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Validate a decoded payload. Unknown fields are ignored; an unknown version or type is refused. */
export function parsePayload(raw: unknown): OfflinePayload {
  const p = obj(raw, "payload");
  if (p.v !== 1) throw new PayloadError(`unsupported payload version ${String(p.v)}`);
  const chainId = Number(p.chainId);
  const escrow = addr(p.escrow, "escrow");
  if (p.t === "load-private") {
    const q = obj(p.params, "params");
    return {
      t: "load-private",
      chainId,
      escrow,
      params: {
        coinId: b32(q.coinId, "params.coinId"),
        expiry: uint(q.expiry, "params.expiry"),
        k0x: word(q.k0x, "params.k0x"),
        k0y: word(q.k0y, "params.k0y"),
        depositor: addr(q.depositor, "params.depositor"),
        minValue: wei(q.minValue, "params.minValue"),
        maxValue: wei(q.maxValue, "params.maxValue"),
        tip: wei(q.tip, "params.tip"),
      },
      depositAddress: addr(p.depositAddress, "depositAddress"),
    };
  }
  if (p.t === "load") {
    return {
      t: "load",
      chainId,
      escrow,
      coinId: b32(p.coinId, "coinId"),
      value: wei(p.value, "value"),
      expiry: uint(p.expiry, "expiry"),
      k0x: word(p.k0x, "k0x"),
      k0y: word(p.k0y, "k0y"),
      depositor: addr(p.depositor, "depositor"),
    };
  }
  if (p.t === "redeem" || p.t === "redeem-shield" || p.t === "refresh") {
    const h = obj(p.header, "header");
    const r = obj(p.redemption, "redemption");
    const base = checkIndexes({
      t: "redeem",
      chainId,
      escrow,
      header: {
        coinId: b32(h.coinId, "header.coinId"),
        value: wei(h.value, "header.value"),
        expiry: uint(h.expiry, "header.expiry"),
        k0x: word(h.k0x, "header.k0x"),
        k0y: word(h.k0y, "header.k0y"),
        depositor: addr(h.depositor, "header.depositor"),
      },
      // An empty path redeems the genesis note directly.
      path: list(
        p.path,
        "path",
        (x, w) => {
          const s = obj(x, w);
          return {
            outputs: list(s.outputs, `${w}.outputs`, output),
            index: uint(s.index, `${w}.index`),
            r: b32(s.r, `${w}.r`),
            s: b32(s.s, `${w}.s`),
            nextX: b32(s.nextX, `${w}.nextX`),
            nextY: b32(s.nextY, `${w}.nextY`),
          };
        },
        0,
      ),
      redemption: {
        outputs: list(r.outputs, "redemption.outputs", output),
        index: uint(r.index, "redemption.index"),
        payout: addr(r.payout, "redemption.payout"),
        r: b32(r.r, "redemption.r"),
        s: b32(r.s, "redemption.s"),
      },
    });
    if (p.t === "redeem") return base;
    if (p.t === "refresh") {
      const f = obj(p.refresh, "refresh");
      return {
        ...base,
        t: "refresh",
        refresh: { newCoinId: b32(f.newCoinId, "refresh.newCoinId"), newExpiry: uint(f.newExpiry, "refresh.newExpiry"), newK0x: word(f.newK0x, "refresh.newK0x"), newK0y: word(f.newK0y, "refresh.newK0y") },
      };
    }
    return { ...base, t: "redeem-shield", shield: shieldRequest(p.shield, "shield") };
  }
  throw new PayloadError(`unknown payload type ${String(p.t)}`);
}

/** Each spend and the redemption must point at one of their own outputs. */
function checkIndexes(p: RedeemPayload): RedeemPayload {
  p.path.forEach((s, i) => {
    if (s.index >= BigInt(s.outputs.length)) throw new PayloadError(`path[${i}].index points past its outputs`);
  });
  if (p.redemption.index >= BigInt(p.redemption.outputs.length)) throw new PayloadError("redemption.index points past its outputs");
  return p;
}

/**
 * Find a handoff in a scanned QR text, a pasted link or a location hash:
 * `…#/offline/<kind>?d=…`, `prawl://offline/<kind>?d=…`, or a bare `d`.
 * The kind in the link must match the payload's own type.
 */
export function payloadFromText(text: string): OfflinePayload {
  const t = text.trim();
  const m = /(?:#\/|prawl:\/\/)offline\/(load-private|load|redeem-shield|redeem|refresh|shield-target|shield-ask)\?(?:.*&)?d=([A-Za-z0-9_-]+)/.exec(t);
  const kind = m?.[1];
  const d = m?.[2] ?? (/^[A-Za-z0-9_-]{40,}$/.test(t) ? t : undefined);
  if (!d) throw new PayloadError("no offline-cash payload in this text");
  if (kind === "shield-target") throw new PayloadError("that is a request for the phone (a shield target), not something to open here");
  if (kind === "shield-ask") {
    const a = obj(decodeD(d), "shield-ask");
    if (a.v !== 1 || a.t !== "shield-ask") throw new PayloadError("not a shield request from the phone");
    const escrow = addr(a.escrow, "escrow");
    if (!RAILGUN_ESCROWS.some((e) => sameAddr(e, escrow))) throw new PayloadError(`the phone asked for a target on escrow ${escrow}, which cannot cash out into RAILGUN here`);
    if (a.chainId !== undefined && Number(a.chainId) !== OFFLINE_CHAIN_ID) throw new PayloadError(`the phone's request is for chain ${String(a.chainId)}, not Sepolia`);
    if (a.nonce !== undefined && !(typeof a.nonce === "string" && /^[0-9a-f]{32}$/.test(a.nonce))) throw new PayloadError("the phone's nonce is not 32 lowercase hex characters");
    throw new ShieldAsk(wei(a.value, "value"), escrow, a.nonce as string | undefined);
  }
  const p = parsePayload(decodeD(d));
  if (kind && kind !== p.t) throw new PayloadError(`link says ${kind} but the payload is a ${p.t}`);
  return p;
}

/** Problems that make a payload unusable here, before any chain call. */
export function configProblems(p: OfflinePayload): string[] {
  const out: string[] = [];
  if (p.chainId !== OFFLINE_CHAIN_ID) out.push(`it is for chain ${p.chainId}, this wallet uses Sepolia (${OFFLINE_CHAIN_ID})`);
  if (!KNOWN_ESCROWS.some((e) => sameAddr(e, p.escrow))) out.push(`it names escrow ${p.escrow}, which is not one of Prowl's (${KNOWN_ESCROWS.join(", ")})`);
  else if ((p.t === "load-private" || p.t === "redeem-shield" || p.t === "refresh") && !RAILGUN_ESCROWS.some((e) => sameAddr(e, p.escrow))) {
    out.push(`${p.t} needs escrow v3.1 or newer (${RAILGUN_ESCROWS.join(" or ")}); this names ${p.escrow}`);
  }
  return out;
}

/** The amount a redemption pays out: the redeemed output's value. */
export function payoutValue(p: RedeemPayload | RedeemShieldPayload | RefreshPayload): bigint {
  const o = p.redemption.outputs[Number(p.redemption.index)];
  if (!o) throw new PayloadError("redemption index points past its outputs");
  return o.value;
}

/** EIP-681 link the phone scans to learn the depositor account. */
export function depositorUri(address: string, chainId = OFFLINE_CHAIN_ID): string {
  return `ethereum:${getAddress(address)}@${chainId}`;
}


/**
 * Website → phone: the target a cash-out into a private balance must name
 * (HANDOFF §6). The phone signs over sha256(abi.encode(request)).
 */
export function shieldTargetLink(escrow: Hex, request: ShieldRequest, nonce?: string, chainId = OFFLINE_CHAIN_ID): string {
  // `nonce` is the phone's, echoed unchanged: without it the phone shows the target as "not bound to a request".
  return `prawl://offline/shield-target?d=${encodeD({ v: 1, t: "shield-target", chainId, escrow, ...(nonce ? { nonce } : {}), request: shieldRequestWire(request) })}`;
}
