/**
 * Passkey-backed root secret (browser only). The wallet's root is the output
 * of the WebAuthn PRF extension for a fixed salt: the authenticator computes
 * HMAC(credential secret, salt) and never reveals the credential secret, so
 * there is no seed phrase and nothing to store. The same synced passkey
 * (iCloud Keychain, Google Password Manager, a hardware key) on another device
 * gives the same root, and therefore the same wallet.
 *
 * Only the credential id is remembered locally, to skip the account picker; it
 * is not secret. Recovery on a new device calls unlock() without it.
 */
const RP_NAME = "Prawl";
const PRF_SALT_LABEL = "prawl/v1/root";

export class PasskeyError extends Error {
  constructor(
    message: string,
    readonly code: "UNSUPPORTED" | "NO_PRF" | "CANCELLED" | "FAILED",
  ) {
    super(message);
    this.name = "PasskeyError";
  }
}

export interface PasskeyRoot {
  /** 32-byte root secret. Pass to deriveWalletKeys() and drop the reference. */
  root: Uint8Array;
  credentialId: string;
  /**
   * When the wallet was created (unix seconds), read back from the passkey's
   * user handle; undefined for passkeys made before v1 handles. The wallet
   * cannot own notes from before this, so a restore may skip older history.
   */
  bornAt?: number;
}

/**
 * User handle v1: [0x01][creation time, u64 big-endian unix seconds][16 random bytes].
 * The authenticator stores it with the passkey and returns it on every
 * sign-in, also on a synced device. It holds no name, email or address; the
 * passkey provider already knows when the passkey was made.
 */
const HANDLE_V1 = 0x01;
const HANDLE_V1_LEN = 25;

export function encodeUserHandle(bornAt: number, random: Uint8Array = crypto.getRandomValues(new Uint8Array(16))): Uint8Array {
  if (!Number.isSafeInteger(bornAt) || bornAt < 0) throw new Error("bornAt must be unix seconds");
  if (random.byteLength !== 16) throw new Error("need 16 random bytes");
  const h = new Uint8Array(HANDLE_V1_LEN);
  h[0] = HANDLE_V1;
  new DataView(h.buffer).setBigUint64(1, BigInt(bornAt));
  h.set(random, 9);
  return h;
}

/** Creation time from a v1 user handle, or undefined (older or foreign handle). */
export function decodeUserHandle(handle: ArrayBuffer | Uint8Array | null | undefined): number | undefined {
  if (!handle) return undefined;
  const h = handle instanceof Uint8Array ? handle : new Uint8Array(handle);
  if (h.byteLength !== HANDLE_V1_LEN || h[0] !== HANDLE_V1) return undefined;
  const t = new DataView(h.buffer, h.byteOffset, h.byteLength).getBigUint64(1);
  // Before 2026 or more than a day ahead of this clock: not a time we wrote.
  const n = Number(t);
  if (n < 1_767_225_600 || n > Date.now() / 1000 + 86_400) return undefined;
  return n;
}

async function prfSalt(): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PRF_SALT_LABEL)));
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function passkeysAvailable(): boolean {
  return typeof window !== "undefined" && "PublicKeyCredential" in window && !!navigator.credentials;
}

function wrap(e: unknown): PasskeyError {
  if (e instanceof PasskeyError) return e;
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "AbortError") return new PasskeyError("Passkey request was cancelled", "CANCELLED");
  return new PasskeyError(e instanceof Error ? e.message : String(e), "FAILED");
}

function prfFirst(cred: PublicKeyCredential): Uint8Array | undefined {
  const ext = cred.getClientExtensionResults() as { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };
  const first = ext.prf?.results?.first;
  return first ? new Uint8Array(first) : undefined;
}

/** Ask the authenticator for the PRF output of an existing passkey. */
export async function unlockWithPasskey(credentialId?: string): Promise<PasskeyRoot> {
  if (!passkeysAvailable()) throw new PasskeyError("Passkeys are not available in this browser", "UNSUPPORTED");
  const salt = await prfSalt();
  try {
    const cred = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: location.hostname,
        userVerification: "required",
        allowCredentials: credentialId ? [{ type: "public-key", id: unb64url(credentialId) as BufferSource }] : [],
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!cred) throw new PasskeyError("No passkey returned", "CANCELLED");
    const root = prfFirst(cred);
    if (!root || root.byteLength !== 32) {
      throw new PasskeyError("This passkey or browser does not support the PRF extension", "NO_PRF");
    }
    const bornAt = decodeUserHandle((cred.response as AuthenticatorAssertionResponse).userHandle);
    return { root, credentialId: b64url(cred.rawId), ...(bornAt !== undefined ? { bornAt } : {}) };
  } catch (e) {
    throw wrap(e);
  }
}

/**
 * Create a new discoverable passkey with PRF enabled, then read its PRF output.
 * Some authenticators return the PRF result at creation; others only on get(),
 * so this falls back to an immediate unlock.
 */
export async function createPasskey(label = "Prawl wallet"): Promise<PasskeyRoot> {
  if (!passkeysAvailable()) throw new PasskeyError("Passkeys are not available in this browser", "UNSUPPORTED");
  const salt = await prfSalt();
  const bornAt = Math.floor(Date.now() / 1000);
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: RP_NAME, id: location.hostname },
        // Creation time plus random bytes: the passkey carries no name, email or address.
        user: { id: encodeUserHandle(bornAt) as BufferSource, name: label, displayName: label },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw wrap(e);
  }
  if (!cred) throw new PasskeyError("No passkey created", "CANCELLED");
  const ext = cred.getClientExtensionResults() as { prf?: { enabled?: boolean } };
  if (ext.prf?.enabled === false) {
    throw new PasskeyError("This authenticator cannot derive keys (no PRF support)", "NO_PRF");
  }
  const credentialId = b64url(cred.rawId);
  const root = prfFirst(cred);
  if (root?.byteLength === 32) return { root, credentialId, bornAt };
  return { ...(await unlockWithPasskey(credentialId)), bornAt };
}
