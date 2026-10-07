import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createBot } from "./bot.js";
import { ChainReaders } from "./chain.js";
import { loadConfig, ToolError } from "./config.js";
import { InfraredClient } from "./infrared.js";
import { UserStore } from "./store.js";
import { TokenResolver } from "./tokens.js";
import { TradeService } from "./trade.js";
import { WalletLink } from "./wallet.js";

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  mkdirSync(cfg.dataDir, { recursive: true });
  const api = new InfraredClient(cfg.apiUrl, cfg.apiKey);
  const tokens = new TokenResolver(api);
  const chains = new ChainReaders(cfg, (id) => tokens.chainInfo(id));
  tokens.attach(chains);
  const wallet = await WalletLink.init(cfg);
  const store = new UserStore(join(cfg.dataDir, "users.json"), { chainId: cfg.chains[0] as number, slippageBps: cfg.defaultSlippageBps });
  // Drop references to sessions WalletConnect no longer has (expired or deleted while the bot was down).
  for (const [id, u] of store.all()) if (u.wcTopic && !wallet.session(u.wcTopic)) store.update(id, { wcTopic: undefined, address: undefined });
  const trade = new TradeService(cfg, api, tokens, chains, wallet);
  const bot = createBot({ cfg, store, wallet, trade, tokens, chains, api });

  const stop = () => {
    console.error("shutting down");
    bot.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await bot.start({
    onStart: (me) => console.error(`@${me.username} running: chains=[${cfg.chains.join(",")}] partner_fee_bps=${cfg.partnerFeeBps} recipient=${cfg.partnerRecipient ?? "none"} max_slippage_bps=${cfg.maxSlippageBps}`),
  });
}

main().catch((err) => {
  console.error(err instanceof ToolError ? `config: ${err.message}` : err);
  process.exit(1);
});
