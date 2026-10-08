import { parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import type { Order } from "../src/config.js";
import { executablePrice, referencePrice, triggered, worthQuoting } from "../src/evaluate.js";

const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const base = { id: "o", chain_id: 42161, slippage_bps: 50, confirmations: 2, prefilter_bps: 300, max_notional_usd: 100 };
const stop: Order = { ...base, type: "stop_loss", sell: { token: WETH, amount: "0.01" }, buy: { token: USDC }, trigger_price: 2500 };
const take: Order = { ...stop, type: "take_profit" };
const limit: Order = { ...base, type: "limit_buy", sell: { token: USDC, amount: "100" }, buy: { token: WETH }, trigger_price: 2500 };

describe("executablePrice", () => {
  it("is output per input for sells", () => {
    // 0.01 WETH -> 25.5 USDC = 2550 USDC per WETH
    expect(executablePrice(stop, parseUnits("0.01", 18), parseUnits("25.5", 6), 18, 6)).toBeCloseTo(2550);
  });
  it("is input per output for limit buys", () => {
    // 100 USDC -> 0.04 WETH = 2500 USDC per WETH
    expect(executablePrice(limit, parseUnits("100", 6), parseUnits("0.04", 18), 6, 18)).toBeCloseTo(2500);
  });
  it("is NaN for an empty quote", () => {
    expect(executablePrice(stop, parseUnits("0.01", 18), 0n, 18, 6)).toBeNaN();
  });
});

describe("triggered", () => {
  it("stop_loss fires at or below, take_profit at or above, limit_buy at or below", () => {
    expect(triggered(stop, 2500)).toBe(true);
    expect(triggered(stop, 2500.01)).toBe(false);
    expect(triggered(take, 2500)).toBe(true);
    expect(triggered(take, 2499.99)).toBe(false);
    expect(triggered(limit, 2499)).toBe(true);
    expect(triggered(limit, 2501)).toBe(false);
    expect(triggered(stop, NaN)).toBe(false);
  });
});

describe("prefilter", () => {
  it("derives a reference price in the order's terms from USD prices", () => {
    expect(referencePrice(stop, 2600, 1)).toBeCloseTo(2600);
    expect(referencePrice(limit, 1, 2600)).toBeCloseTo(2600);
    expect(referencePrice(stop, undefined, 1)).toBeUndefined();
  });
  it("always quotes on the triggered side or near the trigger, never when far away", () => {
    expect(worthQuoting(stop, 2400)).toBe(true); // already below the stop
    expect(worthQuoting(stop, 2560)).toBe(true); // 2.4% above, inside 300 bps
    expect(worthQuoting(stop, 2700)).toBe(false); // 8% above
    expect(worthQuoting(take, 2400)).toBe(false);
    expect(worthQuoting(take, 2600)).toBe(true);
    expect(worthQuoting(limit, 2700)).toBe(false);
    expect(worthQuoting(limit, undefined)).toBe(true); // unknown reference: the quote decides
  });
});
