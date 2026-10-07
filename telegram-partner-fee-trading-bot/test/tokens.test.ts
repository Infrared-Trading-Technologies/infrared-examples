import { describe, expect, it } from "vitest";
import type { TokenInfo } from "../src/infrared.js";
import { pickBySymbol } from "../src/tokens.js";

const tok = (address: string, symbol: string, pool_count: number): TokenInfo => ({ address: address as TokenInfo["address"], symbol, name: symbol, decimals: 6, chain_id: 1, pool_count });

describe("pickBySymbol", () => {
  it("matches the symbol exactly, case-insensitively", () => {
    const r = pickBySymbol([tok("0x1", "USDC", 5), tok("0x2", "USDC.e", 3)], "usdc");
    expect(r.ok && r.token.address).toBe("0x1");
  });
  it("prefers the only routable token when vault shares reuse the symbol", () => {
    const r = pickBySymbol([tok("0x1", "USDC", 91), tok("0x2", "USDC", 0), tok("0x3", "USDC", 0)], "USDC");
    expect(r.ok && r.token.address).toBe("0x1");
  });
  it("stays ambiguous when several matches have liquidity, listing the most liquid first", () => {
    const r = pickBySymbol([tok("0x1", "X", 2), tok("0x2", "X", 9)], "X");
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "ambiguous") expect(r.candidates.map((c) => c.address)).toEqual(["0x2", "0x1"]);
  });
  it("reports no match", () => {
    expect(pickBySymbol([tok("0x1", "WETH", 1)], "USDC")).toEqual({ ok: false, reason: "none" });
  });
});
