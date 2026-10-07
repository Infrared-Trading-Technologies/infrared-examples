import { MAX_TOKENS_PER_SIDE, ToolError } from "./config.js";

export interface ParsedTrade {
  inputs: { token: string; amount: string }[];
  outputs: { token: string; ratioBps: number }[];
}

export const USAGE = [
  "<amount> <token> to <token>",
  "50 USDC to WETH",
  "50 USDC to 60% WETH 40% cbBTC",
  "0.01 ETH + 20 USDC to WETH",
].join("\n");

const TOKEN = /^(0x[0-9a-fA-F]{40}|[A-Za-z0-9$._+-]{1,32})$/;
const AMOUNT = /^\d+(\.\d+)?$/;

/** Parses "50 USDC + 0.01 ETH to 60% WETH 40% cbBTC". Outputs without a percentage split the remainder equally. */
export function parseTrade(text: string): ParsedTrade {
  const cleaned = text.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  const m = /^(.+?)\s+(?:to|into|for|->|→)\s+(.+)$/i.exec(cleaned);
  if (!m) throw new ToolError(`could not parse the trade. Format:\n${USAGE}`);
  const inputs = (m[1] as string)
    .split(/\s*\+\s*|\s+and\s+/i)
    .map((part) => {
      const [amount, token, extra] = part.trim().split(" ");
      if (!amount || !token || extra || !AMOUNT.test(amount) || !TOKEN.test(token)) throw new ToolError(`bad input "${part.trim()}": expected "<amount> <token>" like "50 USDC"`);
      if (Number(amount) === 0) throw new ToolError(`amount of ${token} must be greater than zero`);
      return { token, amount };
    });
  if (inputs.length > MAX_TOKENS_PER_SIDE) throw new ToolError(`at most ${MAX_TOKENS_PER_SIDE} input tokens per trade`);

  const words = (m[2] as string).split(" ");
  const outputs: { token: string; ratioBps?: number }[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    const pct = /^(\d+(?:\.\d+)?)%$/.exec(w);
    if (pct) {
      const token = words[++i];
      if (!token || !TOKEN.test(token)) throw new ToolError(`expected a token after "${w}"`);
      const bps = Math.round(Number(pct[1]) * 100);
      if (bps < 1 || bps > 10000) throw new ToolError(`"${w}" is not a valid percentage`);
      outputs.push({ token, ratioBps: bps });
    } else if (TOKEN.test(w)) {
      outputs.push({ token: w });
    } else {
      throw new ToolError(`unexpected "${w}" in the outputs. Format:\n${USAGE}`);
    }
  }
  if (outputs.length === 0) throw new ToolError(`no output token given. Format:\n${USAGE}`);
  if (outputs.length > MAX_TOKENS_PER_SIDE) throw new ToolError(`at most ${MAX_TOKENS_PER_SIDE} output tokens per trade`);

  const fixed = outputs.filter((o) => o.ratioBps !== undefined).reduce((s, o) => s + (o.ratioBps as number), 0);
  const free = outputs.filter((o) => o.ratioBps === undefined);
  if (free.length > 0) {
    const remaining = 10000 - fixed;
    if (remaining < free.length) throw new ToolError("the percentages already add up to 100%, so the remaining tokens get nothing");
    const each = Math.floor(remaining / free.length);
    free.forEach((o, i) => (o.ratioBps = i === free.length - 1 ? remaining - each * (free.length - 1) : each));
  } else if (fixed !== 10000) {
    throw new ToolError(`output percentages must add up to 100%, got ${fixed / 100}%`);
  }
  const seen = new Set<string>();
  for (const o of [...inputs, ...outputs]) {
    const k = o.token.toLowerCase();
    if (seen.has(k)) throw new ToolError(`token ${o.token} appears twice`);
    seen.add(k);
  }
  return { inputs, outputs: outputs.map((o) => ({ token: o.token, ratioBps: o.ratioBps as number })) };
}
