import { describe, expect, it } from "vitest";
import { fmtEthShort } from "../src/components/ui";

const eth = (s: string): bigint => {
  const [w = "0", f = ""] = s.split(".");
  return BigInt(w) * 10n ** 18n + BigInt(f.padEnd(18, "0"));
};

describe("fmtEthShort", () => {
  it("shortens a long balance so it fits a phone screen", () => {
    expect(fmtEthShort(eth("0.026119725342245019"))).toBe("0.026119");
    expect(fmtEthShort(eth("0.61599999994152897"))).toBe("0.615999");
  });
  it("truncates and never rounds up (it must not promise more than there is)", () => {
    expect(fmtEthShort(eth("0.0000019999"))).toBe("0.000001");
    expect(fmtEthShort(eth("1.9999999"))).toBe("1.999999");
  });
  it("drops trailing zeros and shows whole numbers plainly", () => {
    expect(fmtEthShort(eth("0.5"))).toBe("0.5");
    expect(fmtEthShort(eth("2"))).toBe("2");
    expect(fmtEthShort(0n)).toBe("0");
    expect(fmtEthShort(eth("12.340000"))).toBe("12.34");
  });
  it("marks dust instead of showing 0", () => {
    expect(fmtEthShort(1n)).toBe("<0.000001");
    expect(fmtEthShort(999_999_999_999n)).toBe("<0.000001");
  });
});
