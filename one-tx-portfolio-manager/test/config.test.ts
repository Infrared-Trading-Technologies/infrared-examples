import { describe, expect, it } from "vitest";
import { BotError, NATIVE, parseConfig } from "../src/config.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const base = { chain_id: 8453, slippage_bps: 50, max_notional_usd: 1000 };

function tokens(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
}

describe("parseConfig", () => {
  it("parses a dca section with base-unit amounts as bigint", () => {
    const cfg = parseConfig({
      ...base,
      dca: { input: { token: USDC, amount: "25000000" }, outputs: [{ token: WETH, ratio_bps: 10000 }] },
    });
    expect(cfg.dca!.input.amount).toBe(25_000_000n);
  });

  it("normalizes the zero address to the native sentinel", () => {
    const cfg = parseConfig({
      ...base,
      sweep: { inputs: ["0x0000000000000000000000000000000000000000"], output: USDC },
    });
    expect(cfg.sweep!.inputs).toEqual([NATIVE]);
  });

  it("rejects ratios that do not sum to 10000", () => {
    expect(() =>
      parseConfig({
        ...base,
        dca: { input: { token: USDC, amount: "1" }, outputs: [{ token: WETH, ratio_bps: 9000 }] },
      }),
    ).toThrow(/sum to 10000/);
  });

  it("rejects a sweep with more than 6 inputs instead of truncating", () => {
    expect(() => parseConfig({ ...base, sweep: { inputs: tokens(7), output: USDC } })).toThrow(/at most 6/);
  });

  it("rejects more than 6 dca outputs", () => {
    const outputs = tokens(7).map((token, i) => ({ token, ratio_bps: i === 0 ? 4000 : 1000 }));
    expect(() => parseConfig({ ...base, dca: { input: { token: USDC, amount: "1" }, outputs } })).toThrow(/at most 6/);
  });

  it("rejects a non-integer base-unit amount", () => {
    expect(() =>
      parseConfig({ ...base, dca: { input: { token: USDC, amount: "1.5" }, outputs: [{ token: WETH, ratio_bps: 10000 }] } }),
    ).toThrow(BotError);
  });

  it("requires a positive max_notional_usd", () => {
    expect(() => parseConfig({ chain_id: 8453 })).toThrow(/max_notional_usd/);
  });
});
