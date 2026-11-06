/**
 * Identity handles. Every request names exactly one identity, and the
 * isolation key is derived from that identity, never from the flow that
 * happens to be running. Two flows about the same address share a circuit;
 * two addresses never do.
 *
 * Handles can only be minted by an IdentityRegistry, and a client accepts
 * only handles from its own registry, so a caller cannot forge a key string
 * or pass a list of identities.
 */
import { AnonRpcError } from "./errors";

export type IdentityKind = "account" | "stealth" | "tx" | "public" | "ephemeral";

const ISSUED = Symbol("anon-rpc.identity");

export interface Identity {
  readonly kind: IdentityKind;
  /** Stable base key, e.g. `acct:0xabc…`. The circuit key adds provider and generation. */
  readonly key: string;
  /** Short label for traces. Never the full address. */
  readonly label: string;
  /**
   * Lower-case hex without 0x (40 chars for an address, 64 for a tx hash), or
   * undefined for public and ephemeral scopes. Used by the cross-identity guard.
   */
  readonly subject: string | undefined;
  readonly [ISSUED]: true;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0+$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const SCOPE_NAME = /^[a-z0-9][a-z0-9:._-]{0,63}$/;

function short(hex: string): string {
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

export class IdentityRegistry {
  readonly #byKey = new Map<string, Identity>();
  readonly #issued = new WeakSet<Identity>();
  readonly #random: () => number;
  #ephemeralCounter = 0;

  constructor(random: () => number = Math.random) {
    this.#random = random;
  }

  /** The user's own account address. */
  account(address: string): Identity {
    if (!ADDRESS.test(address)) throw new AnonRpcError(`not an address: ${address}`, "POLICY");
    // 40 zeros occur in any ABI padding, so the zero address cannot be guarded; it is nobody's account.
    if (ZERO.test(address)) throw new AnonRpcError("the zero address is not an identity", "POLICY");
    const lower = address.toLowerCase();
    return this.#intern("account", `acct:${lower}`, `acct:${short(lower)}`, lower.slice(2));
  }

  /** A one-time stealth address. Each one is its own identity. */
  stealth(address: string): Identity {
    if (!ADDRESS.test(address) || ZERO.test(address)) throw new AnonRpcError(`not a stealth address: ${address}`, "POLICY");
    const lower = address.toLowerCase();
    return this.#intern("stealth", `stealth:${lower}`, `stealth:${short(lower)}`, lower.slice(2));
  }

  /** Waiting on or reading one transaction (`tx-wait:<hash>` in the notes). */
  tx(hash: string): Identity {
    if (!HASH.test(hash)) throw new AnonRpcError(`not a tx hash: ${hash}`, "POLICY");
    const lower = hash.toLowerCase();
    return this.#intern("tx", `tx:${lower}`, `tx:${short(lower)}`, lower.slice(2));
  }

  /**
   * A named scope for public data that names no user (head tracking, the
   * announcer scan, RAILGUN commitments). The name may not contain an address
   * or hash, so a public scope cannot be used to smuggle an identity in.
   */
  publicScope(name: string): Identity {
    if (!SCOPE_NAME.test(name) || /[0-9a-f]{40}/i.test(name)) {
      throw new AnonRpcError(`invalid public scope name: ${name}`, "POLICY");
    }
    return this.#intern("public", `public:${name}`, `public:${name}`, undefined);
  }

  /**
   * A throwaway identity used once (pre-warm, proof submission, bundler
   * calls). Never interned, so it can never be reused by accident.
   */
  ephemeral(purpose: string): Identity {
    if (!SCOPE_NAME.test(purpose)) throw new AnonRpcError(`invalid purpose: ${purpose}`, "POLICY");
    const nonce = `${(++this.#ephemeralCounter).toString(36)}.${Math.floor(this.#random() * 2 ** 48).toString(36)}`;
    const id = this.#make("ephemeral", `eph:${purpose}:${nonce}`, `eph:${purpose}`, undefined);
    return id;
  }

  isIssued(value: unknown): value is Identity {
    return typeof value === "object" && value !== null && this.#issued.has(value as Identity);
  }

  /**
   * Throws CROSS_IDENTITY if `text` (a URL or a request body) names the
   * subject of any other registered identity. Defence in depth: the API
   * already takes one identity per request, this also catches an address
   * that was pasted into params or calldata by mistake.
   */
  assertOnlySubject(identity: Identity, text: string): void {
    if (!text) return;
    const lower = text.toLowerCase();
    for (const other of this.#byKey.values()) {
      if (other === identity || other.subject === undefined) continue;
      if (other.subject === identity.subject) continue;
      if (lower.includes(other.subject)) {
        throw new AnonRpcError(
          `request for ${identity.label} also names ${other.label}; one identity per request`,
          "CROSS_IDENTITY",
        );
      }
    }
  }

  #intern(kind: IdentityKind, key: string, label: string, subject: string | undefined): Identity {
    const existing = this.#byKey.get(key);
    if (existing) return existing;
    const id = this.#make(kind, key, label, subject);
    this.#byKey.set(key, id);
    return id;
  }

  #make(kind: IdentityKind, key: string, label: string, subject: string | undefined): Identity {
    const id = Object.freeze({ kind, key, label, subject, [ISSUED]: true as const });
    this.#issued.add(id);
    return id;
  }
}
