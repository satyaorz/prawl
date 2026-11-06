/**
 * The RAILGUN ShieldRequest for "cash out into my private balance". kohaku
 * builds the shield call (RailgunSmartWallet.shield with one request); this
 * decodes its calldata into the 9 fields the phone signs over (HANDOFF §8).
 */
import type { Call } from "@prawl/railgun";
import { decodeFunctionData, encodeAbiParameters, parseAbi, toFunctionSelector, type Hex } from "viem";
import type { ShieldRequest } from "./payload";

export const RAILGUN_SHIELD_ABI = parseAbi([
  "struct TokenData { uint8 tokenType; address tokenAddress; uint256 tokenSubID; }",
  "struct CommitmentPreimage { bytes32 npk; TokenData token; uint120 value; }",
  "struct ShieldCiphertext { bytes32[3] encryptedBundle; bytes32 shieldKey; }",
  "struct RailgunShieldRequest { CommitmentPreimage preimage; ShieldCiphertext ciphertext; }",
  "function shield(RailgunShieldRequest[] _shieldRequests)",
]);

/** Selector of RailgunSmartWallet.shield(ShieldRequest[]). */
export const SHIELD_SELECTOR = toFunctionSelector("shield(((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32))[])");

/** The single ShieldRequest in kohaku's shield call. Refuses anything else (another target, several requests, another function). */
export function shieldRequestFromCall(call: Call, smartWallet: Hex): ShieldRequest {
  if (call.to.toLowerCase() !== smartWallet.toLowerCase()) throw new Error("the shield call does not target the RAILGUN smart wallet");
  if (call.value !== 0n) throw new Error("an ERC-20 shield call must not carry ETH");
  if (!call.data.toLowerCase().startsWith(SHIELD_SELECTOR)) throw new Error("not a RAILGUN shield call");
  const { args } = decodeFunctionData({ abi: RAILGUN_SHIELD_ABI, data: call.data });
  const [requests] = args as [readonly { preimage: { npk: Hex; token: { tokenType: number; tokenAddress: Hex; tokenSubID: bigint }; value: bigint }; ciphertext: { encryptedBundle: readonly [Hex, Hex, Hex]; shieldKey: Hex } }[]];
  if (requests.length !== 1) throw new Error(`expected one shield request, got ${requests.length}`);
  const r = requests[0]!;
  return {
    npk: r.preimage.npk,
    tokenType: r.preimage.token.tokenType,
    tokenAddress: r.preimage.token.tokenAddress,
    tokenSubID: r.preimage.token.tokenSubID,
    value: r.preimage.value,
    encryptedBundle: [r.ciphertext.encryptedBundle[0], r.ciphertext.encryptedBundle[1], r.ciphertext.encryptedBundle[2]],
    shieldKey: r.ciphertext.shieldKey,
  };
}

/** abi.encode(request): 9 static words, 288 bytes (what the phone hashes with sha256). */
export function encodeShieldRequest(r: ShieldRequest): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { type: "tuple", components: [{ type: "bytes32" }, { type: "tuple", components: [{ type: "uint8" }, { type: "address" }, { type: "uint256" }] }, { type: "uint120" }] },
          { type: "tuple", components: [{ type: "bytes32[3]" }, { type: "bytes32" }] },
        ],
      },
    ],
    [[[r.npk, [r.tokenType, r.tokenAddress, r.tokenSubID], r.value], [r.encryptedBundle, r.shieldKey]]],
  );
}

/** sha256 of the encoding, lowercase hex without 0x: the "shieldHash" of HANDOFF §8. */
export async function shieldHash(r: ShieldRequest): Promise<string> {
  const bytes = Uint8Array.from(Buffer.from(encodeShieldRequest(r).slice(2), "hex"));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
