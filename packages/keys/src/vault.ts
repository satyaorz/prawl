/**
 * Encrypted records for local storage. Everything the wallet persists that is
 * private (RAILGUN checkpoint, notes, contacts) goes through seal()/open(),
 * keyed by the wallet's storage key, with the record name bound as AAD so a
 * sealed blob cannot be swapped for another record.
 */
const VERSION = 1;

export interface Sealed {
  v: number;
  /** base64 12-byte IV */
  iv: string;
  /** base64 AES-GCM ciphertext + tag */
  ct: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function aad(name: string): Uint8Array {
  return enc.encode(`prawl/v${VERSION}/vault/${name}`);
}

export async function seal(key: CryptoKey, name: string, plaintext: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad(name) as BufferSource },
    key,
    enc.encode(plaintext) as BufferSource,
  );
  return { v: VERSION, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

export async function open(key: CryptoKey, name: string, sealed: Sealed): Promise<string> {
  if (sealed.v !== VERSION) throw new Error(`unsupported vault version ${sealed.v}`);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(sealed.iv) as BufferSource, additionalData: aad(name) as BufferSource },
    key,
    unb64(sealed.ct) as BufferSource,
  );
  return dec.decode(pt);
}
