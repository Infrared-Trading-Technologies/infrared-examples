import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Hex } from "viem";

export type OrderStatus = "pending" | "filling" | "filled" | "expired" | "failed";

export interface OrderState {
  status: OrderStatus;
  /** Consecutive ticks the trigger condition has held. */
  streak: number;
  last_checked?: string;
  last_price?: number;
  last_reason?: string;
  failures: number;
  fill?: { tx_hash: Hex; approval_tx_hashes: Hex[]; at: string; price: number; amount_in: string; amount_out: string; notional_usd: number | null };
}

interface StateFile {
  version: 1;
  orders: Record<string, OrderState>;
}

/** Fill-once memory for every order, persisted atomically after each change. Losing it means an order could fill again. */
export class StateStore {
  private data: StateFile = { version: 1, orders: {} };

  constructor(private readonly path: string) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as StateFile;
      if (parsed.version !== 1 || typeof parsed.orders !== "object") throw new Error("unrecognized state file format");
      this.data = parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  get(id: string): OrderState {
    let s = this.data.orders[id];
    if (!s) {
      s = { status: "pending", streak: 0, failures: 0 };
      this.data.orders[id] = s;
    }
    return s;
  }

  set(id: string, patch: Partial<OrderState>): OrderState {
    const next = { ...this.get(id), ...patch };
    this.data.orders[id] = next;
    this.flush();
    return next;
  }

  all(): Record<string, OrderState> {
    return this.data.orders;
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}
