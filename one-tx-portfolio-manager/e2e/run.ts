// End-to-end check: forks a real chain with anvil, funds a fresh wallet, runs the
// bot CLI against the live Infrared API, and asserts on the wallet's on-chain state.
//
//   FORK_RPC_URL=<rpc for the chain> INFRARED_API_KEY=<key> npm run e2e -- --chain arbitrum
//
// Nothing here is mocked: quotes, builds and swaps are real, only the chain is a local fork.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  createPublicClient,
  encodeAbiParameters,
  erc20Abi,
  formatUnits,
  http,
  keccak256,
  numberToHex,
  pad,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { stringify } from "yaml";

interface Tokens {
  chainId: number;
  usdc: Address;
  weth: Address;
  btc: Address;
}

const CHAINS: Record<string, Tokens> = {
  base: {
    chainId: 8453,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    weth: "0x4200000000000000000000000000000000000006",
    btc: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  },
  ethereum: {
    chainId: 1,
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    btc: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  },
  arbitrum: {
    chainId: 42161,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    btc: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
  },
};

const API = process.env.INFRARED_API_URL || "https://api.infraredtrading.com";
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const TOLERANCE_BPS = 100;
// Caller for view reads; some proxy tokens reject calls from the zero address.
const READER = "0x000000000000000000000000000000000000dEaD" as Address;

let failures = 0;
let forkRpcUrl = "";
function check(ok: boolean, name: string, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { chain: { type: "string", default: "arbitrum" }, port: { type: "string", default: "8547" } } });
  const t = CHAINS[values.chain!];
  if (!t) throw new Error(`unknown --chain ${values.chain}; one of ${Object.keys(CHAINS).join(", ")}`);
  const forkUrl = need("FORK_RPC_URL");
  const apiKey = need("INFRARED_API_KEY");

  forkRpcUrl = forkUrl;
  const rpc = `http://127.0.0.1:${values.port}`;
  const anvil = await startAnvil(forkUrl, values.port!);
  try {
    const pub = createPublicClient({ transport: http(rpc) }) as PublicClient;
    const chainId = await pub.getChainId();
    if (chainId !== t.chainId) throw new Error(`FORK_RPC_URL is chain ${chainId}, expected ${t.chainId} for --chain ${values.chain}`);
    await runScenarios(pub, rpc, apiKey, t);
  } finally {
    anvil.kill();
  }
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

async function runScenarios(pub: PublicClient, rpc: string, apiKey: string, t: Tokens): Promise<void> {
  const prices = await fetchPrices(t.chainId, [t.usdc, t.weth, t.btc]);
  const dec = { usdc: await decimals(pub, t.usdc), weth: await decimals(pub, t.weth), btc: await decimals(pub, t.btc) };
  const units = (usd: number, token: Address, d: number) => parseUnits((usd / prices.get(token.toLowerCase())!).toFixed(d), d);

  const key = generatePrivateKey();
  const wallet = privateKeyToAccount(key).address;
  await anvilRpc(pub, "anvil_setBalance", [wallet, numberToHex(parseEther("1"))]);
  const env = { PRIVATE_KEY: key, RPC_URL: rpc, INFRARED_API_KEY: apiKey, INFRARED_API_URL: API };
  const common = { chain_id: t.chainId, slippage_bps: 100, max_notional_usd: 5000, gas_reserve_wei: "0" };

  // Rebalance: $700 USDC + $300 WETH -> 40% USDC / 30% WETH / 30% BTC.
  await fund(pub, t.usdc, wallet, units(700, t.usdc, dec.usdc));
  await fund(pub, t.weth, wallet, units(300, t.weth, dec.weth));
  const targets = [
    { token: t.usdc, weight_bps: 4000 },
    { token: t.weth, weight_bps: 3000 },
    { token: t.btc, weight_bps: 3000 },
  ];
  const rebalanceCfg = writeConfig({ ...common, rebalance: { targets, drift_threshold_bps: 150 } });

  let nonce = await pub.getTransactionCount({ address: wallet });
  const dry = cli(["rebalance", "--config", rebalanceCfg, "--json"], env);
  check(dry.code === 0, "rebalance dry-run exits 0", dry.stderr.trim());
  check((await pub.getTransactionCount({ address: wallet })) === nonce, "rebalance dry-run sends nothing");
  const dryPlan = dry.code === 0 ? JSON.parse(dry.stdout) : null;
  check(dryPlan?.inputs?.length >= 1 && dryPlan?.outputs?.length >= 1, "dry-run plan has inputs and outputs");

  const exec = cli(["rebalance", "--config", rebalanceCfg, "--execute", "--json"], env);
  check(exec.code === 0, "rebalance --execute exits 0", exec.stderr.trim());
  const sent = (await pub.getTransactionCount({ address: wallet })) - nonce;
  const approvals = exec.code === 0 ? JSON.parse(exec.stdout).approval_tx_hashes.length : 0;
  check(sent - approvals === 1, "rebalance settles in exactly one swap transaction", `${sent} txs sent, ${approvals} approvals`);

  const after = await balancesUsd(pub, wallet, [t.usdc, t.weth, t.btc], prices);
  const total = after.reduce((a, b) => a + b, 0);
  targets.forEach((tg, i) => {
    const w = ((after[i] ?? 0) / total) * 10000;
    check(Math.abs(w - tg.weight_bps) <= TOLERANCE_BPS, `rebalanced weight of ${tg.token} within ${TOLERANCE_BPS} bps`, `${w.toFixed(0)} vs ${tg.weight_bps}`);
  });

  if (exec.code === 0 && dryPlan) {
    const execPlan = JSON.parse(exec.stdout);
    for (const o of dryPlan.outputs as { token: Address; expected_amount: string }[]) {
      const e = (execPlan.outputs as { token: Address; expected_amount: string }[]).find((x) => x.token === o.token);
      const diff = e ? Math.abs(Number(e.expected_amount) / Number(o.expected_amount) - 1) * 10000 : Infinity;
      check(diff <= common.slippage_bps, `dry-run quote for ${o.token} matches execute within slippage`, `${diff.toFixed(1)} bps`);
    }
  }

  nonce = await pub.getTransactionCount({ address: wallet });
  const again = cli(["rebalance", "--config", rebalanceCfg, "--json"], env);
  const againPlan = again.code === 0 ? JSON.parse(again.stdout) : null;
  check(again.code === 0 && againPlan.inputs.length === 0, "second rebalance plans no trade");
  cli(["rebalance", "--config", rebalanceCfg, "--execute"], env);
  check((await pub.getTransactionCount({ address: wallet })) === nonce, "second rebalance --execute sends nothing");

  // Prod quotes the live chain; re-fork at the latest block so the fork does not drift behind it.
  await refork(pub, wallet);
  await fund(pub, t.usdc, wallet, units(200, t.usdc, dec.usdc));

  // DCA: exactly $50 of USDC -> 60% WETH / 40% BTC.
  const dcaAmount = units(50, t.usdc, dec.usdc);
  const dcaCfg = writeConfig({
    ...common,
    dca: { input: { token: t.usdc, amount: dcaAmount.toString() }, outputs: [{ token: t.weth, ratio_bps: 6000 }, { token: t.btc, ratio_bps: 4000 }] },
  });
  const beforeDca = await rawBalances(pub, wallet, [t.usdc, t.weth, t.btc]);
  const dca = cli(["dca", "--config", dcaCfg, "--execute"], env);
  check(dca.code === 0, "dca --execute exits 0", dca.stderr.trim());
  const afterDca = await rawBalances(pub, wallet, [t.usdc, t.weth, t.btc]);
  check(beforeDca[0]! - afterDca[0]! === dcaAmount, "dca spends exactly the configured input amount");
  const gotWeth = Number(formatUnits(afterDca[1]! - beforeDca[1]!, dec.weth)) * prices.get(t.weth.toLowerCase())!;
  const gotBtc = Number(formatUnits(afterDca[2]! - beforeDca[2]!, dec.btc)) * prices.get(t.btc.toLowerCase())!;
  const wethShare = (gotWeth / (gotWeth + gotBtc)) * 10000;
  check(Math.abs(wethShare - 6000) <= TOLERANCE_BPS, "dca output split matches ratios", `WETH share ${wethShare.toFixed(0)} bps`);

  await refork(pub, wallet);
  await fund(pub, t.usdc, wallet, units(150, t.usdc, dec.usdc));
  await fund(pub, t.btc, wallet, units(150, t.btc, dec.btc));

  // Sweep: USDC + BTC + a fork-only token with no route -> WETH.
  const unroutable = await cloneToken(pub, t.weth);
  await fund(pub, unroutable, wallet, parseUnits("5", 18));
  const sweepCfg = writeConfig({ ...common, sweep: { inputs: [t.usdc, t.btc, unroutable], output: t.weth } });
  const wethBefore = (await rawBalances(pub, wallet, [t.weth]))[0]!;
  const sweep = cli(["sweep", "--config", sweepCfg, "--execute", "--json"], env);
  check(sweep.code === 0, "sweep --execute exits 0", sweep.stderr.trim());
  const [usdcLeft, btcLeft, junkLeft, wethAfter] = await rawBalances(pub, wallet, [t.usdc, t.btc, unroutable, t.weth]);
  check(usdcLeft === 0n && btcLeft === 0n, "sweep zeroes every routable input", `usdc ${usdcLeft}, btc ${btcLeft}`);
  check(junkLeft === parseUnits("5", 18), "sweep leaves the unroutable token untouched");
  check(sweep.stdout.toLowerCase().includes(unroutable.toLowerCase()), "sweep reports the unroutable token");
  check(wethAfter! > wethBefore, "sweep output balance increased");

  // Guards: each must fail loudly and send nothing.
  await fund(pub, t.usdc, wallet, units(200, t.usdc, dec.usdc));
  nonce = await pub.getTransactionCount({ address: wallet });
  const capCfg = writeConfig({ ...common, max_notional_usd: 1, dca: { input: { token: t.usdc, amount: dcaAmount.toString() }, outputs: [{ token: t.weth, ratio_bps: 10000 }] } });
  const cap = cli(["dca", "--config", capCfg, "--execute"], env);
  check(cap.code !== 0 && cap.stderr.includes("max_notional_usd"), "max-notional cap refuses the trade");

  const eoa = privateKeyToAccount(generatePrivateKey()).address;
  const decCfg = writeConfig({ ...common, dca: { input: { token: t.usdc, amount: "1000" }, outputs: [{ token: eoa, ratio_bps: 10000 }] } });
  const badDec = cli(["dca", "--config", decCfg, "--execute"], env);
  check(badDec.code !== 0 && badDec.stderr.toLowerCase().includes(eoa.toLowerCase()), "unreadable decimals() aborts naming the token");

  const okDca = writeConfig({ ...common, dca: { input: { token: t.usdc, amount: "1000000" }, outputs: [{ token: t.weth, ratio_bps: 10000 }] } });
  const noKey = cli(["dca", "--config", okDca, "--execute"], { ...env, INFRARED_API_KEY: "" });
  check(noKey.code !== 0 && noKey.stderr.includes("INFRARED_API_KEY"), "missing API key aborts naming INFRARED_API_KEY");
  const badKey = cli(["dca", "--config", okDca, "--execute"], { ...env, INFRARED_API_KEY: "invalid-key-for-e2e" });
  check(badKey.code !== 0 && badKey.stderr.includes("INFRARED_API_KEY"), "rejected API key aborts naming INFRARED_API_KEY");
  check((await pub.getTransactionCount({ address: wallet })) === nonce, "no guard case sent a transaction");
}

// --- helpers ---------------------------------------------------------------

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function cli(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 300_000 });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function writeConfig(cfg: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "one-tx-pm-e2e-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, stringify(cfg));
  return path;
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

// EIP-1967 proxy slots: implementation and admin.
const PROXY_SLOTS: Hex[] = [
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
];

/** Deploys a fork-only copy of an existing ERC-20 at a fresh address: a real token the live API has never seen. */
async function cloneToken(pub: PublicClient, source: Address): Promise<Address> {
  const addr = privateKeyToAccount(generatePrivateKey()).address;
  const code = await pub.getCode({ address: source });
  if (!code || code === "0x") throw new Error(`no code at ${source}`);
  await anvilRpc(pub, "anvil_setCode", [addr, code]);
  // If the source is an upgradeable proxy, point the clone at the same implementation and admin.
  for (const slot of PROXY_SLOTS) {
    const v = await pub.getStorageAt({ address: source, slot });
    if (v && BigInt(v) !== 0n) await anvilRpc(pub, "anvil_setStorageAt", [addr, slot, v]);
  }
  return addr;
}

async function rawBalances(pub: PublicClient, owner: Address, tokens: Address[]): Promise<bigint[]> {
  return Promise.all(tokens.map((t) => pub.readContract({ account: owner, address: t, abi: erc20Abi, functionName: "balanceOf", args: [owner] })));
}

async function balancesUsd(pub: PublicClient, owner: Address, tokens: Address[], prices: Map<string, number>): Promise<number[]> {
  const bals = await rawBalances(pub, owner, tokens);
  return Promise.all(tokens.map(async (t, i) => Number(formatUnits(bals[i]!, await decimals(pub, t))) * prices.get(t.toLowerCase())!));
}

async function fetchPrices(chainId: number, tokens: Address[]): Promise<Map<string, number>> {
  const res = await fetch(`${API}/v1/prices?chain_id=${chainId}&addresses=${tokens.join(",")}`);
  const body = (await res.json()) as { data: { prices: Record<string, number> } };
  const out = new Map(Object.entries(body.data.prices).map(([k, v]) => [k.toLowerCase(), v]));
  for (const t of tokens) if (!out.has(t.toLowerCase())) throw new Error(`no price for ${t}`);
  return out;
}

/** Re-forks at the latest block and re-funds the wallet with gas. */
async function refork(pub: PublicClient, wallet: Address): Promise<void> {
  await anvilRpc(pub, "anvil_reset", [{ forking: { jsonRpcUrl: forkRpcUrl } }]);
  await anvilRpc(pub, "anvil_setBalance", [wallet, numberToHex(parseEther("1"))]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
