#!/usr/bin/env node
import { parseArgs } from "node:util";
import { BotError, loadConfig } from "./config.js";
import { connect } from "./chain.js";
import { DEFAULT_API_URL, InfraredClient } from "./infrared.js";
import { run, type Mode, type Plan } from "./run.js";

const USAGE = `usage: one-tx-portfolio-manager <rebalance|dca|sweep> [--config config.yaml] [--execute] [--json]

Dry-run by default: quotes and prints the plan, sends nothing. --execute signs and sends.

env:
  PRIVATE_KEY       key of a DEDICATED bot wallet (never your main wallet)
  RPC_URL           JSON-RPC endpoint for the config's chain_id
  INFRARED_API_KEY  Infrared API key
  INFRARED_API_URL  optional, defaults to ${DEFAULT_API_URL}
  CONFIG            optional config path (same as --config)`;

const MODES: Mode[] = ["rebalance", "dca", "sweep"];

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      execute: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const mode = MODES.find((m) => m === positionals[0]);
  if (values.help || !mode || positionals.length > 1) {
    console.error(USAGE);
    process.exit(values.help ? 0 : 2);
  }

  const cfg = loadConfig(values.config ?? process.env.CONFIG ?? "config.yaml");
  const apiKey = requireEnv("INFRARED_API_KEY");
  const wallet = await connect(cfg.chain_id, requireEnv("RPC_URL"), requireEnv("PRIVATE_KEY"));
  const api = new InfraredClient(apiKey, process.env.INFRARED_API_URL || DEFAULT_API_URL);

  const plan = await run(mode, { cfg, wallet, api, execute: values.execute });
  if (values.json) console.log(JSON.stringify(plan, null, 2));
  else printPlan(plan, wallet.account.address);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new BotError(`${name} is not set`);
  return v;
}

function printPlan(p: Plan, wallet: string): void {
  console.log(`${p.mode} on chain ${p.chain_id} for ${wallet}`);
  for (const s of p.skipped) console.log(`  skipped ${s.token}: ${s.reason}`);
  if (p.inputs.length === 0) {
    console.log(`  no trade: ${p.note ?? "nothing to do"}`);
    return;
  }
  for (const i of p.inputs) console.log(`  sell ${i.amount} of ${i.token}`);
  for (const o of p.outputs) {
    console.log(`  buy  ${o.token} (${(o.ratio_bps / 100).toFixed(2)}%): expect ${o.expected_amount}, min ${o.min_amount}`);
  }
  if (p.notional_usd !== null) console.log(`  notional ~$${p.notional_usd.toFixed(2)}`);
  if (!p.executed) {
    console.log("  dry run: nothing sent (pass --execute to trade)");
    return;
  }
  for (const h of p.approval_tx_hashes) console.log(`  approve tx ${h}`);
  console.log(`  swap tx ${p.tx_hash} (one transaction)`);
}

main().catch((err: unknown) => {
  if (err instanceof BotError) {
    console.error(`error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
