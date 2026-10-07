import { encodeFunctionData, erc20Abi, numberToHex, type Address, type Hex } from "viem";
import { fromAtomic, notionalUsd, toAtomic } from "./amounts.js";
import type { ChainReaders } from "./chain.js";
import { MAX_QUOTE_AGE_MS, NATIVE, ToolError, type BotConfig } from "./config.js";
import type { Approval, InfraredClient, Quote, QuoteOutput, QuoteRequest } from "./infrared.js";
import type { ParsedTrade } from "./parse.js";
import type { TokenResolver } from "./tokens.js";
import type { WalletLink } from "./wallet.js";

export interface TradeUser {
  id: number;
  chainId: number;
  slippageBps: number;
  address: Address;
}

export interface PendingQuote {
  id: string;
  userId: number;
  chainId: number;
  address: Address;
  slippageBps: number;
  createdAt: number;
  quote: Quote;
  /** lower-cased token -> decimals / symbol for every token in the quote. */
  decimals: Map<string, number>;
  symbols: Map<string, string>;
  pricesUsd: Map<string, number>;
  notionalUsd: number | null;
  execution?: { startedAt: number; txHash?: Hex };
}

export interface ExecutionResult {
  hash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
  approvalHashes: Hex[];
  outputs: { token: Address; symbol: string; expected: string; minimum: string; received: string }[];
  balanceChanges: { token: Address; symbol: string; delta: string }[];
}

const RETENTION_MS = 10 * 60_000;

/** Quote -> approve -> build -> pre-flight -> sign in the user's wallet -> receipt. Holds the quotes it created so only those can be executed. */
export class TradeService {
  private readonly pending = new Map<string, PendingQuote>();

  constructor(
    private readonly cfg: BotConfig,
    private readonly api: InfraredClient,
    private readonly tokens: TokenResolver,
    private readonly chains: ChainReaders,
    private readonly wallet: WalletLink,
    private readonly now: () => number = Date.now,
  ) {}

  lower(a: string): string {
    return a.toLowerCase();
  }

  async quote(user: TradeUser, parsed: ParsedTrade): Promise<PendingQuote> {
    if (!this.cfg.chains.includes(user.chainId)) throw new ToolError(`chain ${user.chainId} is not enabled on this bot`);
    if (user.slippageBps > this.cfg.maxSlippageBps) throw new ToolError(`slippage ${user.slippageBps} bps exceeds this bot's maximum of ${this.cfg.maxSlippageBps} bps`);
    const chainId = user.chainId;
    const decimals = new Map<string, number>();
    const symbols = new Map<string, string>();
    const resolveSide = async (idents: string[]) => {
      const addrs = await Promise.all(idents.map((t) => this.tokens.resolve(chainId, t)));
      await Promise.all(
        addrs.map(async (a) => {
          decimals.set(this.lower(a), await this.tokens.decimals(chainId, a));
          symbols.set(this.lower(a), await this.tokens.symbol(chainId, a));
        }),
      );
      return addrs;
    };
    const inAddrs = await resolveSide(parsed.inputs.map((i) => i.token));
    const outAddrs = await resolveSide(parsed.outputs.map((o) => o.token));
    const all = [...inAddrs, ...outAddrs].map(this.lower);
    if (new Set(all).size !== all.length) throw new ToolError("the same token appears twice in the trade");

    const inputs = parsed.inputs.map((i, k) => {
      const a = inAddrs[k] as Address;
      return { chain_id: chainId, address: a, amount: toAtomic(i.amount, decimals.get(this.lower(a)) as number, i.token).toString() };
    });
    const outputs: QuoteOutput[] = parsed.outputs.map((o, k) => ({ chain_id: chainId, address: outAddrs[k] as Address, ratio_bps: o.ratioBps }));

    // Balance check up front so the user hears "you only have X" instead of a pre-flight revert later.
    for (const i of inputs) {
      const have = await this.chains.balance(chainId, user.address, i.address);
      if (have < BigInt(i.amount)) {
        const d = decimals.get(this.lower(i.address)) as number;
        throw new ToolError(`you hold ${fromAtomic(have, d)} ${symbols.get(this.lower(i.address)) || i.address}, not ${fromAtomic(i.amount, d)}`);
      }
    }

    const wrapped = (await this.tokens.chainInfo(chainId)).wrapped_native_address;
    const priceAddrs = [...new Set([...inAddrs, ...outAddrs].map((a) => (this.lower(a) === this.lower(NATIVE) ? wrapped : a)))];
    const rawPrices = await this.api.prices(chainId, priceAddrs);
    const pricesUsd = new Map<string, number>();
    for (const a of [...inAddrs, ...outAddrs]) {
      const p = rawPrices.get(this.lower(this.lower(a) === this.lower(NATIVE) ? wrapped : a));
      if (p !== undefined) pricesUsd.set(this.lower(a), p);
    }
    const notional = notionalUsd(inputs.map((i) => ({ token: i.address, atomic: BigInt(i.amount), decimals: decimals.get(this.lower(i.address)) as number, priceUsd: pricesUsd.get(this.lower(i.address)) })));

    const req: QuoteRequest = {
      inputs,
      outputs,
      taker: user.address,
      slippage_tolerance_bps: user.slippageBps,
      include_usd_pricing: true,
      check_allowances: true,
    };
    if (this.cfg.partnerFeeBps > 0 && this.cfg.partnerRecipient) {
      req.partner_fee = { partner_fee_bps: this.cfg.partnerFeeBps, partner_recipient: this.cfg.partnerRecipient, partner_fee_on_output: this.cfg.partnerFeeOnOutput };
    }
    const quote = await this.api.quote(req);
    const p: PendingQuote = { id: quote.quote_id, userId: user.id, chainId, address: user.address, slippageBps: user.slippageBps, createdAt: this.now(), quote, decimals, symbols, pricesUsd, notionalUsd: notional.usd };
    this.prune();
    this.pending.set(p.id, p);
    return p;
  }

  /** The quote must exist, belong to this user and be young enough for build + wallet prompt to fit in Infrared's 2-minute window. */
  take(quoteId: string, userId: number): PendingQuote {
    this.prune();
    const p = this.pending.get(quoteId);
    if (!p || p.userId !== userId) throw new ToolError("this quote is not yours or has expired; run /swap again");
    return p;
  }

  isFresh(p: PendingQuote): boolean {
    return this.now() - p.createdAt <= MAX_QUOTE_AGE_MS;
  }

  async execute(p: PendingQuote, topic: string, progress: (text: string) => Promise<void>): Promise<ExecutionResult> {
    if (p.execution) throw new ToolError(p.execution.txHash ? `this quote was already executed in ${p.execution.txHash}` : "this quote is already being executed");
    if (!this.isFresh(p)) throw new ToolError("this quote is older than 90 seconds; run /swap again for a fresh price");
    const sym = (a: string) => p.symbols.get(this.lower(a)) || a;
    const dec = (a: string) => p.decimals.get(this.lower(a)) as number;
    const watched = [...new Set([...p.quote.inputs.map((i) => i.address), ...p.quote.estimated_outputs.map((o) => o.token)])];
    const before = await this.balances(p.chainId, p.address, watched);

    p.execution = { startedAt: this.now() };
    let hash: Hex;
    const approvalHashes: Hex[] = [];
    try {
      for (const a of await this.missingApprovals(p)) {
        const need = BigInt(a.amount);
        const current = await this.chains.allowance(p.chainId, p.address, a.token, a.spender);
        if (current > 0n && a.requires_zero_reset) {
          await progress(`Approve resetting ${sym(a.token)} allowance to 0 in your wallet (this token requires it)...`);
          await this.approve(p, topic, a, 0n);
        }
        await progress(`Approve ${fromAtomic(need, dec(a.token))} ${sym(a.token)} for the Infrared Router in your wallet...`);
        approvalHashes.push(await this.approve(p, topic, a, need));
      }
      if (!this.isFresh(p)) throw new ToolError("the quote expired while approving; approvals are done, run /swap again");
      await progress("Building the transaction...");
      const built = await this.api.build(p.id);
      const pre = await this.chains.preflight(built, p.address);
      if (!pre.ok) throw new ToolError(`pre-flight simulation reverted, nothing sent: ${pre.error}`);
      await progress("Confirm the swap in your wallet...");
      hash = await this.wallet.sendTransaction(topic, p.chainId, {
        from: p.address,
        to: built.transaction.to,
        data: built.transaction.data,
        value: built.transaction.value,
        gas: numberToHex(pre.gas_limit),
      });
    } catch (err) {
      p.execution = undefined;
      throw err;
    }
    p.execution.txHash = hash;
    await progress(`Sent <code>${hash}</code>, waiting for confirmation...`);
    const receipt = await this.chains.waitForReceipt(p.chainId, hash);
    if (!receipt.success) throw new ToolError(`the swap reverted on-chain (${hash}); your tokens did not move. Run /swap again.`);
    const after = await this.balances(p.chainId, p.address, watched);
    return {
      hash,
      blockNumber: receipt.block_number,
      gasUsed: receipt.gas_used,
      approvalHashes,
      outputs: p.quote.estimated_outputs.map((o) => ({
        token: o.token,
        symbol: sym(o.token),
        expected: fromAtomic(o.expected_amount, dec(o.token)),
        minimum: fromAtomic(o.minimum_amount, dec(o.token)),
        received: fromAtomic((after.get(this.lower(o.token)) as bigint) - (before.get(this.lower(o.token)) as bigint), dec(o.token)),
      })),
      balanceChanges: watched.map((t) => ({ token: t, symbol: sym(t), delta: fromAtomic((after.get(this.lower(t)) as bigint) - (before.get(this.lower(t)) as bigint), dec(t)) })),
    };
  }

  private async missingApprovals(p: PendingQuote): Promise<Approval[]> {
    const out: Approval[] = [];
    for (const a of p.quote.approvals ?? []) {
      if (this.lower(a.token) === this.lower(NATIVE)) continue;
      const have = await this.chains.allowance(p.chainId, p.address, a.token, a.spender);
      if (have < BigInt(a.amount)) out.push(a);
    }
    return out;
  }

  /** Exact-amount approve sent from the user's wallet; never unlimited. */
  private async approve(p: PendingQuote, topic: string, a: Approval, amount: bigint): Promise<Hex> {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [a.spender, amount] });
    const pub = await this.chains.pub(p.chainId);
    const estimate = await pub.estimateGas({ account: p.address, to: a.token, data });
    const hash = await this.wallet.sendTransaction(topic, p.chainId, { from: p.address, to: a.token, data, value: "0x0", gas: numberToHex((estimate * 3n) / 2n) });
    const r = await this.chains.waitForReceipt(p.chainId, hash);
    if (!r.success) throw new ToolError(`the approval transaction ${hash} reverted`);
    return hash;
  }

  private async balances(chainId: number, owner: Address, tokens: Address[]): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    await Promise.all(tokens.map(async (t) => out.set(this.lower(t), await this.chains.balance(chainId, owner, t))));
    return out;
  }

  private prune(): void {
    const cutoff = this.now() - RETENTION_MS;
    for (const [id, p] of this.pending) if (p.createdAt < cutoff) this.pending.delete(id);
  }
}
