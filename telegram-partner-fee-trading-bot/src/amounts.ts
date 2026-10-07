import { formatUnits, parseUnits } from "viem";
import { ToolError } from "./config.js";

/** Converts a human decimal amount ("1.25") to atomic units using the token's real decimals. Strict: no exponent, no excess precision, no zero. */
export function toAtomic(human: string, decimals: number, what: string): bigint {
  const s = human.trim().replace(/_/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new ToolError(`${what}: amount "${human}" must be a plain decimal number like "1.25"`);
  const frac = s.split(".")[1] ?? "";
  if (frac.length > decimals) {
    throw new ToolError(`${what}: amount "${human}" has ${frac.length} decimal places but the token has ${decimals}`);
  }
  const atomic = parseUnits(s, decimals);
  if (atomic === 0n) throw new ToolError(`${what}: amount must be greater than zero`);
  return atomic;
}

export function fromAtomic(atomic: bigint | string, decimals: number): string {
  return formatUnits(BigInt(atomic), decimals);
}

export interface Priced {
  token: string;
  atomic: bigint;
  decimals: number;
  priceUsd: number | undefined;
}

/** Sums USD value; a token without a price makes the total unknown and is reported, never silently skipped. */
export function notionalUsd(items: Priced[]): { usd: number | null; unpriced: string[] } {
  const unpriced = items.filter((i) => i.priceUsd === undefined).map((i) => i.token);
  if (unpriced.length > 0) return { usd: null, unpriced };
  const usd = items.reduce((sum, i) => sum + Number(formatUnits(i.atomic, i.decimals)) * (i.priceUsd as number), 0);
  return { usd, unpriced };
}

export function bpsDiff(a: bigint, b: bigint): number {
  if (b === 0n) return Infinity;
  return Math.abs(Number(((a - b) * 1_000_000n) / b)) / 100;
}
