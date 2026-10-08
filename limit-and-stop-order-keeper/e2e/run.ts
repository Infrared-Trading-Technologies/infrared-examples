// End-to-end check: forks a real chain with anvil, funds a fresh keeper wallet, and runs the CLI pass by
// pass against the live Infrared API with orders whose triggers sit just past (or short of) the current
// executable price. Asserts on the state file and on the wallet's on-chain balances.
//
//   FORK_RPC_URL=<rpc for the chain> INFRARED_API_KEY=<key> npm run e2e -- --chain arbitrum
//
// Nothing here is mocked: quotes, builds and swaps are real, only the chain is a local fork.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createPublicClient, encodeAbiParameters, erc20Abi, formatUnits, http, keccak256, numberToHex, pad, parseEther, parseUnits, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { stringify } from "yaml";

interface Tokens {
  chainId: number;
  usdc: Address;
  weth: Address;
  btc: Address;
}

const CHAINS: Record<string, Tokens> = {
  base: { chainId: 8453, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", weth: "0x4200000000000000000000000000000000000006", btc: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" },
  ethereum: { chainId: 1, usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", btc: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" },
  arbitrum: { chainId: 42161, usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", btc: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" },
};

const API = process.env.INFRARED_API_URL || "https://api.infraredtrading.com";
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const READER = "0x000000000000000000000000000000000000dEaD" as Address;

interface OrderTick {
  id: string;
  status: string;
  action: string;
  reason?: string;
  price?: number;
  streak: number;
  tx_hash?: string;
}

let failures = 0;
function check(ok: boolean, name: string, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail.replace(/\s+/g, " ").slice(0, 200)})` : ""}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { chain: { type: "string", default: "arbitrum" }, port: { type: "string", default: "8552" } } });
  const t = CHAINS[values.chain!];
  if (!t) throw new Error(`unknown --chain ${values.chain}; one of ${Object.keys(CHAINS).join(", ")}`);
  const forkUrl = need("FORK_RPC_URL");
  const apiKey = need("INFRARED_API_KEY");
  const rpc = `http://127.0.0.1:${values.port}`;
  const anvil = await startAnvil(forkUrl, values.port!);
  try {
    const pub = createPublicClient({ transport: http(rpc) }) as PublicClient;
    const chainId = await pub.getChainId();
    if (chainId !== t.chainId) throw new Error(`FORK_RPC_URL is chain ${chainId}, expected ${t.chainId}`);
    await runScenarios(pub, rpc, apiKey, t);
  } finally {
    anvil.kill();
  }
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

async function runScenarios(pub: PublicClient, rpc: string, apiKey: string, t: Tokens): Promise<void> {
  const dec = { usdc: await decimals(pub, t.usdc), weth: await decimals(pub, t.weth) };
  const key = generatePrivateKey();
  const wallet = privateKeyToAccount(key).address;
  await anvilRpc(pub, "anvil_setBalance", [wallet, numberToHex(parseEther("1"))]);
  await fund(pub, t.weth, wallet, parseUnits("0.05", dec.weth));
  await fund(pub, t.usdc, wallet, parseUnits("200", dec.usdc));
  const env = { PRIVATE_KEY: key, [`RPC_URL_${t.chainId}`]: rpc, INFRARED_API_KEY: apiKey, INFRARED_API_URL: API };

  // The current executable price of WETH in USDC for the order size, from a real quote.
  const sellAmount = parseUnits("0.01", dec.weth);
  const P = await executablePrice(t, wallet, sellAmount);
  console.log(`executable price: 1 WETH = ${P.toFixed(2)} USDC`);
  const dir = mkdtempSync(join(tmpdir(), "keeper-e2e-"));
  const ordersPath = join(dir, "orders.yaml");
  const statePath = join(dir, "state.json");
  const weth = { token: t.weth };
  const usdc = { token: t.usdc };
  const round = (x: number) => Number(x.toFixed(6));
  writeFileSync(
    ordersPath,
    stringify({
      interval_seconds: 5,
      max_notional_usd: 500,
      gas_reserve_wei: "0",
      state_file: statePath,
      orders: [
        { id: "tp-fires", chain_id: t.chainId, type: "take_profit", sell: { ...weth, amount: "0.01" }, buy: usdc, trigger_price: round(P * 0.99), confirmations: 1, slippage_bps: 100 },
        { id: "stop-far", chain_id: t.chainId, type: "stop_loss", sell: { ...weth, amount: "0.01" }, buy: usdc, trigger_price: round(P * 0.9) },
        { id: "stop-near", chain_id: t.chainId, type: "stop_loss", sell: { ...weth, amount: "0.01" }, buy: usdc, trigger_price: round(P * 0.98) },
        { id: "limit-two-ticks", chain_id: t.chainId, type: "limit_buy", sell: { ...usdc, amount: "20" }, buy: weth, trigger_price: round(P * 1.01), confirmations: 2, slippage_bps: 100 },
        { id: "expired", chain_id: t.chainId, type: "take_profit", sell: { ...weth, amount: "0.01" }, buy: usdc, trigger_price: 1, expires: "2000-01-01T00:00:00Z" },
        { id: "capped", chain_id: t.chainId, type: "take_profit", sell: { ...weth, amount: "0.01" }, buy: usdc, trigger_price: round(P * 0.99), confirmations: 1, max_notional_usd: 1 },
        { id: "no-balance", chain_id: t.chainId, type: "stop_loss", sell: { token: t.btc, amount: "all" }, buy: usdc, trigger_price: 1_000_000_000 },
      ],
    }),
  );

  console.log("\n# pass 1: dry run");
  let nonce = await pub.getTransactionCount({ address: wallet });
  const t1 = tick(ordersPath, env, false);
  const by1 = Object.fromEntries(t1.orders.map((o) => [o.id, o]));
  check(by1["tp-fires"]?.action === "would_fill" && by1["tp-fires"].streak === 1, "take-profit past its trigger would fill in dry run", JSON.stringify(by1["tp-fires"]));
  check(by1["stop-far"]?.action === "watching" && /far from trigger/.test(by1["stop-far"].reason ?? ""), "stop 10% away is pre-filtered without quoting", by1["stop-far"]?.reason);
  check(by1["stop-near"]?.action === "watching" && /executable/.test(by1["stop-near"].reason ?? "") && (by1["stop-near"].price ?? 0) > P * 0.98, "stop 2% away is quoted and stays untriggered", by1["stop-near"]?.reason);
  check(by1["limit-two-ticks"]?.action === "armed" && by1["limit-two-ticks"].streak === 1, "limit buy needing 2 confirmations is armed after 1", JSON.stringify(by1["limit-two-ticks"]));
  check(by1["expired"]?.action === "expired" && by1["expired"].status === "expired", "expired order is marked expired");
  check(by1["capped"]?.action === "skipped" && /max_notional_usd/.test(by1["capped"].reason ?? ""), "order above its notional cap is skipped with the reason", by1["capped"]?.reason);
  check(by1["no-balance"]?.action === "skipped" && /insufficient balance/.test(by1["no-balance"].reason ?? ""), "order on an empty balance is skipped", by1["no-balance"]?.reason);
  check((await pub.getTransactionCount({ address: wallet })) === nonce, "dry run sent nothing");
  const s1 = JSON.parse(readFileSync(statePath, "utf8"));
  check(s1.orders["limit-two-ticks"]?.streak === 1 && s1.orders["expired"]?.status === "expired", "state file persisted streaks and statuses between passes");

  console.log("\n# pass 2: live");
  const before = await rawBalances(pub, wallet, [t.weth, t.usdc]);
  const t2 = tick(ordersPath, env, true);
  const by2 = Object.fromEntries(t2.orders.map((o) => [o.id, o]));
  check(by2["tp-fires"]?.action === "filled" && /^0x[0-9a-f]{64}$/i.test(by2["tp-fires"].tx_hash ?? ""), "take-profit fills with a transaction", JSON.stringify(by2["tp-fires"]));
  check(by2["limit-two-ticks"]?.action === "filled" && by2["limit-two-ticks"].streak === 2, "limit buy fills on its second confirmation", JSON.stringify(by2["limit-two-ticks"]));
  check(by2["stop-far"]?.action === "watching" && by2["stop-near"]?.action === "watching" && by2["capped"]?.action === "skipped", "untriggered, capped orders still do nothing live");
  const s2 = JSON.parse(readFileSync(statePath, "utf8"));
  const tpOut = parseUnits(s2.orders["tp-fires"].fill.amount_out, dec.usdc);
  const lbOut = parseUnits(s2.orders["limit-two-ticks"].fill.amount_out, dec.weth);
  const after = await rawBalances(pub, wallet, [t.weth, t.usdc]);
  check(after[0]! - before[0]! === lbOut - sellAmount, "WETH changed by exactly -0.01 (sold) + the limit buy's output", `${formatUnits(after[0]! - before[0]!, dec.weth)}`);
  check(after[1]! - before[1]! === tpOut - parseUnits("20", dec.usdc), "USDC changed by exactly +take-profit output - 20 (limit buy)", `${formatUnits(after[1]! - before[1]!, dec.usdc)}`);
  check(Number(formatUnits(tpOut, dec.usdc)) >= 0.01 * P * 0.98, "take-profit received at least the trigger price minus slippage", `${formatUnits(tpOut, dec.usdc)} USDC for 0.01 WETH`);
  const sent = (await pub.getTransactionCount({ address: wallet })) - nonce;
  check(sent === 4, "live pass sent exactly two approvals and two swaps", `${sent} txs`);
  check(s2.orders["tp-fires"].status === "filled" && s2.orders["limit-two-ticks"].status === "filled" && s2.orders["tp-fires"].fill.tx_hash === by2["tp-fires"]?.tx_hash, "state records both fills with their hashes");

  console.log("\n# pass 3: nothing refills");
  nonce = await pub.getTransactionCount({ address: wallet });
  const t3 = tick(ordersPath, env, true);
  const by3 = Object.fromEntries(t3.orders.map((o) => [o.id, o]));
  check(by3["tp-fires"]?.action === "done" && by3["limit-two-ticks"]?.action === "done", "filled orders are reported done and not re-evaluated");
  check((await pub.getTransactionCount({ address: wallet })) === nonce, "third pass sent nothing");

  console.log("\n# recovery");
  const s3 = JSON.parse(readFileSync(statePath, "utf8"));
  s3.orders["stop-near"] = { ...s3.orders["stop-near"], status: "filling", fill: { tx_hash: "0x" + "ab".repeat(32) } };
  writeFileSync(statePath, JSON.stringify(s3));
  const t4 = tick(ordersPath, env, true);
  const by4 = Object.fromEntries(t4.orders.map((o) => [o.id, o]));
  check(by4["stop-near"]?.action === "failed" && /interrupted mid-fill after broadcasting 0xabab/.test(by4["stop-near"].reason ?? ""), "an order left mid-fill by a crash is failed, never retried", by4["stop-near"]?.reason);
  check((await pub.getTransactionCount({ address: wallet })) === nonce, "recovery pass sent nothing");

  console.log("\n# guards");
  const noRpc = cli(["--orders", ordersPath, "--once"], { ...env, [`RPC_URL_${t.chainId}`]: "" });
  check(noRpc.code !== 0 && noRpc.stderr.includes(`RPC_URL_${t.chainId}`), "missing RPC aborts naming the variable");
  const badKeyOrders = join(dir, "orders-badkey.yaml");
  writeFileSync(badKeyOrders, stringify({ max_notional_usd: 500, state_file: join(dir, "state-badkey.json"), orders: [{ id: "tp-badkey", chain_id: t.chainId, type: "take_profit", sell: { ...weth, amount: "0.01" }, buy: usdc, trigger_price: round(P * 0.99), confirmations: 1, slippage_bps: 100 }] }));
  const badKey = tick(badKeyOrders, { ...env, INFRARED_API_KEY: "invalid-key-for-e2e" }, true);
  const bk = badKey.orders[0];
  check(bk?.status === "pending" && /INFRARED_API_KEY/.test(bk.reason ?? ""), "rejected API key fails the fill before any approval and names INFRARED_API_KEY", bk?.reason);
  check((await pub.getTransactionCount({ address: wallet })) === nonce, "no guard case sent a transaction");
}

// --- helpers ---------------------------------------------------------------

function tick(ordersPath: string, env: Record<string, string>, execute: boolean): { orders: OrderTick[] } {
  const r = cli(["--orders", ordersPath, "--once", "--json", ...(execute ? ["--execute"] : [])], env);
  if (r.code !== 0) throw new Error(`keeper pass failed (${r.code}): ${r.stderr}`);
  const line = r.stdout.trim().split("\n").find((l) => l.startsWith("{"));
  if (!line) throw new Error(`no JSON tick in output: ${r.stdout}`);
  return JSON.parse(line);
}

function cli(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 600_000 });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

async function executablePrice(t: Tokens, taker: Address, amountIn: bigint): Promise<number> {
  const res = await fetch(`${API}/v1/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs: [{ chain_id: t.chainId, address: t.weth, amount: amountIn.toString() }], outputs: [{ chain_id: t.chainId, address: t.usdc, ratio_bps: 10000 }], taker, slippage_tolerance_bps: 100 }),
  });
  const body = (await res.json()) as { data?: { estimated_outputs: { expected_amount: string }[] }; error?: unknown };
  if (!body.data) throw new Error(`reference quote failed: ${JSON.stringify(body.error)}`);
  return Number(formatUnits(BigInt(body.data.estimated_outputs[0]!.expected_amount), 6)) / Number(formatUnits(amountIn, 18));
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function startAnvil(forkUrl: string, port: string): Promise<ChildProcess> {
  const anvil = spawn("anvil", ["--fork-url", forkUrl, "--port", port, "--silent"], { stdio: "ignore" });
  const pub = createPublicClient({ transport: http(`http://127.0.0.1:${port}`) });
  for (let i = 0; i < 120; i++) {
    try {
      await pub.getChainId();
      return anvil;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  anvil.kill();
  throw new Error("anvil did not start (is foundry installed and FORK_RPC_URL reachable?)");
}

async function anvilRpc(pub: PublicClient, method: string, params: unknown[]): Promise<unknown> {
  return pub.request({ method: method as never, params: params as never });
}

async function decimals(pub: PublicClient, token: Address): Promise<number> {
  return Number(await pub.readContract({ account: READER, address: token, abi: erc20Abi, functionName: "decimals" }));
}

/** Sets an ERC-20 balance by locating the token's balance mapping slot (Solidity or Vyper layout). */
async function fund(pub: PublicClient, token: Address, owner: Address, amount: bigint): Promise<void> {
  const value = pad(numberToHex(amount), { size: 32 });
  for (let slot = 0n; slot < 64n; slot++) {
    for (const key of balanceSlotKeys(owner, slot)) {
      const prev = (await pub.getStorageAt({ address: token, slot: key })) ?? pad("0x0", { size: 32 });
      await anvilRpc(pub, "anvil_setStorageAt", [token, key, value]);
      const bal = await pub.readContract({ account: owner, address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
      if (bal === amount) return;
      await anvilRpc(pub, "anvil_setStorageAt", [token, key, prev]);
    }
  }
  throw new Error(`could not locate the balance slot of ${token}`);
}

function balanceSlotKeys(owner: Address, slot: bigint): Hex[] {
  return [
    keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, slot])),
    keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [slot, owner])),
  ];
}

async function rawBalances(pub: PublicClient, owner: Address, tokens: Address[]): Promise<bigint[]> {
  return Promise.all(tokens.map((t) => pub.readContract({ account: owner, address: t, abi: erc20Abi, functionName: "balanceOf", args: [owner] })));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
