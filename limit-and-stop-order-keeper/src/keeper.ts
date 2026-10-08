import type { Address, Hex } from "viem";
import { fromAtomic, toAtomic } from "./amounts.js";
import type { ChainClients } from "./chain.js";
import { BotError, NATIVE, type KeeperConfig, type Order } from "./config.js";
import { describeTrigger, executablePrice, referencePrice, triggered, worthQuoting } from "./evaluate.js";
import { ApiError, type ChainInfo, type InfraredClient, type Quote } from "./infrared.js";
import type { OrderStatus, StateStore } from "./state.js";

export type Action = "skipped" | "watching" | "armed" | "would_fill" | "filled" | "expired" | "failed" | "done";

export interface OrderTick {
  id: string;
  type: Order["type"];
  status: OrderStatus;
  action: Action;
  reason?: string;
  describe: string;
  price?: number;
  trigger_price: number;
  streak: number;
  confirmations: number;
  notional_usd?: number | null;
  tx_hash?: Hex;
}

export interface Tick {
  at: string;
  execute: boolean;
  orders: OrderTick[];
}

export interface KeeperDeps {
  cfg: KeeperConfig;
  api: InfraredClient;
  chains: ChainClients;
  state: StateStore;
  execute: boolean;
  now?: () => number;
}

const MAX_FAILURES = 3;

/** One evaluation pass over every order. Each pass is independent; fill-once lives in the state store. */
export class Keeper {
  private readonly now: () => number;
  private readonly chainInfoCache = new Map<number, ChainInfo>();
  private chainsPromise?: Promise<ChainInfo[]>;

  constructor(private readonly d: KeeperDeps) {
    this.now = d.now ?? Date.now;
  }

  async tick(): Promise<Tick> {
    const orders: OrderTick[] = [];
    for (const order of this.d.cfg.orders) orders.push(await this.evaluate(order));
    return { at: new Date(this.now()).toISOString(), execute: this.d.execute, orders };
  }

  async chainInfo(chainId: number): Promise<ChainInfo> {
    let c = this.chainInfoCache.get(chainId);
    if (c) return c;
    if (!this.chainsPromise) {
      this.chainsPromise = this.d.api.chains();
      this.chainsPromise.catch(() => (this.chainsPromise = undefined));
    }
    c = (await this.chainsPromise).find((x) => x.chain_id === chainId);
    if (!c) throw new BotError(`chain ${chainId} is not supported by Infrared`);
    this.chainInfoCache.set(chainId, c);
    return c;
  }

  private async evaluate(order: Order): Promise<OrderTick> {
    const { chains, state, api, cfg } = this.d;
    const st = state.get(order.id);
    const [sellSym, buySym] = await Promise.all([chains.symbol(order.chain_id, order.sell.token), chains.symbol(order.chain_id, order.buy.token)]);
    const base: OrderTick = { id: order.id, type: order.type, status: st.status, action: "done", describe: describeTrigger(order, sellSym, buySym), trigger_price: order.trigger_price, streak: st.streak, confirmations: order.confirmations };
    const report = (action: Action, patch: { reason?: string; price?: number; streak?: number; status?: OrderStatus; notional_usd?: number | null; tx_hash?: Hex }): OrderTick => {
      const next = state.set(order.id, { status: patch.status ?? st.status, streak: patch.streak ?? st.streak, last_checked: new Date(this.now()).toISOString(), last_price: patch.price ?? st.last_price, last_reason: patch.reason });
      return { ...base, action, status: next.status, streak: next.streak, reason: patch.reason, price: patch.price, notional_usd: patch.notional_usd, tx_hash: patch.tx_hash };
    };

    if (st.status === "filled") return { ...base, action: "done", reason: `filled in ${st.fill?.tx_hash}`, tx_hash: st.fill?.tx_hash };
    if (st.status === "expired" || st.status === "failed") return { ...base, action: "done", reason: st.last_reason };
    if (st.status === "filling") {
      // The process died mid-fill. Never retry blindly: the swap may have landed.
      return report("failed", { status: "failed", reason: `interrupted mid-fill${st.fill?.tx_hash ? ` after broadcasting ${st.fill.tx_hash}` : ""}; check the wallet, then re-add the order under a new id` });
    }
    if (order.expires && order.expires.getTime() <= this.now()) return report("expired", { status: "expired", streak: 0, reason: `expired at ${order.expires.toISOString()}` });

    const [decIn, decOut] = await Promise.all([chains.decimals(order.chain_id, order.sell.token), chains.decimals(order.chain_id, order.buy.token)]);
    const balance = await chains.balance(order.chain_id, order.sell.token);
    const reserve = order.sell.token.toLowerCase() === NATIVE.toLowerCase() ? cfg.gas_reserve_wei : 0n;
    const amountIn = order.sell.amount === "all" ? balance - reserve : toAtomic(order.sell.amount, decIn, `${order.id}.sell.amount`);
    if (amountIn <= 0n || balance - reserve < amountIn) {
      return report("skipped", { streak: 0, reason: `insufficient balance: have ${fromAtomic(balance, decIn)} ${sellSym}${reserve ? ` (gas reserve ${fromAtomic(reserve, 18)})` : ""}, order needs ${order.sell.amount === "all" ? "> 0" : order.sell.amount}` });
    }

    const prices = await this.usdPrices(order.chain_id, [order.sell.token, order.buy.token]);
    const sellUsd = prices.get(order.sell.token.toLowerCase());
    const buyUsd = prices.get(order.buy.token.toLowerCase());
    const reference = referencePrice(order, sellUsd, buyUsd);
    if (!worthQuoting(order, reference)) {
      return report("watching", { streak: 0, price: reference, reason: `far from trigger: reference ${fmt(reference)} vs ${order.trigger_price} (prefilter ${order.prefilter_bps} bps)` });
    }

    let quote: Quote;
    try {
      quote = await api.quote({
        inputs: [{ chain_id: order.chain_id, address: order.sell.token, amount: amountIn.toString() }],
        outputs: [{ chain_id: order.chain_id, address: order.buy.token, ratio_bps: 10000 }],
        taker: chains.account.address,
        slippage_tolerance_bps: order.slippage_bps,
        include_usd_pricing: true,
        check_allowances: true,
      });
    } catch (err) {
      if (err instanceof ApiError) return report("watching", { streak: 0, reason: `quote failed: ${err.code} ${err.message}` });
      throw err;
    }
    const est = quote.estimated_outputs[0];
    if (!est) return report("watching", { streak: 0, reason: "quote returned no output estimate" });
    const price = executablePrice(order, amountIn, BigInt(est.expected_amount), decIn, decOut);
    if (!triggered(order, price)) return report("watching", { streak: 0, price, reason: `executable ${fmt(price)} vs trigger ${order.trigger_price}` });

    const notional = sellUsd === undefined ? null : Number(fromAtomic(amountIn, decIn)) * sellUsd;
    if (notional === null) return report("skipped", { streak: 0, price, reason: `no USD price for ${sellSym}; cannot check max_notional_usd` });
    if (notional > order.max_notional_usd) return report("skipped", { streak: 0, price, notional_usd: notional, reason: `notional $${notional.toFixed(2)} exceeds max_notional_usd $${order.max_notional_usd}` });

    const streak = st.streak + 1;
    if (streak < order.confirmations) return report("armed", { streak, price, notional_usd: notional, reason: `triggered ${streak}/${order.confirmations} ticks` });
    if (!this.d.execute) return report("would_fill", { streak, price, notional_usd: notional, reason: `dry run: would sell ${fromAtomic(amountIn, decIn)} ${sellSym} for >= ${fromAtomic(est.minimum_amount, decOut)} ${buySym}` });

    state.set(order.id, { streak });
    return this.fill(order, quote, amountIn, price, notional, decIn, decOut, buySym, st.failures, base.describe);
  }

  private async fill(order: Order, quote: Quote, amountIn: bigint, price: number, notional: number, decIn: number, decOut: number, buySym: string, failures: number, describe: string): Promise<OrderTick> {
    const { chains, state, api } = this.d;
    const outBefore = await chains.balance(order.chain_id, order.buy.token);
    state.set(order.id, { status: "filling", last_reason: "filling" });
    let approvals: Hex[] = [];
    let hash: Hex;
    let gas: bigint;
    try {
      // Build before any approval so a rejected API key or unbuildable quote broadcasts nothing.
      const built = await api.build(quote.quote_id);
      approvals = await chains.ensureApprovals(order.chain_id, quote.approvals ?? []);
      const pre = await chains.preflight(built);
      if (!pre.ok) throw new BotError(`pre-flight reverted, nothing sent: ${pre.error}`);
      gas = pre.gas;
      hash = await chains.broadcast(built, gas);
    } catch (err) {
      const n = failures + 1;
      const reason = `fill attempt ${n} failed before broadcast: ${(err as Error).message}`;
      const status: OrderStatus = n >= MAX_FAILURES ? "failed" : "pending";
      state.set(order.id, { status, streak: 0, failures: n, last_reason: reason });
      return this.tickFor(order, status, n >= MAX_FAILURES ? "failed" : "watching", reason, price, describe);
    }
    // Broadcast: record the hash before waiting so a crash here is visible as "interrupted after broadcasting".
    state.set(order.id, { fill: { tx_hash: hash, approval_tx_hashes: approvals, at: new Date(this.now()).toISOString(), price, amount_in: fromAtomic(amountIn, decIn), amount_out: "pending", notional_usd: notional } });
    const receipt = await chains.waitForReceipt(order.chain_id, hash);
    if (!receipt.success) {
      const n = failures + 1;
      const reason = `swap ${hash} reverted on-chain (attempt ${n})`;
      const status: OrderStatus = n >= MAX_FAILURES ? "failed" : "pending";
      state.set(order.id, { status, streak: 0, failures: n, last_reason: reason, fill: undefined });
      return this.tickFor(order, status, n >= MAX_FAILURES ? "failed" : "watching", reason, price, describe, hash);
    }
    const outAfter = await chains.balance(order.chain_id, order.buy.token);
    const received = fromAtomic(outAfter - outBefore, decOut);
    const s = state.get(order.id);
    state.set(order.id, { status: "filled", last_reason: `filled: received ${received} ${buySym}`, fill: { ...(s.fill as NonNullable<typeof s.fill>), amount_out: received } });
    return this.tickFor(order, "filled", "filled", `received ${received} ${buySym} in block ${receipt.block_number}`, price, describe, hash, notional);
  }

  private tickFor(order: Order, status: OrderStatus, action: Action, reason: string, price: number, describe: string, hash?: Hex, notional?: number): OrderTick {
    const st = this.d.state.get(order.id);
    return { id: order.id, type: order.type, status, action, reason, describe, price, trigger_price: order.trigger_price, streak: st.streak, confirmations: order.confirmations, notional_usd: notional, tx_hash: hash };
  }

  /** USD prices keyed by lower-cased address; the native currency is priced through its wrapped token. */
  private async usdPrices(chainId: number, tokens: Address[]): Promise<Map<string, number>> {
    const wrapped = (await this.chainInfo(chainId)).wrapped_native_address;
    const isNative = (a: Address) => a.toLowerCase() === NATIVE.toLowerCase();
    const raw = await this.d.api.prices(chainId, [...new Set(tokens.map((t) => (isNative(t) ? wrapped : t)))]);
    const out = new Map<string, number>();
    for (const t of tokens) {
      const p = raw.get((isNative(t) ? wrapped : t).toLowerCase());
      if (p !== undefined) out.set(t.toLowerCase(), p);
    }
    return out;
  }
}

function fmt(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "n/a";
  return n >= 1000 ? n.toFixed(2) : n.toPrecision(6);
}
