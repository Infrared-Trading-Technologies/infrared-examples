#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ChainClients } from "./chain.js";
import { BotError, loadConfig } from "./config.js";
import { InfraredClient } from "./infrared.js";
import { Keeper, type Tick } from "./keeper.js";
import { StateStore } from "./state.js";

const DEFAULT_API_URL = "https://api.infraredtrading.com";
const USAGE = `usage: limit-and-stop-order-keeper [--orders orders.yaml] [--execute] [--once] [--json]

Watches every order in the file and fills it at the executable Infrared price once its trigger holds.
Dry-run by default: prints what it would do, sends nothing. --execute signs and sends. --once runs a single pass.

env:
  PRIVATE_KEY         key of a DEDICATED keeper wallet (never your main wallet)
  RPC_URL_<chain_id>  JSON-RPC endpoint per chain used by your orders (e.g. RPC_URL_42161)
  INFRARED_API_KEY    Infrared API key
  INFRARED_API_URL    optional, defaults to ${DEFAULT_API_URL}
  ORDERS              optional orders path (same as --orders)`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      orders: { type: "string" },
      execute: { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const cfg = loadConfig(values.orders ?? process.env.ORDERS ?? "orders.yaml");
  const rpcUrls = new Map<number, string>();
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^RPC_URL_(\d+)$/.exec(k);
    if (m && v) rpcUrls.set(Number(m[1]), v);
  }
  for (const o of cfg.orders) if (!rpcUrls.has(o.chain_id)) throw new BotError(`order ${o.id} uses chain ${o.chain_id} but RPC_URL_${o.chain_id} is not set`);
  const api = new InfraredClient(process.env.INFRARED_API_URL || DEFAULT_API_URL, requireEnv("INFRARED_API_KEY"));
  const state = new StateStore(cfg.state_file);
  let keeper: Keeper;
  const chains = new ChainClients(rpcUrls, requireEnv("PRIVATE_KEY"), (id) => keeper.chainInfo(id));
  keeper = new Keeper({ cfg, api, chains, state, execute: values.execute });

  let stopping = false;
  const stop = () => {
    stopping = true;
    console.error("stopping after the current pass");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.error(`keeper: ${cfg.orders.length} order(s), wallet ${chains.account.address}, ${values.execute ? "LIVE" : "dry-run"}, every ${cfg.interval_seconds}s, state ${cfg.state_file}`);
  for (;;) {
    const tick = await keeper.tick();
    if (values.json) console.log(JSON.stringify(tick));
    else printTick(tick);
    const open = tick.orders.some((o) => o.status === "pending" || o.status === "filling");
    if (values.once || stopping) break;
    if (!open) {
      console.error("no open orders left; exiting");
      break;
    }
    await sleep(cfg.interval_seconds * 1000);
  }
}

function printTick(t: Tick): void {
  console.log(`${t.at} ${t.execute ? "live" : "dry-run"}`);
  for (const o of t.orders) {
    const px = o.price === undefined ? "" : ` price ${o.price >= 1000 ? o.price.toFixed(2) : o.price.toPrecision(6)}`;
    const tx = o.tx_hash ? ` tx ${o.tx_hash}` : "";
    console.log(`  [${o.id}] ${o.action.padEnd(10)} ${o.describe}${px}${o.reason ? ` -- ${o.reason}` : ""}${tx}`);
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new BotError(`${name} is not set`);
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err: unknown) => {
  if (err instanceof BotError) console.error(`error: ${err.message}`);
  else console.error(err);
  process.exit(1);
});
