import { formatUnits, parseUnits, type Address } from "viem";

export interface Holding {
  token: Address;
  /** Spendable balance in base units (native already net of the gas reserve). */
  balance: bigint;
  decimals: number;
  priceUsd: number;
  targetBps: number;
}

export interface Leg {
  token: Address;
  amount: bigint;
}

export interface RebalanceTrade {
  sells: Leg[];
  buys: { token: Address; ratio_bps: number }[];
  maxDriftBps: number;
}

/** Legs smaller than this share of the portfolio are left alone: they are rounding noise, often too small to route. */
export const MIN_LEG_BPS = 10;

export function usdValue(amount: bigint, decimals: number, priceUsd: number): number {
  return Number(formatUnits(amount, decimals)) * priceUsd;
}

/** Current weight of each holding in basis points of total USD value. */
export function weightsBps(holdings: Holding[]): number[] {
  const values = holdings.map((h) => usdValue(h.balance, h.decimals, h.priceUsd));
  const total = values.reduce((a, b) => a + b, 0);
  return values.map((v) => (total === 0 ? 0 : (v / total) * 10000));
}

/**
 * Computes the single many-to-many trade that moves holdings to their targets:
 * every overweight token is sold down by its excess, and the proceeds are split
 * across underweight tokens in proportion to their shortfall. Returns null when
 * every weight is already within thresholdBps of its target.
 */
export function planRebalance(holdings: Holding[], thresholdBps: number): RebalanceTrade | null {
  const values = holdings.map((h) => usdValue(h.balance, h.decimals, h.priceUsd));
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  const drifts = holdings.map((h, i) => (values[i] ?? 0) - (total * h.targetBps) / 10000);
  const maxDriftBps = Math.max(...drifts.map((d) => (Math.abs(d) / total) * 10000));
  if (maxDriftBps <= thresholdBps) return null;

  const sells: Leg[] = [];
  const shortfalls: { token: Address; usd: number }[] = [];
  const minLegUsd = (total * MIN_LEG_BPS) / 10000;
  holdings.forEach((h, i) => {
    const d = drifts[i] ?? 0;
    if (Math.abs(d) < minLegUsd) return;
    if (d > 0) {
      const units = d / h.priceUsd;
      let amount = parseUnits(units.toFixed(h.decimals), h.decimals);
      if (amount > h.balance) amount = h.balance;
      if (amount > 0n) sells.push({ token: h.token, amount });
    } else if (d < 0) {
      shortfalls.push({ token: h.token, usd: -d });
    }
  });

  const ratios = ratiosBps(shortfalls.map((s) => s.usd));
  const buys = shortfalls
    .map((s, i) => ({ token: s.token, ratio_bps: ratios[i] ?? 0 }))
    .filter((b) => b.ratio_bps > 0);
  if (sells.length === 0 || buys.length === 0) return null;
  return { sells, buys: normalize(buys), maxDriftBps };
}

/** Splits 10000 bps across weights proportionally (largest-remainder), summing to exactly 10000. */
export function ratiosBps(weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (w / total) * 10000);
  const out = raw.map(Math.floor);
  let rest = 10000 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (rest === 0) break;
    out[i] = (out[i] ?? 0) + 1;
    rest--;
  }
  return out;
}

function normalize(buys: { token: Address; ratio_bps: number }[]): { token: Address; ratio_bps: number }[] {
  const ratios = ratiosBps(buys.map((b) => b.ratio_bps));
  return buys.map((b, i) => ({ token: b.token, ratio_bps: ratios[i] ?? 0 }));
}
