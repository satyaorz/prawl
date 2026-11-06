import { describe, expect, it } from "vitest";
import type { KmsUserDecryptEIP712Type } from "@zama-fhe/relayer-sdk/web";
import { validateDecryptAuthorization } from "../src/swap/fhe-authorization";

const NOW = 1_793_989_733;
const contracts = [
  "0x7D18B237fd0555C5f046EA9bbb1cBCf7b175C741",
  "0x2B4f777Eda45293AAAb1ac9beAE250A4dCC1cfcc",
  "0x7C091e777CA1acA96446e8D8751878c2E7765Ddf",
] as const;

/** The exact shape the real relayer SDK (0.4.0) returns from createEIP712 on Sepolia, captured from a live instance. */
const real = (): KmsUserDecryptEIP712Type => ({
  primaryType: "UserDecryptRequestVerification",
  types: {} as never,
  domain: { name: "Decryption", version: "1", chainId: 11155111n, verifyingContract: "0x5D8BD78e2ea6bbE41f26dFe9fdaEAa349e077478" },
  message: { publicKey: `0x${"03".repeat(40)}`, contractAddresses: [...contracts], startTimestamp: String(NOW), durationDays: "1", extraData: "0x00" },
} as unknown as KmsUserDecryptEIP712Type);

describe("validateDecryptAuthorization", () => {
  it("accepts what the real SDK produces and signs it with the same domain", () => {
    const typed = validateDecryptAuthorization(real(), contracts, NOW);
    expect(typed.domain).toEqual({ name: "Decryption", version: "1", chainId: 11155111, verifyingContract: "0x5D8BD78e2ea6bbE41f26dFe9fdaEAa349e077478" });
    expect(typed.message.contractAddresses).toEqual([...contracts]);
    expect(typed.message.durationDays).toBe(1n);
  });

  it("refuses a different domain, verifier, or chain", () => {
    for (const patch of [{ name: "Other" }, { version: "2" }, { chainId: 10901n }, { chainId: 1n }, { verifyingContract: "0x0000000000000000000000000000000000000001" }]) {
      const request = real();
      Object.assign(request.domain, patch);
      expect(() => validateDecryptAuthorization(request, contracts, NOW), JSON.stringify(patch, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))).toThrow("Unexpected FHE authorization domain");
    }
  });

  it("refuses other contracts, a long lifetime, and a stale or future start", () => {
    const other = real();
    (other.message as { contractAddresses: readonly string[] }).contractAddresses = [contracts[0], contracts[1], "0x0000000000000000000000000000000000000002"];
    expect(() => validateDecryptAuthorization(other, contracts, NOW)).toThrow("contracts");
    const long = real();
    (long.message as { durationDays: string }).durationDays = "30";
    expect(() => validateDecryptAuthorization(long, contracts, NOW)).toThrow("lifetime");
    expect(() => validateDecryptAuthorization(real(), contracts, NOW + 1000)).toThrow("lifetime");
    expect(() => validateDecryptAuthorization(real(), contracts, NOW - 1000)).toThrow("lifetime");
  });
});
