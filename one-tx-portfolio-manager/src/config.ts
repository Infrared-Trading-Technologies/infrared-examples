import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { getAddress, isAddress, type Address } from "viem";

export const NATIVE: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const MAX_TOKENS_PER_SIDE = 6;

/** An error the bot reports to the user and exits non-zero on. */
export class BotError extends Error {}

export interface RebalanceConfig {
  targets: { token: Address; weight_bps: number }[];
  drift_threshold_bps: number;
}

export interface DcaConfig {
  input: { token: Address; amount: bigint };
  outputs: { token: Address; ratio_bps: number }[];
}

export interface SweepConfig {
  inputs: Address[];
  output: Address;
}

export interface Config {
  chain_id: number;
  slippage_bps: number;
  max_notional_usd: number;
  gas_reserve_wei: bigint;
  rebalance?: RebalanceConfig;
  dca?: DcaConfig;
  sweep?: SweepConfig;
}

export function loadConfig(path: string): Config {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new BotError(`cannot read config ${path}: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}

export function parseConfig(raw: unknown): Config {
  const c = obj(raw, "config");
  const cfg: Config = {
    chain_id: int(c.chain_id, "chain_id", 1),
    slippage_bps: int(c.slippage_bps ?? 50, "slippage_bps", 0, 5000),
    max_notional_usd: num(c.max_notional_usd, "max_notional_usd"),
    gas_reserve_wei: uint(c.gas_reserve_wei ?? "0", "gas_reserve_wei"),
  };

  if (c.rebalance !== undefined) {
    const r = obj(c.rebalance, "rebalance");
    const targets = list(r.targets, "rebalance.targets").map((t, i) => {
      const o = obj(t, `rebalance.targets[${i}]`);
      return {
        token: addr(o.token, `rebalance.targets[${i}].token`),
        weight_bps: int(o.weight_bps, `rebalance.targets[${i}].weight_bps`, 0, 10000),
      };
    });
    if (targets.length < 2) throw new BotError("rebalance.targets needs at least 2 tokens");
    sumTo10000(targets.map((t) => t.weight_bps), "rebalance.targets weight_bps");
    unique(targets.map((t) => t.token), "rebalance.targets");
    cfg.rebalance = {
      targets,
      drift_threshold_bps: int(r.drift_threshold_bps ?? 100, "rebalance.drift_threshold_bps", 1, 10000),
    };
  }

  if (c.dca !== undefined) {
    const d = obj(c.dca, "dca");
    const input = obj(d.input, "dca.input");
    const outputs = list(d.outputs, "dca.outputs").map((o, i) => {
      const x = obj(o, `dca.outputs[${i}]`);
      return {
        token: addr(x.token, `dca.outputs[${i}].token`),
        ratio_bps: int(x.ratio_bps, `dca.outputs[${i}].ratio_bps`, 1, 10000),
      };
    });
    capSide(outputs.length, "dca.outputs");
    sumTo10000(outputs.map((o) => o.ratio_bps), "dca.outputs ratio_bps");
    unique(outputs.map((o) => o.token), "dca.outputs");
    const amount = uint(input.amount, "dca.input.amount");
    if (amount === 0n) throw new BotError("dca.input.amount must be > 0");
    const token = addr(input.token, "dca.input.token");
    if (outputs.some((o) => o.token === token)) throw new BotError("dca.input.token cannot also be an output");
    cfg.dca = { input: { token, amount }, outputs };
  }

  if (c.sweep !== undefined) {
    const s = obj(c.sweep, "sweep");
    const inputs = list(s.inputs, "sweep.inputs").map((t, i) => addr(t, `sweep.inputs[${i}]`));
    capSide(inputs.length, "sweep.inputs");
    unique(inputs, "sweep.inputs");
    const output = addr(s.output, "sweep.output");
    if (inputs.includes(output)) throw new BotError("sweep.output cannot also be a sweep input");
    cfg.sweep = { inputs, output };
  }

  return cfg;
}

export function capSide(n: number, what: string): void {
  if (n > MAX_TOKENS_PER_SIDE) {
    throw new BotError(
      `${what} has ${n} tokens; Infrared settles at most ${MAX_TOKENS_PER_SIDE} inputs and ${MAX_TOKENS_PER_SIDE} outputs per transaction`,
    );
  }
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
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new BotError(`${what} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

function num(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new BotError(`${what} must be a positive number`);
  return v;
}

function uint(v: unknown, what: string): bigint {
  const s = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== "string" || !/^[0-9]+$/.test(s)) {
    throw new BotError(`${what} must be a non-negative integer in base units (quote large values as strings)`);
  }
  return BigInt(s);
}

function addr(v: unknown, what: string): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new BotError(`${what} must be an address`);
  const a = getAddress(v);
  return a.toLowerCase() === "0x0000000000000000000000000000000000000000" ? NATIVE : a;
}

function sumTo10000(xs: number[], what: string): void {
  const sum = xs.reduce((a, b) => a + b, 0);
  if (sum !== 10000) throw new BotError(`${what} must sum to 10000 (got ${sum})`);
}

function unique(xs: Address[], what: string): void {
  if (new Set(xs.map((x) => x.toLowerCase())).size !== xs.length) throw new BotError(`${what} contains a duplicate token`);
}
