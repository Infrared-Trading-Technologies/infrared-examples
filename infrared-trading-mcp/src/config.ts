import type { Address, Hex } from "viem";

/** Canonical native-currency sentinel accepted by every Infrared endpoint. */
export const NATIVE: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const MAX_TOKENS_PER_SIDE = 6;
/** Infrared quotes build for 2 minutes; execution refuses anything older than this so build + send fit inside. */
export const MAX_QUOTE_AGE_MS = 90_000;

/** An error whose message is meant for the agent: returned as an MCP tool error, never as a protocol failure. */
export class ToolError extends Error {}

export interface ServerConfig {
  apiUrl: string;
  apiKey?: string;
  privateKey?: Hex;
  executeEnabled: boolean;
  maxNotionalUsd: number;
  maxSlippageBps: number;
  /** chain_id -> JSON-RPC URL, from RPC_URL_<chain_id>. */
  rpcUrls: Map<number, string>;
}

export const DEFAULTS = { apiUrl: "https://api.infraredtrading.com", maxNotionalUsd: 100, maxSlippageBps: 100 };

export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const cfg: ServerConfig = {
    apiUrl: (env.INFRARED_API_URL || DEFAULTS.apiUrl).replace(/\/+$/, ""),
    executeEnabled: env.EXECUTE_ENABLED === "true",
    maxNotionalUsd: positive(env.MAX_NOTIONAL_USD, "MAX_NOTIONAL_USD", DEFAULTS.maxNotionalUsd),
    maxSlippageBps: positive(env.MAX_SLIPPAGE_BPS, "MAX_SLIPPAGE_BPS", DEFAULTS.maxSlippageBps),
    rpcUrls: new Map(),
  };
  if (!Number.isInteger(cfg.maxSlippageBps) || cfg.maxSlippageBps > 5000) {
    throw new ToolError("MAX_SLIPPAGE_BPS must be an integer between 1 and 5000");
  }
  if (env.INFRARED_API_KEY) cfg.apiKey = env.INFRARED_API_KEY;
  if (env.PRIVATE_KEY) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(env.PRIVATE_KEY)) throw new ToolError("PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
    cfg.privateKey = env.PRIVATE_KEY as Hex;
  }
  for (const [k, v] of Object.entries(env)) {
    const m = /^RPC_URL_(\d+)$/.exec(k);
    if (!m || !v) continue;
    const id = Number(m[1]);
    if (!/^https?:\/\/|^wss?:\/\//.test(v)) throw new ToolError(`${k} must be an http(s) or ws(s) URL`);
    cfg.rpcUrls.set(id, v);
  }
  if (cfg.executeEnabled && !cfg.privateKey) throw new ToolError("EXECUTE_ENABLED=true requires PRIVATE_KEY");
  return cfg;
}

function positive(raw: string | undefined, name: string, dflt: number): number {
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ToolError(`${name} must be a positive number`);
  return n;
}
