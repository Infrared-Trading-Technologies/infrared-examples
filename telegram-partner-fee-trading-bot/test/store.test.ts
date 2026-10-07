import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UserStore } from "../src/store.js";

describe("UserStore", () => {
  it("creates defaults, persists updates and clears undefined fields", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tg-bot-store-")), "users.json");
    const s = new UserStore(path, { chainId: 8453, slippageBps: 50 });
    expect(s.get(7)).toEqual({ chainId: 8453, slippageBps: 50 });
    s.update(7, { wcTopic: "abc", address: "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7" });
    s.update(7, { chainId: 1 });
    const reloaded = new UserStore(path, { chainId: 8453, slippageBps: 50 });
    expect(reloaded.get(7)).toEqual({ chainId: 1, slippageBps: 50, wcTopic: "abc", address: "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7" });
    reloaded.update(7, { wcTopic: undefined, address: undefined });
    expect(JSON.parse(readFileSync(path, "utf8"))["7"]).toEqual({ chainId: 1, slippageBps: 50 });
    expect(reloaded.all().map(([id]) => id)).toEqual([7]);
  });
});
