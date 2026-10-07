import { getAddress, isAddress, type Address } from "viem";

export const NATIVE: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const MAX_TOKENS_PER_SIDE = 6;
/** Infrared quotes build for 2 minutes; the Confirm button stops working before that so build + wallet prompt fit inside. */
export const MAX_QUOTE_AGE_MS = 90_000;

/** An error whose message is shown to the Telegram user as-is. */
export class ToolError extends Error {}

export interface BotConfig {
  telegramToken: string;
  walletConnectProjectId: string;
  apiUrl: string;
  apiKey: string;
  partnerFeeBps: number;
  partnerRecipient?: Address;
  partnerFeeOnOutput: boolean;
  /** Chains users may trade on; every one needs RPC_URL_<chain_id>. */
  chains: number[];
  rpcUrls: Map<number, string>;
  defaultSlippageBps: number;
  maxSlippageBps: number;
  /** Telegram user ids allowed to use the bot; empty = everyone. */
  allowedUserIds: Set<number>;
  dataDir: string;
  botName: string;
}

export const DEFAULTS = {
  apiUrl: "https://api.infraredtrading.com",
  chains: [1, 8453, 42161],
  defaultSlippageBps: 50,
  maxSlippageBps: 300,
  dataDir: "./data",
  botName: "Infrared Trading Bot",
};

export function loadConfig(env: Record<string, string | undefined>): BotConfig {
  const cfg: BotConfig = {
    telegramToken: required(env, "TELEGRAM_BOT_TOKEN"),
    walletConnectProjectId: required(env, "WALLETCONNECT_PROJECT_ID"),
    apiUrl: (env.INFRARED_API_URL || DEFAULTS.apiUrl).replace(/\/+$/, ""),
    apiKey: required(env, "INFRARED_API_KEY"),
    partnerFeeBps: integer(env.PARTNER_FEE_BPS, "PARTNER_FEE_BPS", 0, 0, 10_000),
    partnerFeeOnOutput: env.PARTNER_FEE_ON_OUTPUT === "true",
    chains: (env.CHAINS ? env.CHAINS.split(",") : DEFAULTS.chains.map(String)).map((s) => integer(s.trim(), "CHAINS", NaN, 1)),
    rpcUrls: new Map(),
    defaultSlippageBps: integer(env.DEFAULT_SLIPPAGE_BPS, "DEFAULT_SLIPPAGE_BPS", DEFAULTS.defaultSlippageBps, 0, 5000),
    maxSlippageBps: integer(env.MAX_SLIPPAGE_BPS, "MAX_SLIPPAGE_BPS", DEFAULTS.maxSlippageBps, 1, 5000),
    allowedUserIds: new Set((env.ALLOWED_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => integer(s, "ALLOWED_USER_IDS", NaN, 1))),
    dataDir: env.DATA_DIR || DEFAULTS.dataDir,
    botName: env.BOT_NAME || DEFAULTS.botName,
  };
  if (cfg.partnerFeeBps > 0) {
    const r = env.PARTNER_RECIPIENT;
    if (!r || !isAddress(r, { strict: false })) throw new ToolError("PARTNER_FEE_BPS > 0 requires PARTNER_RECIPIENT (the address that receives your fee)");
    cfg.partnerRecipient = getAddress(r);
  }
  if (cfg.defaultSlippageBps > cfg.maxSlippageBps) throw new ToolError("DEFAULT_SLIPPAGE_BPS must not exceed MAX_SLIPPAGE_BPS");
  if (cfg.chains.length === 0) throw new ToolError("CHAINS must list at least one chain id");
  for (const [k, v] of Object.entries(env)) {
    const m = /^RPC_URL_(\d+)$/.exec(k);
    if (!m || !v) continue;
    if (!/^https?:\/\/|^wss?:\/\//.test(v)) throw new ToolError(`${k} must be an http(s) or ws(s) URL`);
    cfg.rpcUrls.set(Number(m[1]), v);
  }
  for (const id of cfg.chains) if (!cfg.rpcUrls.has(id)) throw new ToolError(`chain ${id} is enabled but RPC_URL_${id} is not set`);
  return cfg;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (!v) throw new ToolError(`${name} is required`);
  return v;
}

function integer(raw: string | undefined, name: string, dflt: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined || raw === "") {
    if (Number.isNaN(dflt)) throw new ToolError(`${name} has an empty entry`);
    return dflt;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ToolError(`${name} must be an integer between ${min} and ${max}`);
  return n;
}
