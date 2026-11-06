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
    return { root, credentialId: b64url(cred.rawId) };
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
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: RP_NAME, id: location.hostname },
        // Random user handle: the passkey carries no name, email or address.
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: label, displayName: label },
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
  if (root?.byteLength === 32) return { root, credentialId };
  return unlockWithPasskey(credentialId);
}
