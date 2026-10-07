import { describe, expect, it } from "vitest";
import { bpsDiff, fromAtomic, notionalUsd, toAtomic } from "../src/amounts.js";

describe("toAtomic", () => {
  it("converts human amounts with the token's decimals", () => {
    expect(toAtomic("1.5", 18, "x")).toBe(1_500_000_000_000_000_000n);
    expect(toAtomic("50", 6, "x")).toBe(50_000_000n);
    expect(toAtomic("0.000001", 6, "x")).toBe(1n);
  });
  it("rejects more precision than the token has", () => {
    expect(() => toAtomic("0.0000001", 6, "x")).toThrow(/decimal places/);
  });
  it("rejects zero, negatives, exponents and junk", () => {
    for (const bad of ["0", "0.0", "-1", "1e6", "abc", "", "1,000", "0x10"]) expect(() => toAtomic(bad, 18, "x"), bad).toThrow();
  });
});

describe("fromAtomic", () => {
  it("round-trips", () => {
    expect(fromAtomic(toAtomic("123.456", 8, "x"), 8)).toBe("123.456");
    expect(fromAtomic("1000000", 6)).toBe("1");
  });
});

describe("notionalUsd", () => {
  it("sums priced inputs", () => {
    const r = notionalUsd([
      { token: "a", atomic: 50_000_000n, decimals: 6, priceUsd: 1 },
      { token: "b", atomic: 10n ** 17n, decimals: 18, priceUsd: 3000 },
    ]);
    expect(r.usd).toBeCloseTo(350);
    expect(r.unpriced).toEqual([]);
  });
  it("reports unknown instead of skipping an unpriced token", () => {
    const r = notionalUsd([
      { token: "a", atomic: 1n, decimals: 6, priceUsd: 1 },
      { token: "junk", atomic: 1n, decimals: 18, priceUsd: undefined },
    ]);
    expect(r.usd).toBeNull();
    expect(r.unpriced).toEqual(["junk"]);
  });
});

describe("bpsDiff", () => {
  it("measures relative difference in bps", () => {
    expect(bpsDiff(10_100n, 10_000n)).toBeCloseTo(100);
    expect(bpsDiff(9_950n, 10_000n)).toBeCloseTo(50);
    expect(bpsDiff(1n, 0n)).toBe(Infinity);
  });
});
