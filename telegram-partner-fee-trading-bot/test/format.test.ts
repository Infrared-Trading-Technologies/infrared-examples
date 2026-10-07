import { describe, expect, it } from "vitest";
import { esc, feeLine, pct, short } from "../src/format.js";
import { loadConfig } from "../src/config.js";

const BASE = { TELEGRAM_BOT_TOKEN: "t", WALLETCONNECT_PROJECT_ID: "p", INFRARED_API_KEY: "k", RPC_URL_1: "https://a", RPC_URL_8453: "https://b", RPC_URL_42161: "https://c" };

describe("format", () => {
  it("escapes HTML", () => {
    expect(esc("<b>&</b>")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
  });
  it("formats bps and addresses", () => {
    expect(pct(50)).toBe("0.5%");
    expect(pct(15)).toBe("0.15%");
    expect(pct(100)).toBe("1%");
    expect(short("0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7")).toBe("0x2Df1…3dF7");
  });
  it("discloses the partner fee", () => {
    expect(feeLine(loadConfig(BASE))).toMatch(/no fee/);
    const withFee = feeLine(loadConfig({ ...BASE, PARTNER_FEE_BPS: "50", PARTNER_RECIPIENT: "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7" }));
    expect(withFee).toContain("0.5% fee on the input");
    expect(withFee).toContain("0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7");
  });
});
