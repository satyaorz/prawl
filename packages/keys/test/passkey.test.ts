import { describe, expect, it } from "vitest";
import { decodeUserHandle, encodeUserHandle } from "../src";

const T = 1_794_000_000; // 2026-11

describe("passkey user handle", () => {
  it("round-trips the creation time", () => {
    const h = encodeUserHandle(T, new Uint8Array(16).fill(9));
    expect(h.byteLength).toBe(25);
    expect(h[0]).toBe(1);
    expect(decodeUserHandle(h)).toBe(T);
    expect(decodeUserHandle(h.buffer as ArrayBuffer)).toBe(T);
  });

  it("uses fresh random bytes by default", () => {
    const a = encodeUserHandle(T);
    const b = encodeUserHandle(T);
    expect(a.slice(9)).not.toEqual(b.slice(9));
  });

  it("ignores old 16-byte random handles, foreign handles and implausible times", () => {
    expect(decodeUserHandle(new Uint8Array(16))).toBeUndefined();
    expect(decodeUserHandle(null)).toBeUndefined();
    const v2 = encodeUserHandle(T);
    v2[0] = 2;
    expect(decodeUserHandle(v2)).toBeUndefined();
    expect(decodeUserHandle(encodeUserHandle(1_000))).toBeUndefined();
    expect(decodeUserHandle(encodeUserHandle(Math.floor(Date.now() / 1000) + 10 * 86_400))).toBeUndefined();
  });
});
