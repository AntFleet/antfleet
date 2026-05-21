import { describe, expect, it } from "vitest";
import { compareUsdcStrings, formatUsdcUnits, parseUsdcUnits } from "./deposit-verifier";

describe("USDC fixed-point helpers", () => {
  it("formats whole-unit values", () => {
    expect(formatUsdcUnits(5_000_000n)).toBe("5.000000");
  });

  it("formats sub-unit values", () => {
    expect(formatUsdcUnits(1n)).toBe("0.000001");
  });

  it("formats zero", () => {
    expect(formatUsdcUnits(0n)).toBe("0.000000");
  });

  it("parses whole and fractional strings symmetrically", () => {
    for (const raw of [0n, 1n, 5_000_000n, 12_345_678_901_234n]) {
      expect(parseUsdcUnits(formatUsdcUnits(raw))).toBe(raw);
    }
  });

  it("compares fixed-point strings correctly", () => {
    expect(compareUsdcStrings("5.00", "5.000000")).toBe(0);
    expect(compareUsdcStrings("4.999999", "5.00")).toBeLessThan(0);
    expect(compareUsdcStrings("5.000001", "5.00")).toBeGreaterThan(0);
  });

  it("rejects malformed amounts", () => {
    expect(() => parseUsdcUnits("not-a-number")).toThrow();
    expect(() => parseUsdcUnits("5.0.0")).toThrow();
  });
});
