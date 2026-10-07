import { describe, expect, it } from "vitest";
import { MAX_QUOTE_AGE_MS } from "../src/config.js";
import { checkConfirmed, checkNotional, checkQuoteFresh, checkSlippage, checkTaker } from "../src/guards.js";

describe("guards", () => {
  it("caps slippage at the configured ceiling", () => {
    expect(() => checkSlippage(100, 100)).not.toThrow();
    expect(() => checkSlippage(101, 100)).toThrow(/MAX_SLIPPAGE_BPS/);
    expect(() => checkSlippage(-1, 100)).toThrow();
  });
  it("refuses notional above the cap or unknown", () => {
    expect(() => checkNotional(99.99, [], 100)).not.toThrow();
    expect(() => checkNotional(100.01, [], 100)).toThrow(/MAX_NOTIONAL_USD/);
    expect(() => checkNotional(null, ["0xjunk"], 100)).toThrow(/0xjunk/);
  });
  it("refuses stale quotes", () => {
    expect(() => checkQuoteFresh(0, MAX_QUOTE_AGE_MS)).not.toThrow();
    expect(() => checkQuoteFresh(0, MAX_QUOTE_AGE_MS + 1)).toThrow(/get_quote again/);
  });
  it("requires an explicit true confirmation", () => {
    expect(() => checkConfirmed(true, "t")).not.toThrow();
    expect(() => checkConfirmed(false, "t")).toThrow(/confirm=true/);
    expect(() => checkConfirmed(undefined, "t")).toThrow(/confirm=true/);
  });
  it("requires the quote taker to be the wallet", () => {
    const a = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7";
    expect(() => checkTaker(a, a.toLowerCase())).not.toThrow();
    expect(() => checkTaker(a, "0x0000000000000000000000000000000000000001")).toThrow(/msg.sender/);
  });
});
