import { formatUnits } from "viem";
import type { Order } from "./config.js";

/**
 * The price the order is judged on, from a real quote: for stop_loss / take_profit the price of one
 * `sell` token in `buy` units (out / in); for limit_buy the price of one `buy` token in `sell` units (in / out).
 */
export function executablePrice(order: Order, amountIn: bigint, expectedOut: bigint, decIn: number, decOut: number): number {
  const inHuman = Number(formatUnits(amountIn, decIn));
  const outHuman = Number(formatUnits(expectedOut, decOut));
  if (inHuman === 0 || outHuman === 0) return NaN;
  return order.type === "limit_buy" ? inHuman / outHuman : outHuman / inHuman;
}

/** Whether a price (in the order's own terms) satisfies the trigger. */
export function triggered(order: Order, price: number): boolean {
  if (!Number.isFinite(price)) return false;
  switch (order.type) {
    case "stop_loss":
      return price <= order.trigger_price;
    case "take_profit":
      return price >= order.trigger_price;
    case "limit_buy":
      return price <= order.trigger_price;
  }
}

/**
 * Reference price in the order's terms from USD prices (sell and buy), used only to skip quoting orders
 * that are far from their trigger. Returns undefined when either side is unpriced.
 */
export function referencePrice(order: Order, sellUsd: number | undefined, buyUsd: number | undefined): number | undefined {
  if (sellUsd === undefined || buyUsd === undefined || sellUsd <= 0 || buyUsd <= 0) return undefined;
  return order.type === "limit_buy" ? buyUsd / sellUsd : sellUsd / buyUsd;
}

/**
 * Quote only when the reference price is on the triggered side, or within prefilter_bps of the trigger.
 * An unknown reference price always quotes: the real quote is the source of truth.
 */
export function worthQuoting(order: Order, reference: number | undefined): boolean {
  if (reference === undefined) return true;
  if (triggered(order, reference)) return true;
  const distance = Math.abs(reference - order.trigger_price) / order.trigger_price;
  return distance * 10_000 <= order.prefilter_bps;
}

export function describeTrigger(order: Order, sellSymbol: string, buySymbol: string): string {
  switch (order.type) {
    case "stop_loss":
      return `sell ${sellSymbol} when 1 ${sellSymbol} <= ${order.trigger_price} ${buySymbol}`;
    case "take_profit":
      return `sell ${sellSymbol} when 1 ${sellSymbol} >= ${order.trigger_price} ${buySymbol}`;
    case "limit_buy":
      return `buy ${buySymbol} with ${sellSymbol} when 1 ${buySymbol} <= ${order.trigger_price} ${sellSymbol}`;
  }
}
