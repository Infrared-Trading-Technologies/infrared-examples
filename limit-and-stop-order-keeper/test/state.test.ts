import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/state.js";

describe("StateStore", () => {
  it("starts orders pending, persists patches atomically and reloads them", () => {
    const path = join(mkdtempSync(join(tmpdir(), "keeper-state-")), "state.json");
    const s = new StateStore(path);
    expect(s.get("a")).toEqual({ status: "pending", streak: 0, failures: 0 });
    s.set("a", { streak: 1 });
    s.set("a", { status: "filled", fill: { tx_hash: "0xabc", approval_tx_hashes: [], at: "t", price: 1, amount_in: "1", amount_out: "2", notional_usd: 3 } });
    const again = new StateStore(path);
    expect(again.get("a").status).toBe("filled");
    expect(again.get("a").fill?.tx_hash).toBe("0xabc");
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
  });
});
