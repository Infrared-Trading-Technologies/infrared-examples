import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const order = { id: "a", chain_id: 42161, type: "stop_loss", sell: { token: WETH, amount: "0.05" }, buy: { token: USDC }, trigger_price: 2200 };

describe("parseConfig", () => {
  it("applies defaults", () => {
    const c = parseConfig({ max_notional_usd: 500, orders: [order] });
    expect(c.interval_seconds).toBe(60);
    expect(c.state_file).toBe("./data/state.json");
    const o = c.orders[0]!;
    expect(o.slippage_bps).toBe(50);
    expect(o.confirmations).toBe(2);
    expect(o.prefilter_bps).toBe(300);
    expect(o.max_notional_usd).toBe(500);
    expect(o.expires).toBeUndefined();
  });
  it("accepts numeric amounts, 'all', expiry and the zero address as native", () => {
    const c = parseConfig({ max_notional_usd: 500, orders: [{ ...order, sell: { token: "0x0000000000000000000000000000000000000000", amount: "all" }, expires: "2026-12-31T00:00:00Z", max_notional_usd: 50 }] });
    expect(c.orders[0]!.sell.amount).toBe("all");
    expect(c.orders[0]!.sell.token).toBe("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE");
    expect(c.orders[0]!.expires?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
    expect(c.orders[0]!.max_notional_usd).toBe(50);
  });
  it("rejects bad orders", () => {
    const bad = [
      { ...order, type: "trailing" },
      { ...order, id: "has space" },
      { ...order, sell: { token: WETH, amount: "-1" } },
      { ...order, sell: { token: USDC, amount: "1" } }, // same as buy
      { ...order, type: "limit_buy", sell: { token: USDC, amount: "all" } },
      { ...order, trigger_price: 0 },
      { ...order, expires: "tomorrow" },
      { ...order, confirmations: 0 },
    ];
    for (const b of bad) expect(() => parseConfig({ max_notional_usd: 500, orders: [b] }), JSON.stringify(b)).toThrow();
    expect(() => parseConfig({ max_notional_usd: 500, orders: [order, order] })).toThrow(/unique/);
    expect(() => parseConfig({ orders: [order] })).toThrow(/max_notional_usd/);
    expect(() => parseConfig({ max_notional_usd: 500, orders: [] })).toThrow(/orders/);
  });
});
