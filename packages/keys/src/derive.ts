/**
 * Key derivation. One 32-byte root secret per wallet (from a passkey's PRF
 * output, see passkey.ts) is expanded with HKDF-SHA256 into independent keys,
 * each bound to its purpose by a distinct `info` label. Knowing one derived key
 * reveals nothing about the root or the others.
 *
 * Derived keys are returned as bytes/hex only to hand straight to the code that
 * uses them (the RAILGUN wasm, the EVM signer). Never log, persist or send them.
 */
import { bytesToHex, hexToBigInt, hexToBytes, type Hex } from "viem";

const SALT = new TextEncoder().encode("prawl/v1");
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export const LABELS = {
  railgunSpending: "prawl/v1/railgun/spending",
  railgunViewing: "prawl/v1/railgun/viewing",
  evmAccount: "prawl/v1/evm/account",
  /** Root of the per-coin reclaim accounts (see deriveReclaimKey). A separate label: it changes no other key. */
  reclaimSeed: "prawl/v1/evm/reclaim-seed",
  storage: "prawl/v1/storage/aes-gcm",
} as const;

export interface WalletKeys {
  /** RAILGUN spending key (32 bytes, 0x-hex). */
  railgunSpending: Hex;
  /** RAILGUN viewing key (32 bytes, 0x-hex). */
  railgunViewing: Hex;
  /** secp256k1 private key of the wallet's EVM account (signs UserOperations). */
  evmAccount: Hex;
  /** Non-extractable AES-GCM key for the local vault. */
  storage: CryptoKey;
  /** 32-byte seed of the fresh reclaim accounts (one per offline coin): see {@link deriveReclaimKey}. */
  reclaimSeed: Hex;
}

async function hkdfBits(root: CryptoKey, info: string, bits = 256): Promise<Uint8Array> {
  const out = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: new TextEncoder().encode(info) },
    root,
    bits,
  );
  return new Uint8Array(out);
}

async function importRoot(root: Uint8Array): Promise<CryptoKey> {
  if (root.byteLength !== 32) throw new Error("root secret must be 32 bytes");
  return crypto.subtle.importKey("raw", root as BufferSource, "HKDF", false, ["deriveBits", "deriveKey"]);
}

/** A valid secp256k1 scalar (1..n-1): re-derive with a counter until in range. */
async function evmKey(root: CryptoKey): Promise<Hex> {
  for (let i = 0; i < 256; i++) {
    const label = i === 0 ? LABELS.evmAccount : `${LABELS.evmAccount}/${i}`;
    const hex = bytesToHex(await hkdfBits(root, label));
    const k = hexToBigInt(hex);
    if (k > 0n && k < SECP256K1_N) return hex;
  }
  throw new Error("could not derive an EVM key");
}

export async function deriveWalletKeys(rootSecret: Uint8Array): Promise<WalletKeys> {
  const root = await importRoot(rootSecret);
  const [railgunSpending, railgunViewing, evmAccount, storage, reclaimSeed] = await Promise.all([
    hkdfBits(root, LABELS.railgunSpending).then(bytesToHex),
    hkdfBits(root, LABELS.railgunViewing).then(bytesToHex),
    evmKey(root),
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: SALT, info: new TextEncoder().encode(LABELS.storage) },
      root,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
    hkdfBits(root, LABELS.reclaimSeed).then(bytesToHex),
  ]);
  return { railgunSpending, railgunViewing, evmAccount, storage, reclaimSeed };
}

/**
 * The secp256k1 key of reclaim account number `index`: a fresh address for each offline coin, derived from the wallet's passkey so a restore
 * on another device finds them again. Independent of the main account key and of every other index. Hand it straight to the signer.
 */
export async function deriveReclaimKey(reclaimSeed: Hex, index: number): Promise<Hex> {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("reclaim index must be a non-negative integer");
  const seed = await importRoot(hexToBytes(reclaimSeed));
  for (let i = 0; i < 256; i++) {
    const label = `prawl/v1/evm/reclaim/${index}` + (i === 0 ? "" : `/${i}`);
    const hex = bytesToHex(await hkdfBits(seed, label));
    const k = hexToBigInt(hex);
    if (k > 0n && k < SECP256K1_N) return hex;
  }
  throw new Error("could not derive a reclaim key");
}
