import { describe, expect, it } from "vitest";
import { parseUnits, type Address } from "viem";
import { planRebalance, ratiosBps, usdValue, weightsBps, type Holding } from "../src/rebalance-math.js";

const A = "0x00000000000000000000000000000000000000aa" as Address;
const B = "0x00000000000000000000000000000000000000bb" as Address;
const C = "0x00000000000000000000000000000000000000cc" as Address;

function h(token: Address, units: string, decimals: number, priceUsd: number, targetBps: number): Holding {
  return { token, balance: parseUnits(units, decimals), decimals, priceUsd, targetBps };
}

describe("ratiosBps", () => {
  it("always sums to exactly 10000", () => {
    for (const w of [[1, 1, 1], [1, 2], [0.3, 0.3, 0.4], [7, 11, 13, 17, 19, 23]]) {
      expect(ratiosBps(w).reduce((a, b) => a + b, 0)).toBe(10000);
    }
  });

  it("is proportional", () => {
    expect(ratiosBps([1, 3])).toEqual([2500, 7500]);
  });
});

describe("planRebalance", () => {
  it("returns null when every weight is within the threshold", () => {
    const holdings = [h(A, "5000", 6, 1, 5000), h(B, "2.5", 18, 2000, 5000)];
    expect(planRebalance(holdings, 100)).toBeNull();
  });

  it("sells the overweight token by exactly its excess and buys the underweight one", () => {
    // $8000 of A, $2000 of B, target 50/50: sell $3000 of A into B.
    const holdings = [h(A, "8000", 6, 1, 5000), h(B, "1", 18, 2000, 5000)];
    const trade = planRebalance(holdings, 100);
    expect(trade).not.toBeNull();
    expect(trade!.sells).toEqual([{ token: A, amount: parseUnits("3000", 6) }]);
    expect(trade!.buys).toEqual([{ token: B, ratio_bps: 10000 }]);
  });

  it("splits proceeds across underweight tokens in proportion to their shortfall", () => {
    // Total $10000, targets 40/30/30. A=$7000 (+3000), B=$1000 (-2000), C=$2000 (-1000).
    const holdings = [h(A, "7000", 6, 1, 4000), h(B, "0.5", 18, 2000, 3000), h(C, "2000", 18, 1, 3000)];
    const trade = planRebalance(holdings, 100)!;
    expect(trade.sells).toEqual([{ token: A, amount: parseUnits("3000", 6) }]);
    expect(trade.buys).toEqual([
      { token: B, ratio_bps: 6667 },
      { token: C, ratio_bps: 3333 },
    ]);
  });

  it("lands every token on target when the trade fills at the quoted prices", () => {
    const holdings = [h(A, "7000", 6, 1, 4000), h(B, "0.5", 18, 2000, 3000), h(C, "2000", 18, 1, 3000)];
    const trade = planRebalance(holdings, 100)!;
    const sold = trade.sells.reduce((s, l) => s + usdValue(l.amount, 6, 1), 0);
    const after = holdings.map((x) => {
      const sell = trade.sells.find((l) => l.token === x.token)?.amount ?? 0n;
      const buy = trade.buys.find((b) => b.token === x.token)?.ratio_bps ?? 0;
      const boughtUnits = parseUnits(((sold * buy) / 10000 / x.priceUsd).toFixed(x.decimals), x.decimals);
      return { ...x, balance: x.balance - sell + boughtUnits };
    });
    weightsBps(after).forEach((w, i) => expect(Math.abs(w - holdings[i]!.targetBps)).toBeLessThan(1));
  });

  it("never sells more than the spendable balance", () => {
    const holdings = [h(A, "100", 6, 1, 0), h(B, "0", 18, 2000, 10000)];
    const trade = planRebalance(holdings, 100)!;
    expect(trade.sells[0]!.amount).toBe(parseUnits("100", 6));
  });

  it("leaves a token that is only a hair off target out of the trade", () => {
    // B is $3 over its $3000 target (1 bps): it must not become a dust sell leg.
    const holdings = [h(A, "7000", 6, 1, 4000), h(B, "1.5015", 18, 2000, 3000), h(C, "0", 18, 1, 3000)];
    const trade = planRebalance(holdings, 100)!;
    expect(trade.sells.map((s) => s.token)).toEqual([A]);
    expect(trade.buys.map((b) => b.token)).toEqual([C]);
  });

  it("returns null for an empty portfolio", () => {
    expect(planRebalance([h(A, "0", 6, 1, 5000), h(B, "0", 18, 2000, 5000)], 100)).toBeNull();
  });
});
