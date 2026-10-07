import { MAX_QUOTE_AGE_MS, ToolError } from "./config.js";

export function checkSlippage(bps: number, max: number): void {
  if (!Number.isInteger(bps) || bps < 0) throw new ToolError("slippage_bps must be a non-negative integer");
  if (bps > max) throw new ToolError(`slippage_bps ${bps} exceeds this server's MAX_SLIPPAGE_BPS (${max})`);
}

export function checkNotional(usd: number | null, unpriced: string[], max: number): void {
  if (usd === null) {
    throw new ToolError(`refusing: no USD price for ${unpriced.join(", ")}, so the trade cannot be checked against MAX_NOTIONAL_USD (${max})`);
  }
  if (usd > max) throw new ToolError(`refusing: inputs are worth $${usd.toFixed(2)}, above MAX_NOTIONAL_USD ($${max})`);
}

export function checkQuoteFresh(createdAtMs: number, nowMs: number): void {
  const age = nowMs - createdAtMs;
  if (age > MAX_QUOTE_AGE_MS) {
    throw new ToolError(`quote is ${Math.round(age / 1000)}s old (limit ${MAX_QUOTE_AGE_MS / 1000}s); call get_quote again and use the new quote_id`);
  }
}

export function checkConfirmed(confirm: boolean | undefined, tool: string): void {
  if (confirm !== true) {
    throw new ToolError(`${tool} needs confirm=true. Show the user the quote (amounts, minimum outputs, USD value) and only confirm once they agree.`);
  }
}

export function checkTaker(quoteTaker: string, wallet: string): void {
  if (quoteTaker.toLowerCase() !== wallet.toLowerCase()) {
    throw new ToolError(`quote taker ${quoteTaker} is not this server's wallet ${wallet}; the Router requires the taker to be msg.sender. Re-quote with the wallet as taker.`);
  }
}
