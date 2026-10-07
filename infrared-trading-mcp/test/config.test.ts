import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const KEY = "0x" + "11".repeat(32);

describe("loadConfig", () => {
  it("is read-only and dry-run by default", () => {
    const c = loadConfig({});
    expect(c.executeEnabled).toBe(false);
    expect(c.privateKey).toBeUndefined();
    expect(c.apiKey).toBeUndefined();
    expect(c.maxNotionalUsd).toBe(100);
    expect(c.maxSlippageBps).toBe(100);
    expect(c.rpcUrls.size).toBe(0);
  });
  it("only the literal string true enables execution, and only with a key", () => {
    expect(loadConfig({ EXECUTE_ENABLED: "1", PRIVATE_KEY: KEY }).executeEnabled).toBe(false);
    expect(loadConfig({ EXECUTE_ENABLED: "TRUE", PRIVATE_KEY: KEY }).executeEnabled).toBe(false);
    expect(loadConfig({ EXECUTE_ENABLED: "true", PRIVATE_KEY: KEY }).executeEnabled).toBe(true);
    expect(() => loadConfig({ EXECUTE_ENABLED: "true" })).toThrow(/PRIVATE_KEY/);
  });
  it("collects RPC_URL_<chain_id>", () => {
    const c = loadConfig({ RPC_URL_1: "https://a", RPC_URL_8453: "https://b", RPC_URL_x: "https://c", RPC_URL: "https://d" });
    expect([...c.rpcUrls.keys()].sort()).toEqual([1, 8453]);
    expect(() => loadConfig({ RPC_URL_1: "ftp://x" })).toThrow(/RPC_URL_1/);
  });
  it("validates the key and the caps", () => {
    expect(() => loadConfig({ PRIVATE_KEY: "0x123" })).toThrow(/PRIVATE_KEY/);
    expect(() => loadConfig({ MAX_NOTIONAL_USD: "0" })).toThrow(/MAX_NOTIONAL_USD/);
    expect(() => loadConfig({ MAX_SLIPPAGE_BPS: "5001" })).toThrow(/MAX_SLIPPAGE_BPS/);
    expect(() => loadConfig({ MAX_SLIPPAGE_BPS: "1.5" })).toThrow(/MAX_SLIPPAGE_BPS/);
    expect(loadConfig({ MAX_NOTIONAL_USD: "25" }).maxNotionalUsd).toBe(25);
  });
});
