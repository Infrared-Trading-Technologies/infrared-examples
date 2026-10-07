// End-to-end check: forks a real chain with anvil, funds a fresh wallet, starts the MCP server over
// stdio in three configurations (read-only, dry-run, live) and drives it with the MCP client SDK
// against the live Infrared API, asserting on the wallet's on-chain state.
//
//   FORK_RPC_URL=<rpc for the chain> INFRARED_API_KEY=<key> npm run e2e -- --chain arbitrum
//
// Nothing here is mocked: quotes, builds and swaps are real, only the chain is a local fork.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, type ChildProcess } from "node:child_process";
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
const SERVER = new URL("../dist/index.js", import.meta.url).pathname;
const TOLERANCE_BPS = 100;
const READER = "0x000000000000000000000000000000000000dEaD" as Address;

let failures = 0;
let forkRpcUrl = "";
function check(ok: boolean, name: string, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

type ToolResult = { ok: boolean; text: string; json: Record<string, unknown> | null };

/** One MCP server process plus a connected client. */
class Server {
  readonly client: Client;
  private readonly transport: StdioClientTransport;

  private constructor(client: Client, transport: StdioClientTransport) {
    this.client = client;
    this.transport = transport;
  }

  static async start(env: Record<string, string>): Promise<Server> {
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { PATH: process.env.PATH ?? "", ...env }, stderr: "inherit" });
    const client = new Client({ name: "infrared-trading-mcp-e2e", version: "0" });
    await client.connect(transport);
    return new Server(client, transport);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const r = await this.client.callTool({ name, arguments: args });
    const content = r.content as { type: string; text?: string }[];
    const text = content.find((c) => c.type === "text")?.text ?? "";
    let json: Record<string, unknown> | null = null;
    if (!r.isError) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { ok: !r.isError, text, json };
  }

  async close(): Promise<void> {
    await this.client.close();
    await this.transport.close();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { chain: { type: "string", default: "arbitrum" }, port: { type: "string", default: "8548" } } });
  const t = CHAINS[values.chain!];
  if (!t) throw new Error(`unknown --chain ${values.chain}; one of ${Object.keys(CHAINS).join(", ")}`);
  forkRpcUrl = need("FORK_RPC_URL");
  const apiKey = need("INFRARED_API_KEY");
  const rpc = `http://127.0.0.1:${values.port}`;
  const anvil = await startAnvil(forkRpcUrl, values.port!);
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
  const key = generatePrivateKey();
  const wallet = privateKeyToAccount(key).address;
  const rpcEnv = { [`RPC_URL_${t.chainId}`]: rpc, INFRARED_API_URL: API };
  await anvilRpc(pub, "anvil_setBalance", [wallet, numberToHex(parseEther("1"))]);
  await fund(pub, t.usdc, wallet, parseUnits("200", dec.usdc));
  const quoteArgs = (usdc: string) => ({
    chain_id: t.chainId,
    inputs: [{ token: "USDC", amount: usdc }],
    outputs: [
      { token: t.weth, ratio_bps: 6000 },
      { token: t.btc, ratio_bps: 4000 },
    ],
  });

  // --- Read-only server: no key, no wallet. Quotes work, build and execute say exactly what is missing.
  console.log("\n# read-only server");
  let s = await Server.start(rpcEnv);
  try {
    const tools = (await s.client.listTools()).tools.map((x) => x.name).sort();
    check(["execute_trade", "get_quote", "build_transaction", "get_balances"].every((n) => tools.includes(n)), "server exposes the trading tools", tools.join(","));
    const status = await s.call("get_wallet_status");
    check(status.ok && status.json?.wallet_address === null && status.json?.execute_enabled === false, "read-only status has no wallet and execution off");
    const chains = await s.call("list_chains");
    check(chains.ok && (chains.json as unknown as { chain_id: number }[]).some((c) => c.chain_id === t.chainId), "list_chains includes the test chain");
    const search = await s.call("search_tokens", { chain_id: t.chainId, query: "USDC", limit: 5 });
    check(search.ok && JSON.stringify(search.json).toLowerCase().includes(t.usdc.toLowerCase()), "search_tokens finds USDC");
    const px = await s.call("get_prices", { chain_id: t.chainId, tokens: ["USDC", "ETH", t.btc] });
    check(px.ok && (px.json as unknown as { price_usd: number | null }[]).every((p) => typeof p.price_usd === "number"), "get_prices resolves symbols and prices every token", px.text.slice(0, 200));
    const bal = await s.call("get_balances", { chain_id: t.chainId, owner: wallet, tokens: ["USDC", "ETH"] });
    const usdcBal = (bal.json?.balances as { token: string; balance: string }[] | undefined)?.find((b) => b.token.toLowerCase() === t.usdc.toLowerCase());
    const ethBal = (bal.json?.balances as { input: string; balance: string; usd: number | null }[] | undefined)?.find((b) => b.input === "ETH");
    check(bal.ok && usdcBal?.balance === "200", "get_balances reads the funded USDC on the fork", bal.text.slice(0, 200));
    check(ethBal?.balance === "1" && typeof ethBal.usd === "number", "get_balances prices the native currency", JSON.stringify(ethBal));
    const noTaker = await s.call("get_quote", quoteArgs("50"));
    check(!noTaker.ok && noTaker.text.includes("taker"), "get_quote without a wallet asks for taker");
    const q = await s.call("get_quote", { ...quoteArgs("50"), taker: wallet });
    check(q.ok && typeof q.json?.quote_id === "string", "anonymous get_quote returns a quote", q.text.slice(0, 300));
    const outs = (q.json?.outputs as { token: string; expected_amount: string; minimum_amount: string }[] | undefined) ?? [];
    check(outs.length === 2 && outs.every((o) => Number(o.expected_amount) > 0 && Number(o.minimum_amount) <= Number(o.expected_amount)), "quote has two priced outputs with minimum <= expected");
    check(Math.abs(Number(q.json?.notional_usd) - 50) < 2, "quote notional is about $50", String(q.json?.notional_usd));
    check(((q.json?.approvals_needed as unknown[]) ?? []).length === 1, "quote reports the USDC approval the taker still needs");
    const b = await s.call("build_transaction", { quote_id: q.json?.quote_id });
    check(!b.ok && b.text.includes("INFRARED_API_KEY"), "build without an API key names INFRARED_API_KEY");
    const x = await s.call("execute_trade", { quote_id: q.json?.quote_id, confirm: true });
    check(!x.ok && x.text.includes("PRIVATE_KEY"), "execute without a wallet names PRIVATE_KEY");
  } finally {
    await s.close();
  }

  // --- Dry-run server: wallet + key, EXECUTE_ENABLED unset. Everything runs through pre-flight; nothing is sent.
  console.log("\n# dry-run server");
  let nonce = await pub.getTransactionCount({ address: wallet });
  s = await Server.start({ ...rpcEnv, PRIVATE_KEY: key, INFRARED_API_KEY: apiKey });
  try {
    const status = await s.call("get_wallet_status");
    check(status.ok && (status.json?.wallet_address as string).toLowerCase() === wallet.toLowerCase() && status.json?.execute_enabled === false, "dry-run status shows the wallet with execution off");
    const q = await s.call("get_quote", quoteArgs("50"));
    check(q.ok && (q.json?.taker as string).toLowerCase() === wallet.toLowerCase(), "get_quote defaults taker to the wallet");
    check(((q.json?.warnings as string[]) ?? []).some((w) => w.includes("EXECUTE_ENABLED")), "quote warns that execution is a dry-run");
    const b = await s.call("build_transaction", { quote_id: q.json?.quote_id });
    const tx = b.json?.transaction as { to: string; data: string; gas: number; chain_id: number } | undefined;
    check(b.ok && tx?.data?.startsWith("0x") && tx.chain_id === t.chainId && tx.gas > 0, "build_transaction returns an unsigned Router transaction", b.text.slice(0, 200));
    const pf = b.json?.preflight as { ok: boolean | null } | undefined;
    check(pf?.ok === false && String(b.json?.note).includes("approval"), "pre-flight reverts before approval and the note says why");
    const unconfirmed = await s.call("execute_trade", { quote_id: q.json?.quote_id });
    check(!unconfirmed.ok && unconfirmed.text.includes("confirm=true"), "execute without confirm is refused");
    const dry = await s.call("execute_trade", { quote_id: q.json?.quote_id, confirm: true });
    check(dry.ok && dry.json?.dry_run === true && dry.json?.sent === false && (dry.json?.would_send as { to?: string })?.to !== undefined, "confirmed execute is a dry-run that returns the would-be transaction", dry.text.slice(0, 200));
    check(((dry.json?.would_approve as unknown[]) ?? []).length === 1, "dry-run lists the approval it would send");

    const big = await s.call("get_quote", quoteArgs("150"));
    check(big.ok && ((big.json?.warnings as string[]) ?? []).some((w) => w.includes("MAX_NOTIONAL_USD")), "quote above the cap warns at quote time");
    const capped = await s.call("execute_trade", { quote_id: big.json?.quote_id, confirm: true });
    check(!capped.ok && capped.text.includes("MAX_NOTIONAL_USD"), "execute above MAX_NOTIONAL_USD is refused");
    const slip = await s.call("get_quote", { ...quoteArgs("50"), slippage_bps: 101 });
    check(!slip.ok && slip.text.includes("MAX_SLIPPAGE_BPS"), "slippage above MAX_SLIPPAGE_BPS is refused");
    const eoa = privateKeyToAccount(generatePrivateKey()).address;
    const badDec = await s.call("get_quote", { chain_id: t.chainId, inputs: [{ token: "USDC", amount: "1" }], outputs: [{ token: eoa }] });
    check(!badDec.ok && badDec.text.toLowerCase().includes(eoa.toLowerCase()) && badDec.text.includes("decimals"), "unreadable decimals() refuses naming the token");
    const unknown = await s.call("execute_trade", { quote_id: "00000000-0000-0000-0000-000000000000", confirm: true });
    check(!unknown.ok && unknown.text.includes("unknown quote_id"), "a quote this server did not create cannot be executed");
    check((await pub.getTransactionCount({ address: wallet })) === nonce, "dry-run server sent no transaction");
  } finally {
    await s.close();
  }

  // --- Live server. Re-fork at the latest block first: prod quotes the live chain and the fork must not drift behind it.
  console.log("\n# live server");
  await refork(pub, wallet);
  await fund(pub, t.usdc, wallet, parseUnits("200", dec.usdc));
  nonce = await pub.getTransactionCount({ address: wallet });
  s = await Server.start({ ...rpcEnv, PRIVATE_KEY: key, INFRARED_API_KEY: apiKey, EXECUTE_ENABLED: "true", MAX_NOTIONAL_USD: "100" });
  try {
    const status = await s.call("get_wallet_status");
    check(status.ok && status.json?.execute_enabled === true, "live status shows execution enabled");
    const before = await rawBalances(pub, wallet, [t.usdc, t.weth, t.btc]);
    const q = await s.call("get_quote", quoteArgs("50"));
    check(q.ok, "live get_quote", q.text.slice(0, 200));
    const x = await s.call("execute_trade", { quote_id: q.json?.quote_id, confirm: true });
    check(x.ok && x.json?.sent === true && String(x.json?.tx_hash).startsWith("0x"), "execute_trade sends and confirms the swap", x.text.slice(0, 400));
    const after = await rawBalances(pub, wallet, [t.usdc, t.weth, t.btc]);
    const spent = before[0]! - after[0]!;
    check(spent === parseUnits("50", dec.usdc), "exactly 50 USDC left the wallet", spent.toString());
    const gotWeth = after[1]! - before[1]!;
    const gotBtc = after[2]! - before[2]!;
    check(gotWeth > 0n && gotBtc > 0n, "WETH and WBTC arrived", `${gotWeth} ${gotBtc}`);
    const mins = (q.json?.outputs as { token: string; minimum_atomic: string }[]) ?? [];
    const minOf = (a: Address) => BigInt(mins.find((m) => m.token.toLowerCase() === a.toLowerCase())?.minimum_atomic ?? "0");
    check(gotWeth >= minOf(t.weth) && gotBtc >= minOf(t.btc), "every output is at or above the quoted minimum");
    const usdWeth = Number(formatUnits(gotWeth, dec.weth)) * prices.get(t.weth.toLowerCase())!;
    const usdBtc = Number(formatUnits(gotBtc, dec.btc)) * prices.get(t.btc.toLowerCase())!;
    const wethShare = (usdWeth / (usdWeth + usdBtc)) * 10000;
    check(Math.abs(wethShare - 6000) <= TOLERANCE_BPS, "output split matches 60/40 by value", `${wethShare.toFixed(0)} bps`);
    const sentTxs = (await pub.getTransactionCount({ address: wallet })) - nonce;
    const approvals = ((x.json?.approvals_sent as { tx_hashes: string[] }[]) ?? []).reduce((n, a) => n + a.tx_hashes.length, 0);
    check(sentTxs === approvals + 1, "one swap transaction plus the reported approvals", `${sentTxs} txs, ${approvals} approvals`);
    const router = ((q.json?.approvals_needed as { spender: Address }[]) ?? [])[0]?.spender;
    const allowance = router ? await pub.readContract({ account: READER, address: t.usdc, abi: erc20Abi, functionName: "allowance", args: [wallet, router] }) : null;
    check(allowance === 0n, "approval was exact: nothing left for the Router to spend", String(allowance));
    const changes = (x.json?.balance_changes as { token: string; delta: string }[]) ?? [];
    check(changes.some((c) => c.token.toLowerCase() === t.usdc.toLowerCase() && c.delta === "-50"), "report shows the -50 USDC balance change");
    const replay = await s.call("execute_trade", { quote_id: q.json?.quote_id, confirm: true });
    check(!replay.ok, "re-executing the same quote fails instead of double-spending", replay.text.slice(0, 160));
  } finally {
    await s.close();
  }
}

// --- helpers ---------------------------------------------------------------

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
