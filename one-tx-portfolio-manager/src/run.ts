import type { Address, Hex } from "viem";
import { BotError, NATIVE, capSide, type Config } from "./config.js";
import { ensureApprovals, readBalances, readDecimals, sendBuilt, type Wallet } from "./chain.js";
import { ApiError, type Approval, type InfraredClient, type Quote } from "./infrared.js";
import { planRebalance, usdValue, type Holding } from "./rebalance-math.js";

export type Mode = "rebalance" | "dca" | "sweep";

/** What the bot intends to trade, before quoting. */
interface Intent {
  inputs: { token: Address; amount: bigint }[];
  outputs: { token: Address; ratio_bps: number }[];
  skipped: { token: Address; reason: string }[];
  note?: string;
}

export interface Plan {
  chain_id: number;
  mode: Mode;
  executed: boolean;
  notional_usd: number | null;
  inputs: { token: Address; amount: string }[];
  outputs: { token: Address; ratio_bps: number; expected_amount: string; min_amount: string }[];
  skipped: { token: Address; reason: string }[];
  approval_tx_hashes: Hex[];
  tx_hash: Hex | null;
  note?: string;
}

export interface RunContext {
  cfg: Config;
  wallet: Wallet;
  api: InfraredClient;
  execute: boolean;
}

export async function run(mode: Mode, ctx: RunContext): Promise<Plan> {
  const intent = await INTENTS[mode](ctx);
  const plan: Plan = {
    chain_id: ctx.cfg.chain_id,
    mode,
    executed: false,
    notional_usd: null,
    inputs: intent.inputs.map((i) => ({ token: i.token, amount: i.amount.toString() })),
    outputs: [],
    skipped: intent.skipped,
    approval_tx_hashes: [],
    tx_hash: null,
    note: intent.note,
  };
  if (intent.inputs.length === 0) return plan;

  capSide(intent.inputs.length, `${mode} sell side`);
  capSide(intent.outputs.length, `${mode} buy side`);

  const quote = await quoteIntent(ctx, intent);
  plan.outputs = intent.outputs.map((o) => {
    const est = quote.estimated_outputs.find((e) => e.token.toLowerCase() === o.token.toLowerCase());
    if (!est) throw new BotError(`quote returned no estimate for output ${o.token}`);
    return { token: o.token, ratio_bps: o.ratio_bps, expected_amount: est.expected_amount, min_amount: est.minimum_amount };
  });
  plan.notional_usd = await outputNotionalUsd(ctx, plan.outputs);
  if (plan.notional_usd > ctx.cfg.max_notional_usd) {
    throw new BotError(
      `trade notional $${plan.notional_usd.toFixed(2)} exceeds max_notional_usd $${ctx.cfg.max_notional_usd}; nothing sent`,
    );
  }
  if (!ctx.execute) return plan;

  // Build before any approval so a rejected API key or unbuildable quote broadcasts nothing.
  const built = await ctx.api.build(quote.quote_id);
  plan.approval_tx_hashes = await ensureApprovals(ctx.wallet, approvalsFor(intent, quote, built.transaction.to));
  plan.tx_hash = await sendBuilt(ctx.wallet, built);
  plan.executed = true;
  return plan;
}

const INTENTS: Record<Mode, (ctx: RunContext) => Promise<Intent>> = {
  async rebalance({ cfg, wallet, api }) {
    const r = cfg.rebalance;
    if (!r) throw new BotError("config has no rebalance section");
    const tokens = r.targets.map((t) => t.token);
    const [decimals, balances, prices] = await Promise.all([
      readDecimals(wallet, tokens),
      readBalances(wallet, tokens),
      api.prices(cfg.chain_id, tokens),
    ]);
    const holdings: Holding[] = r.targets.map((t) => {
      const price = prices.get(t.token.toLowerCase());
      if (price === undefined || price <= 0) throw new BotError(`no USD price for ${t.token}; cannot value the portfolio`);
      return {
        token: t.token,
        balance: spendable(t.token, balances.get(t.token) ?? 0n, cfg.gas_reserve_wei),
        decimals: decimals.get(t.token)!,
        priceUsd: price,
        targetBps: t.weight_bps,
      };
    });
    const trade = planRebalance(holdings, r.drift_threshold_bps);
    if (!trade) {
      return { inputs: [], outputs: [], skipped: [], note: `all weights within ${r.drift_threshold_bps} bps of target` };
    }
    return { inputs: trade.sells, outputs: trade.buys, skipped: [] };
  },

  async dca({ cfg, wallet }) {
    const d = cfg.dca;
    if (!d) throw new BotError("config has no dca section");
    await readDecimals(wallet, [d.input.token, ...d.outputs.map((o) => o.token)]);
    const bal = (await readBalances(wallet, [d.input.token])).get(d.input.token) ?? 0n;
    const avail = spendable(d.input.token, bal, cfg.gas_reserve_wei);
    if (avail < d.input.amount) {
      throw new BotError(`balance of ${d.input.token} is ${avail} (spendable), below dca.input.amount ${d.input.amount}`);
    }
    return { inputs: [{ token: d.input.token, amount: d.input.amount }], outputs: d.outputs, skipped: [] };
  },

  async sweep(ctx) {
    const { cfg, wallet } = ctx;
    const s = cfg.sweep;
    if (!s) throw new BotError("config has no sweep section");
    await readDecimals(wallet, [...s.inputs, s.output]);
    const balances = await readBalances(wallet, s.inputs);
    const skipped: Intent["skipped"] = [];
    let candidates: { token: Address; amount: bigint }[] = [];
    for (const token of s.inputs) {
      const amount = spendable(token, balances.get(token) ?? 0n, cfg.gas_reserve_wei);
      if (amount > 0n) candidates.push({ token, amount });
      else skipped.push({ token, reason: token === NATIVE ? "balance at or below gas_reserve_wei" : "zero balance" });
    }
    const outputs = [{ token: s.output, ratio_bps: 10000 }];
    if (candidates.length > 1) {
      // Probe each input alone so one unroutable token is skipped instead of failing the whole sweep.
      const routable: typeof candidates = [];
      for (const c of candidates) {
        try {
          await quoteIntent(ctx, { inputs: [c], outputs, skipped: [] });
          routable.push(c);
        } catch (err) {
          if (!(err instanceof ApiError) || err.status >= 500) throw err;
          skipped.push({ token: c.token, reason: `${err.code}: ${err.message}` });
        }
      }
      candidates = routable;
    }
    return { inputs: candidates, outputs, skipped, note: candidates.length === 0 ? "nothing to sweep" : undefined };
  },
};

function spendable(token: Address, balance: bigint, gasReserve: bigint): bigint {
  if (token !== NATIVE) return balance;
  return balance > gasReserve ? balance - gasReserve : 0n;
}

function quoteIntent(ctx: RunContext, intent: Intent): Promise<Quote> {
  const chain_id = ctx.cfg.chain_id;
  return ctx.api.quote({
    inputs: intent.inputs.map((i) => ({ chain_id, address: i.token, amount: i.amount.toString() })),
    outputs: intent.outputs.map((o) => ({ chain_id, address: o.token, ratio_bps: o.ratio_bps })),
    taker: ctx.wallet.account.address,
    slippage_tolerance_bps: ctx.cfg.slippage_bps,
  });
}

/** Values the trade by its quoted outputs, so the cap holds even when an input (e.g. dust) has no USD price. */
async function outputNotionalUsd(ctx: RunContext, outputs: Plan["outputs"]): Promise<number> {
  const tokens = outputs.map((o) => o.token);
  const [decimals, prices] = await Promise.all([readDecimals(ctx.wallet, tokens), ctx.api.prices(ctx.cfg.chain_id, tokens)]);
  let total = 0;
  for (const o of outputs) {
    const price = prices.get(o.token.toLowerCase());
    if (price === undefined) throw new BotError(`no USD price for output ${o.token}; cannot enforce max_notional_usd`);
    total += usdValue(BigInt(o.expected_amount), decimals.get(o.token)!, price);
  }
  return total;
}

/** The quote's approvals, checked so the bot only ever approves the Router it is about to call, for the amount it sells. */
function approvalsFor(intent: Intent, quote: Quote, router: Address): Approval[] {
  return intent.inputs
    .filter((i) => i.token !== NATIVE)
    .map((i) => {
      const a = quote.approvals?.find((x) => x.token.toLowerCase() === i.token.toLowerCase());
      if (!a) throw new BotError(`quote returned no approval requirement for input ${i.token}; nothing sent`);
      if (a.spender.toLowerCase() !== router.toLowerCase()) {
        throw new BotError(`approval spender ${a.spender} is not the built transaction's Router ${router}; nothing sent`);
      }
      if (BigInt(a.amount) > i.amount) {
        throw new BotError(`quote asks to approve ${a.amount} of ${i.token}, more than the ${i.amount} being sold; nothing sent`);
      }
      return a;
    });
}
