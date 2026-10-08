import { readFileSync } from "node:fs";
import { getAddress, isAddress, type Address } from "viem";
import { parse } from "yaml";

export const NATIVE: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/** An error the keeper reports and, at startup, exits on. */
export class BotError extends Error {}

export type OrderType = "stop_loss" | "take_profit" | "limit_buy";

export interface Order {
  id: string;
  chain_id: number;
  type: OrderType;
  /** Token sold. For limit_buy this is the token spent (e.g. USDC). */
  sell: { token: Address; amount: string | "all" };
  buy: { token: Address };
  /**
   * stop_loss / take_profit: price of one `sell` token in `buy` units.
   * limit_buy: price of one `buy` token in `sell` units.
   */
  trigger_price: number;
  slippage_bps: number;
  /** Consecutive ticks the condition must hold before filling (guards against a one-tick wick). */
  confirmations: number;
  /** Skip the quote when the reference price is on the untriggered side and further than this from the trigger. */
  prefilter_bps: number;
  max_notional_usd: number;
  expires?: Date;
}

export interface KeeperConfig {
  interval_seconds: number;
  max_notional_usd: number;
  gas_reserve_wei: bigint;
  state_file: string;
  orders: Order[];
}

export function loadConfig(path: string): KeeperConfig {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new BotError(`cannot read ${path}: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}

export function parseConfig(raw: unknown): KeeperConfig {
  const c = obj(raw, "config");
  const cfg: KeeperConfig = {
    interval_seconds: int(c.interval_seconds ?? 60, "interval_seconds", 5, 86_400),
    max_notional_usd: num(c.max_notional_usd, "max_notional_usd"),
    gas_reserve_wei: uint(c.gas_reserve_wei ?? "0", "gas_reserve_wei"),
    state_file: typeof c.state_file === "string" && c.state_file ? c.state_file : "./data/state.json",
    orders: list(c.orders, "orders").map((o, i) => parseOrder(o, `orders[${i}]`, c.max_notional_usd as number)),
  };
  const ids = cfg.orders.map((o) => o.id);
  if (new Set(ids).size !== ids.length) throw new BotError("orders: every id must be unique");
  return cfg;
}

function parseOrder(raw: unknown, what: string, defaultCap: number): Order {
  const o = obj(raw, what);
  if (typeof o.id !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(o.id)) throw new BotError(`${what}.id must be a short identifier (letters, digits, _ . -)`);
  const type = o.type;
  if (type !== "stop_loss" && type !== "take_profit" && type !== "limit_buy") throw new BotError(`${what}.type must be stop_loss, take_profit or limit_buy`);
  const sell = obj(o.sell, `${what}.sell`);
  const buy = obj(o.buy, `${what}.buy`);
  const amount = sell.amount === "all" ? "all" : humanAmount(sell.amount, `${what}.sell.amount`);
  if (type === "limit_buy" && amount === "all") throw new BotError(`${what}: limit_buy needs a fixed sell.amount, not "all"`);
  const order: Order = {
    id: o.id,
    chain_id: int(o.chain_id, `${what}.chain_id`, 1),
    type,
    sell: { token: addr(sell.token, `${what}.sell.token`), amount },
    buy: { token: addr(buy.token, `${what}.buy.token`) },
    trigger_price: num(o.trigger_price, `${what}.trigger_price`),
    slippage_bps: int(o.slippage_bps ?? 50, `${what}.slippage_bps`, 0, 5000),
    confirmations: int(o.confirmations ?? 2, `${what}.confirmations`, 1, 1000),
    prefilter_bps: int(o.prefilter_bps ?? 300, `${what}.prefilter_bps`, 0, 100_000),
    max_notional_usd: o.max_notional_usd === undefined ? defaultCap : num(o.max_notional_usd, `${what}.max_notional_usd`),
  };
  if (order.sell.token.toLowerCase() === order.buy.token.toLowerCase()) throw new BotError(`${what}: sell and buy token are the same`);
  if (o.expires !== undefined) {
    const d = new Date(o.expires as string);
    if (Number.isNaN(d.getTime())) throw new BotError(`${what}.expires must be an ISO-8601 date`);
    order.expires = d;
  }
  return order;
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new BotError(`${what} must be a mapping`);
  return v as Record<string, unknown>;
}

function list(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v) || v.length === 0) throw new BotError(`${what} must be a non-empty list`);
  return v;
}

function int(v: unknown, what: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new BotError(`${what} must be an integer in [${min}, ${max}]`);
  return v;
}

function num(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new BotError(`${what} must be a positive number`);
  return v;
}

function uint(v: unknown, what: string): bigint {
  const s = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== "string" || !/^[0-9]+$/.test(s)) throw new BotError(`${what} must be a non-negative integer in wei (quote large values as strings)`);
  return BigInt(s);
}

/** Human token amount as a decimal string; numbers are accepted but strings avoid float surprises. */
function humanAmount(v: unknown, what: string): string {
  const s = typeof v === "number" ? String(v) : v;
  if (typeof s !== "string" || !/^\d+(\.\d+)?$/.test(s) || Number(s) <= 0) throw new BotError(`${what} must be a positive decimal amount like "0.5" (or "all")`);
  return s;
}

function addr(v: unknown, what: string): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new BotError(`${what} must be a token address`);
  const a = getAddress(v);
  return a.toLowerCase() === "0x0000000000000000000000000000000000000000" ? NATIVE : a;
}
