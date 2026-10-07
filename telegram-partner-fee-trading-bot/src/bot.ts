import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import QRCode from "qrcode";
import type { Address } from "viem";
import { fromAtomic } from "./amounts.js";
import type { ChainReaders } from "./chain.js";
import { NATIVE, ToolError, type BotConfig } from "./config.js";
import { esc, explorerAddress, feeLine, pct, quoteCard, resultCard, usd } from "./format.js";
import type { InfraredClient } from "./infrared.js";
import { parseTrade, USAGE } from "./parse.js";
import type { UserStore } from "./store.js";
import type { TokenResolver } from "./tokens.js";
import type { TradeService } from "./trade.js";
import type { WalletLink } from "./wallet.js";

export interface BotDeps {
  cfg: BotConfig;
  store: UserStore;
  wallet: WalletLink;
  trade: TradeService;
  tokens: TokenResolver;
  chains: ChainReaders;
  api: InfraredClient;
  log?: (msg: string) => void;
}

const CONNECT_TIMEOUT_MS = 5 * 60_000;
const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

export function createBot(deps: BotDeps): Bot {
  const { cfg, store, wallet, trade, tokens, chains } = deps;
  const log = deps.log ?? ((m: string) => console.error(m));
  const bot = new Bot(cfg.telegramToken);
  const busy = new Set<number>();

  const reply = (ctx: Context, text: string, extra: Record<string, unknown> = {}) => ctx.reply(text, { ...HTML, ...extra });
  const userOf = (ctx: Context): number => {
    const id = ctx.from?.id;
    if (!id) throw new ToolError("cannot identify you");
    if (cfg.allowedUserIds.size > 0 && !cfg.allowedUserIds.has(id)) throw new ToolError("this bot is private");
    return id;
  };
  const connected = (userId: number): { topic: string; address: Address } => {
    const u = store.get(userId);
    const s = wallet.session(u.wcTopic);
    if (!s || !u.address) {
      if (u.wcTopic) store.update(userId, { wcTopic: undefined, address: undefined });
      throw new ToolError("no wallet connected. Send /connect first.");
    }
    return { topic: s.topic, address: u.address };
  };
  const guard =
    (fn: (ctx: Context, userId: number) => Promise<void>) =>
    async (ctx: Context): Promise<void> => {
      let userId: number | undefined;
      try {
        userId = userOf(ctx);
        await fn(ctx, userId);
      } catch (err) {
        const msg = err instanceof ToolError ? err.message : "something went wrong; please try again";
        if (!(err instanceof ToolError)) log(`handler error for user ${userId}: ${(err as Error).stack ?? err}`);
        await reply(ctx, esc(msg)).catch(() => undefined);
      }
    };

  bot.command(["start", "help"], guard(async (ctx) => {
    await reply(
      ctx,
      [
        `<b>${esc(cfg.botName)}</b>`,
        "Trade from your own wallet through Infrared: best-price routing across protocols, up to 6 tokens in and 6 out in one transaction. Your keys stay in your wallet; every transaction is confirmed there.",
        "",
        "/connect — link your wallet (WalletConnect)",
        "/wallet — address and balances",
        "/chain — pick a chain",
        "/slippage — view or set slippage",
        "/price USDC WETH — prices",
        "/quote 50 USDC to WETH — price a trade",
        "/swap 50 USDC to 60% WETH 40% cbBTC — trade",
        "/fees — what this bot charges",
        "/disconnect — unlink your wallet",
        "",
        feeLine(cfg),
      ].join("\n"),
    );
  }));

  bot.command("fees", guard(async (ctx) => reply(ctx, feeLine(cfg)).then(() => undefined)));

  bot.command("connect", guard(async (ctx, userId) => {
    if (ctx.chat?.type !== "private") throw new ToolError("connect your wallet in a private chat with me, not in a group");
    const u = store.get(userId);
    const existing = wallet.session(u.wcTopic);
    if (existing) await wallet.disconnect(existing.topic).catch(() => undefined);
    store.update(userId, { wcTopic: undefined, address: undefined });
    const { uri, approval } = await wallet.connect(u.chainId);
    const png = await QRCode.toBuffer(uri, { type: "png", width: 512, margin: 2 });
    await ctx.replyWithPhoto(new InputFile(png, "walletconnect.png"), {
      caption: ["Scan with your wallet, or copy the link into its WalletConnect screen:", `<code>${esc(uri)}</code>`, "", "Waiting up to 5 minutes for approval..."].join("\n"),
      ...HTML,
    });
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new ToolError("no wallet approved the connection within 5 minutes; send /connect to try again")), CONNECT_TIMEOUT_MS));
    const s = await Promise.race([approval(), timeout]);
    store.update(userId, { wcTopic: s.topic, address: s.address });
    const chain = await tokens.chainInfo(u.chainId);
    const missing = cfg.chains.filter((c) => !s.chains.includes(c));
    await reply(
      ctx,
      [`Connected ${explorerAddress(chain, s.address)} on ${esc(chain.name)}.`, missing.length ? `Your wallet did not enable chain${missing.length > 1 ? "s" : ""} ${missing.join(", ")}; /chain to those will need a reconnect.` : "", "Try /wallet or /quote 50 USDC to WETH"].filter(Boolean).join("\n"),
    );
  }));

  bot.command("disconnect", guard(async (ctx, userId) => {
    const u = store.get(userId);
    if (u.wcTopic) await wallet.disconnect(u.wcTopic).catch(() => undefined);
    store.update(userId, { wcTopic: undefined, address: undefined });
    await reply(ctx, "Wallet disconnected.");
  }));

  bot.command("wallet", guard(async (ctx, userId) => {
    const { address } = connected(userId);
    const u = store.get(userId);
    const chain = await tokens.chainInfo(u.chainId);
    const idents = (ctx.match as string).trim() ? (ctx.match as string).trim().split(/[\s,]+/) : [chain.native_symbol, "USDC", "USDT", "WETH"];
    const rows: string[] = [];
    for (const ident of idents.slice(0, 20)) {
      let token: Address;
      try {
        token = await tokens.resolve(u.chainId, ident);
      } catch (err) {
        if (ctx.match) rows.push(`• ${esc(ident)}: ${esc((err as Error).message)}`);
        continue;
      }
      const [bal, d] = await Promise.all([chains.balance(u.chainId, address, token), tokens.decimals(u.chainId, token)]);
      const human = fromAtomic(bal, d);
      const price = await priceOf(u.chainId, token);
      rows.push(`• ${esc(human)} ${esc(await tokens.symbol(u.chainId, token))}${price !== undefined ? ` (${usd(Number(human) * price)})` : ""}`);
    }
    await reply(ctx, [`${explorerAddress(chain, address)} on ${esc(chain.name)}`, ...rows, "", "Add tokens: /wallet WBTC DAI"].join("\n"));
  }));

  const priceOf = async (chainId: number, token: Address): Promise<number | undefined> => {
    const wrapped = (await tokens.chainInfo(chainId)).wrapped_native_address;
    const target = token.toLowerCase() === NATIVE.toLowerCase() ? wrapped : token;
    return (await deps.api.prices(chainId, [target])).get(target.toLowerCase());
  };

  bot.command("chain", guard(async (ctx, userId) => {
    const u = store.get(userId);
    const all = await tokens.allChains();
    const arg = (ctx.match as string).trim().toLowerCase();
    if (!arg) {
      const rows = cfg.chains.map((id) => `• ${esc(all.get(id)?.name ?? id)} (${id})${id === u.chainId ? " ← current" : ""}`);
      await reply(ctx, ["Enabled chains:", ...rows, "", "Switch: /chain base"].join("\n"));
      return;
    }
    const target = cfg.chains.find((id) => String(id) === arg || all.get(id)?.name.toLowerCase() === arg);
    if (!target) throw new ToolError(`unknown chain "${arg}"; one of ${cfg.chains.map((id) => all.get(id)?.name ?? id).join(", ")}`);
    const s = wallet.session(u.wcTopic);
    const supported = !s || wallet.chainsOf(s).includes(target);
    const patch: Parameters<typeof store.update>[1] = { chainId: target };
    if (s && supported) patch.address = wallet.addressOf(s, target);
    store.update(userId, patch);
    await reply(ctx, `Chain set to ${esc(all.get(target)?.name ?? target)}.${supported ? "" : " Your wallet session does not include this chain: send /connect again before trading on it."}`);
  }));

  bot.command("slippage", guard(async (ctx, userId) => {
    const u = store.get(userId);
    const arg = (ctx.match as string).trim();
    if (!arg) {
      await reply(ctx, `Slippage tolerance: ${pct(u.slippageBps)} (${u.slippageBps} bps). Set in bps, max ${cfg.maxSlippageBps}: /slippage 100`);
      return;
    }
    const bps = Number(arg);
    if (!Number.isInteger(bps) || bps < 0 || bps > cfg.maxSlippageBps) throw new ToolError(`slippage must be an integer number of bps between 0 and ${cfg.maxSlippageBps}`);
    store.update(userId, { slippageBps: bps });
    await reply(ctx, `Slippage set to ${pct(bps)}.`);
  }));

  bot.command("price", guard(async (ctx, userId) => {
    const u = store.get(userId);
    const idents = (ctx.match as string).trim().split(/[\s,]+/).filter(Boolean);
    if (idents.length === 0) throw new ToolError("usage: /price USDC WETH");
    const rows: string[] = [];
    for (const ident of idents.slice(0, 20)) {
      try {
        const token = await tokens.resolve(u.chainId, ident);
        const price = await priceOf(u.chainId, token);
        rows.push(`• ${esc(await tokens.symbol(u.chainId, token))} ${price === undefined ? "no price" : usd(price)}`);
      } catch (err) {
        rows.push(`• ${esc(ident)}: ${esc((err as Error).message)}`);
      }
    }
    await reply(ctx, rows.join("\n"));
  }));

  const quoteFor = async (ctx: Context, userId: number, text: string) => {
    if (!text.trim()) throw new ToolError(`usage:\n${USAGE}`);
    const parsed = parseTrade(text);
    const { address } = connected(userId);
    const u = store.get(userId);
    const p = await trade.quote({ id: userId, chainId: u.chainId, slippageBps: u.slippageBps, address }, parsed);
    const chain = await tokens.chainInfo(u.chainId);
    return { p, card: quoteCard(p, chain, cfg) };
  };

  bot.command("quote", guard(async (ctx, userId) => {
    const { card } = await quoteFor(ctx, userId, ctx.match as string);
    await reply(ctx, `${card}\n\nTo trade, send the same with /swap.`);
  }));

  bot.command("swap", guard(async (ctx, userId) => {
    if (busy.has(userId)) throw new ToolError("you have a swap in progress; wait for it to finish");
    const { p, card } = await quoteFor(ctx, userId, ctx.match as string);
    const kb = new InlineKeyboard().text("Confirm swap", `x:${p.id}`).text("Cancel", `c:${p.id}`);
    await reply(ctx, `${card}\n\nThe quote is valid for 90 seconds.`, { reply_markup: kb });
  }));

  bot.callbackQuery(/^c:(.+)$/, guard(async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Cancelled. Nothing was sent.").catch(() => undefined);
  }));

  bot.callbackQuery(/^x:(.+)$/, guard(async (ctx, userId) => {
    const quoteId = (ctx.match as RegExpMatchArray)[1] as string;
    let p;
    try {
      p = trade.take(quoteId, userId);
      if (p.execution) throw new ToolError(p.execution.txHash ? `already executed in ${p.execution.txHash}` : "already being executed");
      if (!trade.isFresh(p)) throw new ToolError("this quote is older than 90 seconds; run /swap again for a fresh price");
    } catch (err) {
      await ctx.answerCallbackQuery({ text: (err as Error).message.slice(0, 190), show_alert: true });
      return;
    }
    if (busy.has(userId)) {
      await ctx.answerCallbackQuery({ text: "you have a swap in progress", show_alert: true });
      return;
    }
    const { topic, address } = connected(userId);
    if (address.toLowerCase() !== p.address.toLowerCase()) throw new ToolError("your connected wallet changed since this quote; run /swap again");
    await ctx.answerCallbackQuery({ text: "Executing..." });
    busy.add(userId);
    try {
      const progress = async (text: string) => {
        await ctx.editMessageText(text, HTML).catch(() => undefined);
      };
      const result = await trade.execute(p, topic, progress);
      const chain = await tokens.chainInfo(p.chainId);
      await ctx.editMessageText(resultCard(result, chain), HTML).catch(async () => reply(ctx, resultCard(result, chain)));
    } catch (err) {
      const msg = err instanceof ToolError ? err.message : "something went wrong during execution";
      if (!(err instanceof ToolError)) log(`execute error for user ${userId}: ${(err as Error).stack ?? err}`);
      await ctx.editMessageText(`Swap not completed: ${esc(msg)}`, HTML).catch(async () => reply(ctx, `Swap not completed: ${esc(msg)}`));
    } finally {
      busy.delete(userId);
    }
  }));

  bot.on("message:text", guard(async (ctx) => {
    if (ctx.chat?.type === "private") await reply(ctx, `Send a command, e.g. /swap 50 USDC to WETH. /help lists everything.`);
  }));

  bot.catch((err) => log(`bot error: ${err.error instanceof Error ? err.error.stack : String(err.error)}`));

  wallet.onSessionDelete((topic) => {
    for (const [id, u] of store.all()) if (u.wcTopic === topic) store.update(id, { wcTopic: undefined, address: undefined });
  });
  wallet.onAccountsChanged((topic, address) => {
    for (const [id, u] of store.all()) if (u.wcTopic === topic) store.update(id, { address });
  });
  return bot;
}
