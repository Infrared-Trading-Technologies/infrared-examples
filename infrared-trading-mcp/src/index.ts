#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, ToolError } from "./config.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

// stdout is the MCP channel: every log line goes to stderr.
async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ToolError) {
      console.error(`${SERVER_NAME}: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  const server = createServer(cfg);
  await server.connect(new StdioServerTransport());
  console.error(
    `${SERVER_NAME} ${SERVER_VERSION} ready: mode=${cfg.executeEnabled ? "LIVE" : "dry-run"} wallet=${cfg.privateKey ? "configured" : "none"} api_key=${cfg.apiKey ? "set" : "none"} rpc_chains=[${[...cfg.rpcUrls.keys()].join(",")}] max_notional_usd=${cfg.maxNotionalUsd} max_slippage_bps=${cfg.maxSlippageBps}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
