import type { KmsUserDecryptEIP712Type } from "@zama-fhe/relayer-sdk/web";
import { isHex, type Address } from "viem";

const VERIFIER = "0x5d8bd78e2ea6bbe41f26dfe9fdaeaA349e077478".toLowerCase();
const TYPES = {
  UserDecryptRequestVerification: [
    { name: "publicKey", type: "bytes" },
    { name: "contractAddresses", type: "address[]" },
    { name: "startTimestamp", type: "uint256" },
    { name: "durationDays", type: "uint256" },
    { name: "extraData", type: "bytes" },
  ],
} as const;

/** Reconstruct the exact allowed signature; do not sign arbitrary SDK data. */
export function validateDecryptAuthorization(request: KmsUserDecryptEIP712Type, contracts: readonly Address[], now = Math.floor(Date.now() / 1000)) {
  const { domain, message } = request;
  if (request.primaryType !== "UserDecryptRequestVerification" || domain.name !== "Decryption" || domain.version !== "1" ||
      domain.chainId !== 10901n || domain.verifyingContract.toLowerCase() !== VERIFIER) throw new Error("Unexpected FHE authorization domain");
  if (contracts.length !== 3 || message.contractAddresses.length !== contracts.length ||
      message.contractAddresses.some((contract, index) => contract.toLowerCase() !== contracts[index]?.toLowerCase())) throw new Error("Unexpected FHE authorization contracts");
  if (!isHex(message.publicKey) || message.publicKey.length < 66 || message.publicKey.length > 8194 || message.extraData !== "0x00") throw new Error("Invalid FHE authorization key");
  let start: bigint, duration: bigint;
  try { start = BigInt(message.startTimestamp); duration = BigInt(message.durationDays); }
  catch { throw new Error("Invalid FHE authorization lifetime"); }
  if (duration !== 1n || start < BigInt(now - 300) || start > BigInt(now + 300)) throw new Error("Invalid FHE authorization lifetime");
  return {
    domain: { name: "Decryption", version: "1", chainId: 10901, verifyingContract: domain.verifyingContract },
    primaryType: "UserDecryptRequestVerification" as const,
    types: TYPES,
    message: { publicKey: message.publicKey, contractAddresses: [...contracts], startTimestamp: start, durationDays: duration, extraData: message.extraData as `0x${string}` },
  };
}
