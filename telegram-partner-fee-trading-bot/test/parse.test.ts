import { describe, expect, it } from "vitest";
import { parseTrade } from "../src/parse.js";

describe("parseTrade", () => {
  it("parses a simple swap", () => {
    expect(parseTrade("50 USDC to WETH")).toEqual({ inputs: [{ token: "USDC", amount: "50" }], outputs: [{ token: "WETH", ratioBps: 10000 }] });
  });
  it("parses percentages and separators", () => {
    const r = parseTrade("50 usdc -> 60% WETH, 40% cbBTC");
    expect(r.outputs).toEqual([
      { token: "WETH", ratioBps: 6000 },
      { token: "cbBTC", ratioBps: 4000 },
    ]);
  });
  it("splits unspecified outputs equally and gives the remainder to the last", () => {
    expect(parseTrade("1 ETH into WETH USDC WBTC").outputs.map((o) => o.ratioBps)).toEqual([3333, 3333, 3334]);
    expect(parseTrade("1 ETH into 50% WETH USDC WBTC").outputs.map((o) => o.ratioBps)).toEqual([5000, 2500, 2500]);
  });
  it("parses multiple inputs", () => {
    expect(parseTrade("0.01 ETH + 20 USDC and 5 DAI to WETH").inputs.map((i) => i.token)).toEqual(["ETH", "USDC", "DAI"]);
  });
  it("accepts addresses", () => {
    const a = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
    expect(parseTrade(`1 ${a} to WETH`).inputs[0]?.token).toBe(a);
  });
  it("rejects malformed trades", () => {
    for (const bad of ["USDC to WETH", "50 USDC", "50 USDC to 60% WETH 50% WBTC", "50 USDC to 60% WETH", "0 USDC to WETH", "50 USDC to WETH USDC", "50 USDC to 100% WETH WBTC", "1 2 3 4 5 6 7 to X"]) {
      expect(() => parseTrade(bad), bad).toThrow();
    }
  });
});
