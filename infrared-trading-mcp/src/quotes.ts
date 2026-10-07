import type { Address } from "viem";
import { ToolError } from "./config.js";
import type { Quote } from "./infrared.js";

export interface StoredQuote {
  quote: Quote;
  chainId: number;
  createdAt: number;
  slippageBps: number;
  notionalUsd: number | null;
  unpriced: string[];
  /** lower-cased token -> decimals, for every input and output token of the quote. */
  decimals: Map<string, number>;
  symbols: Map<string, string>;
  /** Set once execution starts; a quote is spent exactly once even though the API will build it again. */
  execution?: { startedAt: number; txHash?: string };
}

const RETENTION_MS = 10 * 60_000;

/** Quotes this server created. Execution only accepts quote_ids from here, so the agent cannot execute a quote it never inspected. */
export class QuoteStore {
  private readonly byId = new Map<string, StoredQuote>();

  constructor(private readonly now: () => number = Date.now) {}

  put(q: StoredQuote): void {
    this.prune();
    this.byId.set(q.quote.quote_id, q);
  }

  get(quoteId: string): StoredQuote {
    this.prune();
    const q = this.byId.get(quoteId);
    if (!q) throw new ToolError(`unknown quote_id ${quoteId}: only quotes created by this server's get_quote (within the last 10 minutes) can be built or executed`);
    return q;
  }

  private prune(): void {
    const cutoff = this.now() - RETENTION_MS;
    for (const [id, q] of this.byId) if (q.createdAt < cutoff) this.byId.delete(id);
  }
}

export function lower(a: Address | string): string {
  return a.toLowerCase();
}
