import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const BASE = { TELEGRAM_BOT_TOKEN: "t", WALLETCONNECT_PROJECT_ID: "p", INFRARED_API_KEY: "k", RPC_URL_1: "https://a", RPC_URL_8453: "https://b", RPC_URL_42161: "https://c" };

describe("loadConfig", () => {
  it("defaults to the three chains, no partner fee, 0.5% default slippage and a 3% cap", () => {
    const c = loadConfig(BASE);
    expect(c.chains).toEqual([1, 8453, 42161]);
    expect(c.partnerFeeBps).toBe(0);
    expect(c.partnerRecipient).toBeUndefined();
    expect(c.defaultSlippageBps).toBe(50);
    expect(c.maxSlippageBps).toBe(300);
    expect(c.allowedUserIds.size).toBe(0);
  });
  it("requires the three secrets", () => {
    for (const k of ["TELEGRAM_BOT_TOKEN", "WALLETCONNECT_PROJECT_ID", "INFRARED_API_KEY"]) expect(() => loadConfig({ ...BASE, [k]: "" })).toThrow(k);
  });
  it("requires a recipient when a fee is set and checksums it", () => {
    expect(() => loadConfig({ ...BASE, PARTNER_FEE_BPS: "50" })).toThrow(/PARTNER_RECIPIENT/);
    const c = loadConfig({ ...BASE, PARTNER_FEE_BPS: "50", PARTNER_RECIPIENT: "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7" });
    expect(c.partnerRecipient).toBe("0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7");
    expect(() => loadConfig({ ...BASE, PARTNER_FEE_BPS: "50", PARTNER_RECIPIENT: "0x123" })).toThrow(/PARTNER_RECIPIENT/);
  });
  it("requires an RPC for every enabled chain", () => {
    expect(() => loadConfig({ ...BASE, CHAINS: "1,10" })).toThrow(/RPC_URL_10/);
    expect(loadConfig({ ...BASE, CHAINS: "8453" }).chains).toEqual([8453]);
  });
  it("validates slippage and allowlist", () => {
    expect(() => loadConfig({ ...BASE, DEFAULT_SLIPPAGE_BPS: "400" })).toThrow(/DEFAULT_SLIPPAGE_BPS/);
    expect(() => loadConfig({ ...BASE, MAX_SLIPPAGE_BPS: "0" })).toThrow(/MAX_SLIPPAGE_BPS/);
    expect([...loadConfig({ ...BASE, ALLOWED_USER_IDS: "1, 22" }).allowedUserIds]).toEqual([1, 22]);
    expect(() => loadConfig({ ...BASE, ALLOWED_USER_IDS: "abc" })).toThrow(/ALLOWED_USER_IDS/);
  });
});
