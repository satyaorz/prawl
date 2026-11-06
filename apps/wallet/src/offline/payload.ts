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
export type OfflinePayload = LoadPayload | RedeemPayload;

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
  if (p.t === "redeem") {
    const h = obj(p.header, "header");
    const r = obj(p.redemption, "redemption");
    return checkIndexes({
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
  const m = /(?:#\/|prawl:\/\/)offline\/(load|redeem)\?(?:.*&)?d=([A-Za-z0-9_-]+)/.exec(t);
  const kind = m?.[1];
  const d = m?.[2] ?? (/^[A-Za-z0-9_-]{40,}$/.test(t) ? t : undefined);
  if (!d) throw new PayloadError("no offline-cash payload in this text");
  const p = parsePayload(decodeD(d));
  if (kind && kind !== p.t) throw new PayloadError(`link says ${kind} but the payload is a ${p.t}`);
  return p;
}

/** Problems that make a payload unusable here, before any chain call. */
export function configProblems(p: OfflinePayload): string[] {
  const out: string[] = [];
  if (p.chainId !== OFFLINE_CHAIN_ID) out.push(`it is for chain ${p.chainId}, this wallet uses Sepolia (${OFFLINE_CHAIN_ID})`);
  if (p.escrow.toLowerCase() !== ESCROW_V3.toLowerCase()) out.push(`it names escrow ${p.escrow}, not Prawl's ${ESCROW_V3}`);
  return out;
}

/** The amount a redemption pays out: the redeemed output's value. */
export function payoutValue(p: RedeemPayload): bigint {
  const o = p.redemption.outputs[Number(p.redemption.index)];
  if (!o) throw new PayloadError("redemption index points past its outputs");
  return o.value;
}

/** EIP-681 link the phone scans to learn the depositor account. */
export function depositorUri(address: string, chainId = OFFLINE_CHAIN_ID): string {
  return `ethereum:${getAddress(address)}@${chainId}`;
}
