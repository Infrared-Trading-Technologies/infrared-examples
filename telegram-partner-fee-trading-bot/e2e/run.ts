// End-to-end check: forks a real chain with anvil, runs a real WalletConnect wallet peer in-process
// (signing with a fresh key against the fork), and drives the bot's handlers with Telegram update
// objects while recording what the bot sends back. Quotes, builds, WalletConnect relay traffic and
// swaps are real; only Telegram's HTTP API is replaced by the in-process recorder.
//
//   FORK_RPC_URL=<rpc> INFRARED_API_KEY=<key> WALLETCONNECT_PROJECT_ID=<id> npm run e2e -- --chain arbitrum
import type { Bot, Transformer } from "grammy";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
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
import { createBot } from "../dist/bot.js";
import { ChainReaders } from "../dist/chain.js";
import { loadConfig } from "../dist/config.js";
import { InfraredClient } from "../dist/infrared.js";
import { UserStore } from "../dist/store.js";
import { TokenResolver } from "../dist/tokens.js";
import { TradeService } from "../dist/trade.js";
import { WalletLink } from "../dist/wallet.js";

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
const PARTNER_FEE_BPS = 50;
const TOLERANCE_BPS = 100;
const READER = "0x000000000000000000000000000000000000dEaD" as Address;
const USER = { id: 4242, is_bot: false, first_name: "E2E" };
const CHAT = { id: 4242, type: "private" as const, first_name: "E2E" };

let failures = 0;
let forkRpcUrl = "";
function check(ok: boolean, name: string, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail.replace(/\s+/g, " ").slice(0, 220)})` : ""}`);
  if (!ok) failures++;
}

// --- Telegram recorder: grammY's outbound API calls land here instead of api.telegram.org -----------

interface Sent {
  method: string;
  payload: Record<string, unknown>;
  messageId: number;
}

class Telegram {
  readonly sent: Sent[] = [];
  private nextId = 1;
  private cursor = 0;
  private updateId = 1;

  install(bot: Bot): void {
    bot.botInfo = { id: 1, is_bot: true, first_name: "e2e-bot", username: "e2e_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false } as never;
    const transformer: Transformer = async (_prev, method, payload) => {
      const messageId = (payload as { message_id?: number }).message_id ?? this.nextId++;
      this.sent.push({ method, payload: payload as Record<string, unknown>, messageId });
      if (method === "answerCallbackQuery") return { ok: true, result: true } as never;
      const p = payload as { chat_id?: number; text?: string; caption?: string; reply_markup?: unknown };
      return { ok: true, result: { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: p.chat_id ?? CHAT.id, type: "private" }, text: p.text ?? p.caption ?? "", reply_markup: p.reply_markup } } as never;
    };
    bot.api.config.use(transformer);
  }

  /** Text of everything sent since the last call (messages, captions, edits, alerts). */
  drain(): Sent[] {
    const out = this.sent.slice(this.cursor);
    this.cursor = this.sent.length;
    return out;
  }

  /** Message text as a Telegram client would show it: HTML entities decoded (tags are left in place for assertions). */
  textOf(s: Sent): string {
    return String(s.payload.text ?? s.payload.caption ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }

  async waitFor(pred: (s: Sent) => boolean, timeoutMs: number): Promise<Sent> {
    const deadline = Date.now() + timeoutMs;
    let i = this.cursor;
    while (Date.now() < deadline) {
      for (; i < this.sent.length; i++) if (pred(this.sent[i] as Sent)) return this.sent[i] as Sent;
      await sleep(100);
    }
    throw new Error("timed out waiting for a Telegram message");
  }

  command(text: string, chatType: "private" | "supergroup" = "private", from = USER) {
    const chat = chatType === "private" ? CHAT : { id: -100, type: "supergroup" as const, title: "group" };
    return { update_id: this.updateId++, message: { message_id: this.nextId++, date: Math.floor(Date.now() / 1000), chat, from, text, entities: [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0]!.length }] } };
  }

  press(data: string, messageId: number) {
    return { update_id: this.updateId++, callback_query: { id: String(this.updateId), from: USER, chat_instance: "1", data, message: { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: CHAT, from: { id: 1, is_bot: true, first_name: "e2e-bot" }, text: "quote" } } };
  }
}

// --- WalletConnect wallet peer: the "phone", in a child process (see wallet-peer.ts) ----------------

class WalletPeer {
  private readonly child: ChildProcess;
  readonly address: Address;

  private constructor(child: ChildProcess, address: Address) {
    this.child = child;
    this.address = address;
  }

  static async start(projectId: string, key: Hex, rpc: string, dir: string): Promise<WalletPeer> {
    const child = fork(new URL("./wallet-peer.ts", import.meta.url).pathname, [], {
      execArgv: ["--experimental-strip-types", "--no-warnings"],
      env: { ...process.env, WALLETCONNECT_PROJECT_ID: projectId, PEER_PRIVATE_KEY: key, PEER_RPC_URL: rpc, PEER_DATA_DIR: dir },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const ready = await waitMessage(child, (m) => m.type === "ready", 60_000);
    return new WalletPeer(child, ready.address as Address);
  }

  async pair(uri: string): Promise<void> {
    this.child.send({ type: "pair", uri });
    await waitMessage(this.child, (m) => m.type === "paired" || m.type === "error", 30_000).then((m) => {
      if (m.type === "error") throw new Error(`peer pair failed: ${m.message}`);
    });
  }

  /** Resolves once the peer has approved a session proposal. */
  approved(timeoutMs: number): Promise<void> {
    return waitMessage(this.child, (m) => m.type === "approved", timeoutMs).then(() => undefined);
  }

  async rejectNext(): Promise<void> {
    this.child.send({ type: "rejectNext" });
    await waitMessage(this.child, (m) => m.type === "ok", 5_000);
  }

  async handled(): Promise<number> {
    this.child.send({ type: "stats" });
    return (await waitMessage(this.child, (m) => m.type === "stats", 5_000)).handled as number;
  }

  stop(): void {
    this.child.kill();
  }
}

function waitMessage(child: ChildProcess, pred: (m: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", onMsg);
      reject(new Error("timed out waiting for the wallet peer"));
    }, timeoutMs);
    const onMsg = (m: unknown) => {
      const msg = m as Record<string, unknown>;
      if (pred(msg)) {
        clearTimeout(timer);
        child.off("message", onMsg);
        resolve(msg);
      }
    };
    child.on("message", onMsg);
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { chain: { type: "string", default: "arbitrum" }, port: { type: "string", default: "8549" } } });
  const t = CHAINS[values.chain!];
  if (!t) throw new Error(`unknown --chain ${values.chain}; one of ${Object.keys(CHAINS).join(", ")}`);
  forkRpcUrl = need("FORK_RPC_URL");
  const apiKey = need("INFRARED_API_KEY");
  const projectId = need("WALLETCONNECT_PROJECT_ID");
  const rpc = `http://127.0.0.1:${values.port}`;
  const anvil = await startAnvil(forkRpcUrl, values.port!);
  try {
    const pub = createPublicClient({ transport: http(rpc) }) as PublicClient;
    const chainId = await pub.getChainId();
    if (chainId !== t.chainId) throw new Error(`FORK_RPC_URL is chain ${chainId}, expected ${t.chainId}`);
    await runScenarios(pub, rpc, apiKey, projectId, t);
  } finally {
    anvil.kill();
  }
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

async function runScenarios(pub: PublicClient, rpc: string, apiKey: string, projectId: string, t: Tokens): Promise<void> {
  const prices = await fetchPrices(t.chainId, [t.usdc, t.weth, t.btc]);
  const dec = { usdc: await decimals(pub, t.usdc), weth: await decimals(pub, t.weth), btc: await decimals(pub, t.btc) };
  const key = generatePrivateKey();
  const user = privateKeyToAccount(key).address;
  const partner = privateKeyToAccount(generatePrivateKey()).address;
  await anvilRpc(pub, "anvil_setBalance", [user, numberToHex(parseEther("1"))]);
  await fund(pub, t.usdc, user, parseUnits("200", dec.usdc));

  const dataDir = mkdtempSync(join(tmpdir(), "tg-bot-e2e-"));
  const env = {
    TELEGRAM_BOT_TOKEN: "000000:e2e-no-network",
    WALLETCONNECT_PROJECT_ID: projectId,
    INFRARED_API_KEY: apiKey,
    INFRARED_API_URL: API,
    PARTNER_FEE_BPS: String(PARTNER_FEE_BPS),
    PARTNER_RECIPIENT: partner,
    CHAINS: String(t.chainId),
    [`RPC_URL_${t.chainId}`]: rpc,
    DATA_DIR: dataDir,
    BOT_NAME: "E2E Infrared Bot",
  };
  const cfg = loadConfig(env);
  const api = new InfraredClient(cfg.apiUrl, cfg.apiKey);
  const tokens = new TokenResolver(api);
  const chains = new ChainReaders(cfg, (id) => tokens.chainInfo(id));
  tokens.attach(chains);
  const wallet = await WalletLink.init(cfg);
  const store = new UserStore(join(dataDir, "users.json"), { chainId: t.chainId, slippageBps: cfg.defaultSlippageBps });
  const trade = new TradeService(cfg, api, tokens, chains, wallet);
  const logs: string[] = [];
  const bot = createBot({ cfg, store, wallet, trade, tokens, chains, api, log: (m) => logs.push(m) });
  const tg = new Telegram();
  tg.install(bot);
  const peer = await WalletPeer.start(projectId, key, rpc, join(dataDir, "peer"));
  const send = async (text: string, chatType: "private" | "supergroup" = "private") => {
    await bot.handleUpdate(tg.command(text, chatType) as never);
    return tg.drain().map((s) => tg.textOf(s));
  };
  const swapArgs = `50 USDC to 60% ${t.weth} 40% ${t.btc}`;

  console.log("\n# onboarding");
  const start = await send("/start");
  check(start.some((m) => m.includes("0.5% fee on the input") && m.includes(partner)), "/start discloses the partner fee and recipient", start.join(" | "));
  const noWallet = await send("/wallet");
  check(noWallet.some((m) => m.includes("/connect")), "/wallet before connecting points to /connect");
  const group = await send("/connect", "supergroup");
  check(group.some((m) => m.includes("private chat")), "/connect in a group is refused");

  const connecting = bot.handleUpdate(tg.command("/connect") as never);
  const photo = await tg.waitFor((s) => s.method === "sendPhoto", 30_000);
  const uri = /wc:[^<\s]+/.exec(tg.textOf(photo))?.[0];
  check(Boolean(uri), "/connect sends a QR with a wc: pairing URI", tg.textOf(photo).slice(0, 80));
  const approved = peer.approved(60_000);
  await peer.pair(uri as string);
  await approved;
  await connecting;
  const connected = tg.drain().map((s) => tg.textOf(s));
  check(connected.some((m) => m.includes("Connected") && m.toLowerCase().includes(user.slice(0, 6).toLowerCase())), "wallet session approved and address stored", connected.join(" | "));
  check(store.get(USER.id).address?.toLowerCase() === user.toLowerCase(), "store holds the connected address");

  const walletMsg = await send("/wallet");
  check(walletMsg.some((m) => m.includes("200 USDC")), "/wallet shows the funded USDC from the fork", walletMsg.join(" | "));
  const chainMsg = await send("/chain");
  check(chainMsg.some((m) => m.includes("current")), "/chain lists the current chain");
  const slipBad = await send("/slippage 301");
  check(slipBad.some((m) => m.includes("between 0 and 300")), "/slippage above the cap is refused");
  const slipOk = await send("/slippage 100");
  check(slipOk.some((m) => m.includes("1%")) && store.get(USER.id).slippageBps === 100, "/slippage 100 is stored");
  const price = await send("/price USDC ETH");
  check(price.some((m) => /USDC \$0\.9|USDC \$1\.0/.test(m) && /ETH \$\d/.test(m)), "/price resolves symbols including the native currency", price.join(" | "));

  console.log("\n# quoting");
  const quote = await send(`/quote ${swapArgs}`);
  const card = quote.find((m) => m.includes("You pay")) ?? "";
  check(card.includes("50 USDC") && card.includes("You receive"), "/quote renders the card", card.slice(0, 200));
  check(card.includes(`bot ${PARTNER_FEE_BPS / 100}%`), "quote card shows the bot's partner fee as applied by the API", card);
  check(/Needs 1 exact-amount approval/.test(card), "quote card announces the USDC approval");
  const tooMuch = await send("/swap 1000 USDC to WETH");
  check(tooMuch.some((m) => m.includes("you hold 200")), "insufficient balance is caught before quoting", tooMuch.join(" | "));
  const badParse = await send("/swap 50 USDC");
  check(badParse.some((m) => m.includes("could not parse")), "malformed trade text gets the usage help");

  console.log("\n# cancel");
  let nonce = await pub.getTransactionCount({ address: user });
  await bot.handleUpdate(tg.command(`/swap ${swapArgs}`) as never);
  let swapMsg = tg.drain().find((s) => s.payload.reply_markup);
  const buttons = (swapMsg?.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard.flat() ?? [];
  check(buttons.length === 2 && buttons[0]?.callback_data.startsWith("x:") && buttons[1]?.callback_data.startsWith("c:"), "/swap offers Confirm and Cancel buttons", JSON.stringify(buttons));
  await bot.handleUpdate(tg.press(buttons[1]!.callback_data, swapMsg!.messageId) as never);
  check(tg.drain().some((s) => tg.textOf(s).includes("Cancelled")), "Cancel edits the message and sends nothing");
  check((await pub.getTransactionCount({ address: user })) === nonce, "no transaction after cancel");

  console.log("\n# execute");
  await refork(pub, user);
  await fund(pub, t.usdc, user, parseUnits("200", dec.usdc));
  nonce = await pub.getTransactionCount({ address: user });
  const before = await rawBalances(pub, user, [t.usdc, t.weth, t.btc]);
  const partnerBefore = (await rawBalances(pub, partner, [t.usdc]))[0]!;
  await bot.handleUpdate(tg.command(`/swap ${swapArgs}`) as never);
  swapMsg = tg.drain().find((s) => s.payload.reply_markup);
  const confirm = (swapMsg?.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat()[0]!.callback_data;
  const mins = [...tg.textOf(swapMsg!).matchAll(/<i>min ([\d.]+)<\/i>/g)].map((m) => m[1] as string);
  const handledBefore = await peer.handled();
  await bot.handleUpdate(tg.press(confirm, swapMsg!.messageId) as never);
  const edits = tg.drain().map((s) => tg.textOf(s));
  const final = edits[edits.length - 1] ?? "";
  check(final.includes("Swap confirmed"), "Confirm runs approve + swap through the wallet and reports success", edits.join(" | "));
  const handledNow = await peer.handled();
  check(handledNow - handledBefore === 2, "wallet received exactly two requests: approve and swap", String(handledNow - handledBefore));
  check(edits.some((m) => m.includes("Approve 50 USDC")), "approval prompt names the exact amount");
  const after = await rawBalances(pub, user, [t.usdc, t.weth, t.btc]);
  check(before[0]! - after[0]! === parseUnits("50", dec.usdc), "exactly 50 USDC left the user's wallet", String(before[0]! - after[0]!));
  const gotWeth = after[1]! - before[1]!;
  const gotBtc = after[2]! - before[2]!;
  check(gotWeth > 0n && gotBtc > 0n, "WETH and BTC arrived", `${gotWeth} ${gotBtc}`);
  check(mins.length === 2 && gotWeth >= parseUnits(mins[0]!, dec.weth) && gotBtc >= parseUnits(mins[1]!, dec.btc), "outputs are at or above the quoted minimums", mins.join(","));
  const usdWeth = Number(formatUnits(gotWeth, dec.weth)) * prices.get(t.weth.toLowerCase())!;
  const usdBtc = Number(formatUnits(gotBtc, dec.btc)) * prices.get(t.btc.toLowerCase())!;
  const share = (usdWeth / (usdWeth + usdBtc)) * 10000;
  check(Math.abs(share - 6000) <= TOLERANCE_BPS, "output split matches 60/40 by value", `${share.toFixed(0)} bps`);
  const feeExpected = (parseUnits("50", dec.usdc) * BigInt(PARTNER_FEE_BPS)) / 10000n;
  const feeGot = (await rawBalances(pub, partner, [t.usdc]))[0]! - partnerBefore;
  check(feeGot >= (feeExpected * 98n) / 100n && feeGot <= (feeExpected * 102n) / 100n, "partner recipient received the 0.5% fee in USDC on-chain", `${feeGot} vs ${feeExpected}`);
  check((await pub.getTransactionCount({ address: user })) - nonce === 2, "user sent exactly approve + swap", String((await pub.getTransactionCount({ address: user })) - nonce));
  const allowance = await pub.readContract({ account: READER, address: t.usdc, abi: erc20Abi, functionName: "allowance", args: [user, (JSON.parse(JSON.stringify(trade.take(confirm.slice(2), USER.id).quote.approvals))[0] as { spender: Address }).spender] });
  check(allowance === 0n, "approval was exact: nothing left for the Router to spend", String(allowance));

  nonce = await pub.getTransactionCount({ address: user });
  await bot.handleUpdate(tg.press(confirm, swapMsg!.messageId) as never);
  const again = tg.drain().find((s) => s.method === "answerCallbackQuery");
  check(Boolean(again) && /already executed/.test(String(again?.payload.text)), "pressing Confirm again refuses to double-spend", String(again?.payload.text));
  check((await pub.getTransactionCount({ address: user })) === nonce, "no transaction after the second press");

  console.log("\n# wallet rejection");
  nonce = await pub.getTransactionCount({ address: user });
  await bot.handleUpdate(tg.command(`/swap ${swapArgs}`) as never);
  swapMsg = tg.drain().find((s) => s.payload.reply_markup);
  const confirm2 = (swapMsg?.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat()[0]!.callback_data;
  await peer.rejectNext();
  await bot.handleUpdate(tg.press(confirm2, swapMsg!.messageId) as never);
  const rejected = tg.drain().map((s) => tg.textOf(s));
  check(rejected.some((m) => m.includes("Swap not completed") && m.includes("rejected")), "a rejection in the wallet is reported and stops the flow", rejected.join(" | "));
  check((await pub.getTransactionCount({ address: user })) === nonce, "nothing was sent after the rejection");

  console.log("\n# access control");
  const privateCfg = loadConfig({ ...env, ALLOWED_USER_IDS: String(USER.id) });
  const privateBot = createBot({ cfg: privateCfg, store, wallet, trade, tokens, chains, api, log: (m) => logs.push(m) });
  const tg2 = new Telegram();
  tg2.install(privateBot);
  await privateBot.handleUpdate(tg2.command("/start", "private", { id: 999, is_bot: false, first_name: "Stranger" }) as never);
  check(tg2.drain().some((s) => tg2.textOf(s).includes("this bot is private")), "users outside ALLOWED_USER_IDS are refused");
  await privateBot.handleUpdate(tg2.command("/fees") as never);
  check(tg2.drain().some((s) => tg2.textOf(s).includes("0.5% fee")), "allowlisted user is served");

  const disc = await send("/disconnect");
  check(disc.some((m) => m.includes("disconnected")) && store.get(USER.id).wcTopic === undefined, "/disconnect clears the session");
  check(logs.length === 0, "no unexpected handler errors were logged", logs.join(" | ").slice(0, 300));
  peer.stop();
}

// --- helpers ---------------------------------------------------------------

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function startAnvil(forkUrl: string, port: string): Promise<ChildProcess> {
  const anvil = spawn("anvil", ["--fork-url", forkUrl, "--port", port, "--silent"], { stdio: "ignore" });
  const pub = createPublicClient({ transport: http(`http://127.0.0.1:${port}`) });
  for (let i = 0; i < 120; i++) {
    try {
      await pub.getChainId();
      return anvil;
    } catch {
      await sleep(500);
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

/** Re-forks at the latest block (prod quotes the live chain) and re-funds gas. */
async function refork(pub: PublicClient, wallet: Address): Promise<void> {
  await anvilRpc(pub, "anvil_reset", [{ forking: { jsonRpcUrl: forkRpcUrl } }]);
  await anvilRpc(pub, "anvil_setBalance", [wallet, numberToHex(parseEther("1"))]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
