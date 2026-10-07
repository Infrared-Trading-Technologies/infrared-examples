import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Address, Hex } from "viem";
import { z } from "zod";
import { fromAtomic, notionalUsd, toAtomic, bpsDiff, type Priced } from "./amounts.js";
import { ChainClients } from "./chain.js";
import { MAX_QUOTE_AGE_MS, MAX_TOKENS_PER_SIDE, NATIVE, ToolError, type ServerConfig } from "./config.js";
import { checkConfirmed, checkNotional, checkQuoteFresh, checkSlippage, checkTaker } from "./guards.js";
import { InfraredClient, type Approval, type Build, type QuoteOutput, type QuoteRequest } from "./infrared.js";
import { QuoteStore, lower, type StoredQuote } from "./quotes.js";
import { TokenResolver } from "./tokens.js";

export const SERVER_NAME = "infrared-trading-mcp";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `Infrared trading tools. Flow: get_quote -> (show the user amounts, minimum outputs and USD value) -> execute_trade with confirm=true.
Amounts are human units ("1.5"), never wei; tokens are addresses or exact symbols (ETH = native currency).
A quote is valid for 2 minutes and only quotes created here can be executed. Nothing is sent unless the server was started with EXECUTE_ENABLED=true; otherwise execute_trade is a dry-run that stops after the local pre-flight.
Every trade is capped by MAX_NOTIONAL_USD and MAX_SLIPPAGE_BPS. Approvals are exact-amount, to the Infrared Router only.`;

const addressOrSymbol = z.string().min(1).max(64).describe("Token contract address, or exact symbol (e.g. USDC). ETH/the chain's native symbol or the zero address = native currency.");
const chainId = z.number().int().positive().describe("Chain ID (1 Ethereum, 8453 Base, 42161 Arbitrum; see list_chains)");
const optAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional();

export interface Deps {
  now?: () => number;
}

export function createServer(cfg: ServerConfig, deps: Deps = {}): McpServer {
  const now = deps.now ?? Date.now;
  const api = new InfraredClient(cfg.apiUrl, cfg.apiKey);
  const tokens = new TokenResolver(api);
  const chains = new ChainClients(cfg, (id) => tokens.chainInfo(id));
  tokens.attach(chains);
  const store = new QuoteStore(now);
  const wallet = chains.account?.address;

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

  /** USD prices keyed by lower-cased address; the native currency is priced through its wrapped token. */
  const pricesFor = async (chainId: number, addrs: Address[]): Promise<Map<string, number>> => {
    const wrapped = (await tokens.chainInfo(chainId)).wrapped_native_address;
    const isNative = (a: Address) => lower(a) === lower(NATIVE);
    const prices = await api.prices(chainId, [...new Set(addrs.map((a) => (isNative(a) ? wrapped : a)))]);
    const out = new Map<string, number>();
    for (const a of addrs) {
      const p = prices.get(lower(isNative(a) ? wrapped : a));
      if (p !== undefined) out.set(lower(a), p);
    }
    return out;
  };

  /** Balances from the user's own RPC when one is configured for the chain (the chain they trade on), else via the API. */
  const balancesFor = async (chainId: number, owner: Address, addrs: Address[]): Promise<Map<string, bigint>> => {
    if (!chains.hasRpc(chainId)) return api.balances(chainId, owner, addrs);
    const out = new Map<string, bigint>();
    await Promise.all(
      addrs.map(async (a) => {
        try {
          out.set(lower(a), await chains.balance(chainId, owner, a));
        } catch {
          // unresolved reads are omitted, matching the API's absent == unknown contract
        }
      }),
    );
    return out;
  };

  const allowancesFor = async (chainId: number, owner: Address, pairs: { token: Address; spender: Address }[]): Promise<Map<string, bigint>> => {
    if (!chains.hasRpc(chainId)) return api.allowances(chainId, owner, pairs);
    const out = new Map<string, bigint>();
    await Promise.all(
      pairs.map(async (p) => {
        try {
          out.set(`${lower(p.token)}:${lower(p.spender)}`, await chains.allowance(chainId, owner, p.token, p.spender));
        } catch {
          // omitted == unknown
        }
      }),
    );
    return out;
  };

  const ownerOf = (owner: string | undefined, field = "owner"): Address => {
    if (owner) return owner as Address;
    if (wallet) return wallet;
    throw new ToolError(`${field} is required when no PRIVATE_KEY wallet is configured`);
  };

  server.registerTool(
    "get_wallet_status",
    {
      title: "Wallet and safety status",
      description: "The trading wallet address (if configured), whether execution is enabled, the notional and slippage caps, and which chains have an RPC.",
      inputSchema: {},
      annotations: readOnly,
    },
    () =>
      run(async () => ({
        wallet_address: wallet ?? null,
        execute_enabled: cfg.executeEnabled,
        mode: cfg.executeEnabled ? "live" : "dry-run (set EXECUTE_ENABLED=true to send transactions)",
        api_key_configured: Boolean(cfg.apiKey),
        max_notional_usd: cfg.maxNotionalUsd,
        max_slippage_bps: cfg.maxSlippageBps,
        chains_with_rpc: chains.configuredChains(),
        api_url: cfg.apiUrl,
      })),
  );

  server.registerTool(
    "list_chains",
    { title: "Supported chains", description: "Chains Infrared routes on, with health and whether this server has an RPC for them.", inputSchema: {}, annotations: readOnly },
    () =>
      run(async () => {
        const list = [...(await tokens.allChains()).values()];
        return list.map((c) => ({
          chain_id: c.chain_id,
          name: c.name,
          native_symbol: c.native_symbol,
          wrapped_native_address: c.wrapped_native_address,
          healthy: c.healthy,
          is_l2: c.is_l2,
          block_explorer_url: c.block_explorer_url,
          rpc_configured: chains.hasRpc(c.chain_id),
        }));
      }),
  );

  server.registerTool(
    "list_protocols",
    { title: "Routable protocols", description: "Protocols and products Infrared can route through; ids are usable in get_quote include/exclude_protocols.", inputSchema: { chain_id: chainId.optional() }, annotations: readOnly },
    ({ chain_id }) => run(() => api.protocols(chain_id)),
  );

  server.registerTool(
    "search_tokens",
    {
      title: "Search tokens",
      description: "Find tokens by symbol, name, address or tags in the Infrared registry. pool_count is a liquidity/popularity signal.",
      inputSchema: {
        chain_id: chainId.optional().describe("Omit to search every chain"),
        query: z.string().max(64).optional().describe("Substring of symbol or name, or a 0x address"),
        tags: z.string().max(200).optional().describe("Comma-separated tags, AND semantics (e.g. type:vault,protocol:morpho)"),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: readOnly,
    },
    ({ chain_id, query, tags, limit }) =>
      run(async () => {
        const res = await api.tokens({ chain_id, search: query, tags, limit: limit ?? 25 });
        return {
          tokens: res.tokens.map((t) => ({ chain_id: t.chain_id, address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, pool_count: t.pool_count, tags: t.tags ?? [] })),
          has_more: res.pagination.has_more,
        };
      }),
  );

  server.registerTool(
    "get_prices",
    { title: "USD prices", description: "USD price per token. Tokens without a price are returned as null, never guessed.", inputSchema: { chain_id: chainId, tokens: z.array(addressOrSymbol).min(1).max(50) }, annotations: readOnly },
    ({ chain_id, tokens: idents }) =>
      run(async () => {
        const addrs = await Promise.all(idents.map((t) => tokens.resolve(chain_id, t)));
        const prices = await pricesFor(chain_id, addrs);
        return Promise.all(addrs.map(async (a, i) => ({ input: idents[i], token: a, symbol: await tokens.symbol(chain_id, a), price_usd: prices.get(lower(a)) ?? null })));
      }),
  );

  server.registerTool(
    "get_balances",
    {
      title: "Token balances",
      description: "Balances of an owner (default: this server's wallet) for up to 100 tokens, with USD value where priced. Read from RPC_URL_<chain_id> when configured, else via Infrared. A token with balance null could not be read (unknown, not zero).",
      inputSchema: { chain_id: chainId, owner: optAddress.describe("Defaults to the configured wallet"), tokens: z.array(addressOrSymbol).min(1).max(100) },
      annotations: readOnly,
    },
    ({ chain_id, owner, tokens: idents }) =>
      run(async () => {
        const who = ownerOf(owner);
        const addrs = await Promise.all(idents.map((t) => tokens.resolve(chain_id, t)));
        const [bals, prices] = await Promise.all([balancesFor(chain_id, who, addrs), pricesFor(chain_id, addrs)]);
        const balances = await Promise.all(
          addrs.map(async (a, i) => {
            const raw = bals.get(lower(a));
            if (raw === undefined) return { input: idents[i], token: a, balance: null, note: "balance read did not resolve" };
            const symbol = await tokens.symbol(chain_id, a);
            let decimals: number | undefined;
            try {
              decimals = await tokens.decimals(chain_id, a);
            } catch {
              decimals = undefined;
            }
            const price = prices.get(lower(a));
            const human = decimals === undefined ? undefined : fromAtomic(raw, decimals);
            return {
              input: idents[i],
              token: a,
              symbol,
              balance: human ?? null,
              balance_atomic: raw.toString(),
              decimals: decimals ?? null,
              usd: human !== undefined && price !== undefined ? Number(human) * price : null,
            };
          }),
        );
        return { chain_id, owner: who, balances };
      }),
  );

  server.registerTool(
    "get_allowances",
    {
      title: "ERC-20 allowances",
      description: "On-chain allowance(owner, spender) for (token, spender) pairs. Use the spender from get_quote approvals_needed (the Infrared Router). Missing pairs could not be read.",
      inputSchema: {
        chain_id: chainId,
        owner: optAddress.describe("Defaults to the configured wallet"),
        pairs: z.array(z.object({ token: addressOrSymbol, spender: z.string().regex(/^0x[0-9a-fA-F]{40}$/) })).min(1).max(50),
      },
      annotations: readOnly,
    },
    ({ chain_id, owner, pairs }) =>
      run(async () => {
        const who = ownerOf(owner);
        const resolved = await Promise.all(pairs.map(async (p) => ({ token: await tokens.resolve(chain_id, p.token), spender: p.spender as Address })));
        const res = await allowancesFor(chain_id, who, resolved);
        return {
          chain_id,
          owner: who,
          allowances: await Promise.all(
            resolved.map(async (p, i) => {
              const raw = res.get(`${lower(p.token)}:${lower(p.spender)}`);
              const decimals = raw === undefined ? undefined : await tokens.decimals(chain_id, p.token).catch(() => undefined);
              return {
                input: pairs[i]?.token,
                token: p.token,
                spender: p.spender,
                allowance: raw === undefined ? null : decimals === undefined ? null : fromAtomic(raw, decimals),
                allowance_atomic: raw?.toString() ?? null,
              };
            }),
          ),
        };
      }),
  );

  server.registerTool(
    "get_network",
    { title: "Gas and block", description: "Current EIP-1559 gas tiers and latest block for a chain.", inputSchema: { chain_id: chainId }, annotations: readOnly },
    ({ chain_id }) => run(() => api.network(chain_id)),
  );

  server.registerTool(
    "get_quote",
    {
      title: "Quote a trade",
      description:
        "Price a swap of up to 6 input tokens into up to 6 output tokens in ONE transaction. Outputs are either proportional (ratio_bps summing to 10000) or exact amounts (amount; at least one output must be a ratio). Returns quote_id (valid 2 minutes), expected and minimum outputs, USD value, price impact, gas, and the approvals the taker still needs. Anonymous: no API key required.",
      inputSchema: {
        chain_id: chainId,
        inputs: z.array(z.object({ token: addressOrSymbol, amount: z.string().describe('Human amount to sell, e.g. "0.5"') })).min(1).max(MAX_TOKENS_PER_SIDE),
        outputs: z
          .array(
            z.object({
              token: addressOrSymbol,
              ratio_bps: z.number().int().min(1).max(10000).optional().describe("Share of the remaining value, in bps; all ratio outputs must sum to 10000"),
              amount: z.string().optional().describe("Exact human amount to receive (exact-out); mutually exclusive with ratio_bps"),
            }),
          )
          .min(1)
          .max(MAX_TOKENS_PER_SIDE),
        slippage_bps: z.number().int().min(0).max(5000).optional().describe("Default 50; capped by MAX_SLIPPAGE_BPS"),
        taker: optAddress.describe("Defaults to the configured wallet. Must be the account that will send the transaction (direct msg.sender)."),
        recipient: optAddress.describe("Defaults to taker"),
        include_protocols: z.array(z.string()).max(50).optional(),
        exclude_protocols: z.array(z.string()).max(50).optional(),
      },
      annotations: readOnly,
    },
    (args) =>
      run(async () => {
        const chain = await tokens.chainInfo(args.chain_id);
        const taker = ownerOf(args.taker, "taker");
        const slippage = args.slippage_bps ?? Math.min(50, cfg.maxSlippageBps);
        checkSlippage(slippage, cfg.maxSlippageBps);

        const decimals = new Map<string, number>();
        const symbols = new Map<string, string>();
        const resolveSide = async (idents: string[]) => {
          const addrs = await Promise.all(idents.map((t) => tokens.resolve(args.chain_id, t)));
          await Promise.all(
            addrs.map(async (a) => {
              decimals.set(lower(a), await tokens.decimals(args.chain_id, a));
              symbols.set(lower(a), await tokens.symbol(args.chain_id, a));
            }),
          );
          return addrs;
        };
        const inAddrs = await resolveSide(args.inputs.map((i) => i.token));
        const outAddrs = await resolveSide(args.outputs.map((o) => o.token));
        if (new Set(inAddrs.map(lower)).size !== inAddrs.length) throw new ToolError("duplicate input token");
        if (new Set(outAddrs.map(lower)).size !== outAddrs.length) throw new ToolError("duplicate output token");

        const inputs = args.inputs.map((i, k) => {
          const a = inAddrs[k] as Address;
          return { chain_id: args.chain_id, address: a, amount: toAtomic(i.amount, decimals.get(lower(a)) as number, `inputs[${k}] ${i.token}`).toString() };
        });
        const outputs: QuoteOutput[] = args.outputs.map((o, k) => {
          const a = outAddrs[k] as Address;
          if (o.amount !== undefined && o.ratio_bps !== undefined) throw new ToolError(`outputs[${k}]: give either ratio_bps or amount, not both`);
          if (o.amount !== undefined) {
            return { chain_id: args.chain_id, address: a, amount: toAtomic(o.amount, decimals.get(lower(a)) as number, `outputs[${k}] ${o.token}`).toString() };
          }
          return { chain_id: args.chain_id, address: a, ratio_bps: o.ratio_bps ?? (args.outputs.length === 1 ? 10000 : undefined) };
        });
        const ratioOutputs = outputs.filter((o) => o.ratio_bps !== undefined);
        if (ratioOutputs.length === 0) throw new ToolError("at least one output must be proportional (ratio_bps); inputs are fixed so an all-exact-out request is over-determined");
        if (outputs.some((o) => o.ratio_bps === undefined && o.amount === undefined)) throw new ToolError("every output needs ratio_bps or amount when there is more than one output");
        const ratioSum = ratioOutputs.reduce((s, o) => s + (o.ratio_bps as number), 0);
        if (ratioSum !== 10000) throw new ToolError(`ratio_bps of proportional outputs must sum to 10000, got ${ratioSum}`);

        const prices = await pricesFor(args.chain_id, inAddrs);
        const priced: Priced[] = inputs.map((i) => ({ token: i.address, atomic: BigInt(i.amount), decimals: decimals.get(lower(i.address)) as number, priceUsd: prices.get(lower(i.address)) }));
        const notional = notionalUsd(priced);

        const req: QuoteRequest = {
          inputs,
          outputs,
          taker,
          slippage_tolerance_bps: slippage,
          include_usd_pricing: true,
          check_allowances: true,
        };
        if (args.recipient) req.recipient = args.recipient as Address;
        if (args.include_protocols?.length) req.include_protocols = args.include_protocols;
        if (args.exclude_protocols?.length) req.exclude_protocols = args.exclude_protocols;
        const quote = await api.quote(req);
        const createdAt = now();
        const stored: StoredQuote = { quote, chainId: args.chain_id, createdAt, slippageBps: slippage, notionalUsd: notional.usd, unpriced: notional.unpriced, decimals, symbols };
        store.put(stored);

        const warnings: string[] = [];
        if (notional.usd === null) warnings.push(`no USD price for ${notional.unpriced.join(", ")}: execute_trade will refuse this quote`);
        else if (notional.usd > cfg.maxNotionalUsd) warnings.push(`inputs worth $${notional.usd.toFixed(2)} exceed MAX_NOTIONAL_USD ($${cfg.maxNotionalUsd}): execute_trade will refuse`);
        if (!chains.hasRpc(args.chain_id)) warnings.push(`no RPC_URL_${args.chain_id}: build_transaction cannot pre-flight and execute_trade is unavailable on this chain`);
        if (!cfg.executeEnabled) warnings.push("EXECUTE_ENABLED is not true: execute_trade will dry-run only");

        const fmt = (a: Address, atomic: string) => fromAtomic(atomic, decimals.get(lower(a)) as number);
        return {
          quote_id: quote.quote_id,
          chain_id: args.chain_id,
          chain: chain.name,
          taker,
          created_at: new Date(createdAt).toISOString(),
          execute_before: new Date(createdAt + MAX_QUOTE_AGE_MS).toISOString(),
          slippage_bps: slippage,
          inputs: inputs.map((i) => ({
            token: i.address,
            symbol: symbols.get(lower(i.address)),
            amount: fmt(i.address, i.amount),
            amount_atomic: i.amount,
            usd: prices.get(lower(i.address)) === undefined ? null : Number(fmt(i.address, i.amount)) * (prices.get(lower(i.address)) as number),
          })),
          outputs: quote.estimated_outputs.map((o) => ({
            token: o.token,
            symbol: symbols.get(lower(o.token)),
            expected_amount: fmt(o.token, o.expected_amount),
            minimum_amount: fmt(o.token, o.minimum_amount),
            expected_atomic: o.expected_amount,
            minimum_atomic: o.minimum_amount,
            price_impact_bps: o.price_impact_bps ?? null,
          })),
          notional_usd: notional.usd,
          max_notional_usd: cfg.maxNotionalUsd,
          total_price_impact_bps: quote.total_price_impact_bps ?? null,
          protocols_used: quote.protocols_used ?? [],
          gas: { units: quote.costs?.total_gas_units ?? null, cost_usd: quote.costs?.gas_cost_usd ?? null, priority: quote.costs?.gas_priority ?? null },
          approvals_needed: approvalsView(quote.approvals ?? [], decimals, symbols),
          warnings,
        };
      }),
  );

  server.registerTool(
    "build_transaction",
    {
      title: "Build the transaction",
      description:
        "Assemble a quote into an unsigned Router transaction (to, data, value, gas) and pre-flight it with eth_call from the taker on the configured RPC. Needs INFRARED_API_KEY. Sends nothing. The transaction embeds an Infrared-signed authorization that expires about 3 minutes after build.",
      inputSchema: { quote_id: z.string().min(1).max(128) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    ({ quote_id }) =>
      run(async () => {
        const stored = store.get(quote_id);
        checkQuoteFresh(stored.createdAt, now());
        const built = await api.build(quote_id);
        const preflight = chains.hasRpc(stored.chainId)
          ? await chains.preflight(built, stored.quote.taker)
          : { ok: null, gas_limit: (BigInt(built.transaction.gas) * 2n).toString(), error: `skipped: no RPC_URL_${stored.chainId}` };
        return {
          quote_id,
          transaction: built.transaction,
          send_with_gas_limit: preflight.gas_limit,
          estimated_outputs: built.estimated_outputs.map((o) => ({ token: o.token, expected_amount: fromAtomic(o.expected_amount, stored.decimals.get(lower(o.token)) as number), minimum_amount: fromAtomic(o.minimum_amount, stored.decimals.get(lower(o.token)) as number) })),
          preflight,
          approvals_needed: approvalsView(stored.quote.approvals ?? [], stored.decimals, stored.symbols),
          note: preflight.ok === false && (stored.quote.approvals?.length ?? 0) > 0 ? "pre-flight reverted; the taker is probably missing the approvals listed above" : undefined,
        };
      }),
  );

  const approvalsFor = async (stored: StoredQuote, owner: Address) => {
    const list = stored.quote.approvals ?? [];
    if (list.length === 0) return [];
    const current = await allowancesFor(stored.chainId, owner, list.map((a) => ({ token: a.token, spender: a.spender })));
    return list.filter((a) => {
      const have = current.get(`${lower(a.token)}:${lower(a.spender)}`);
      return have === undefined || have < BigInt(a.amount);
    });
  };

  server.registerTool(
    "approve_token",
    {
      title: "Approve the Router (exact amount)",
      description:
        "Send the exact-amount ERC-20 approvals a quote needs, to the Infrared Router only. Guarded: needs PRIVATE_KEY, confirm=true, and EXECUTE_ENABLED=true (otherwise a dry-run listing what would be sent). execute_trade does this automatically, so only use it when the user wants to approve first.",
      inputSchema: { quote_id: z.string().min(1).max(128), confirm: z.boolean().optional().describe("Must be true after the user agreed") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ quote_id, confirm }) =>
      run(async () => {
        const stored = store.get(quote_id);
        if (!wallet) throw new ToolError("no wallet configured: set PRIVATE_KEY");
        checkTaker(stored.quote.taker, wallet);
        checkConfirmed(confirm, "approve_token");
        const pending = await approvalsFor(stored, wallet);
        const view = approvalsView(pending, stored.decimals, stored.symbols);
        if (pending.length === 0) return { quote_id, approvals_sent: [], note: "all required allowances are already in place" };
        if (!cfg.executeEnabled) return { quote_id, dry_run: true, would_approve: view, how_to_enable: "start the server with EXECUTE_ENABLED=true" };
        const sent = await chains.ensureApprovals(stored.chainId, pending);
        return { quote_id, approvals_sent: sent.map((s, i) => ({ ...view[i], tx_hashes: s.tx_hashes })) };
      }),
  );

  server.registerTool(
    "execute_trade",
    {
      title: "Execute a quoted trade",
      description:
        "Approve (exact amounts) -> build -> pre-flight -> sign -> send -> wait for the receipt -> report on-chain balance changes. Guarded: the quote must come from get_quote on this server, be under 90s old, have this wallet as taker, be priced under MAX_NOTIONAL_USD, and confirm must be true after the user agreed. With EXECUTE_ENABLED unset this is a dry-run that stops after pre-flight and sends nothing.",
      inputSchema: { quote_id: z.string().min(1).max(128), confirm: z.boolean().optional().describe("Must be true; set it only after the user has approved the quote") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    ({ quote_id, confirm }) =>
      run(async () => {
        const stored = store.get(quote_id);
        if (!wallet) throw new ToolError("no wallet configured: set PRIVATE_KEY to execute (quotes and builds work without it)");
        checkTaker(stored.quote.taker, wallet);
        checkSlippage(stored.slippageBps, cfg.maxSlippageBps);
        checkNotional(stored.notionalUsd, stored.unpriced, cfg.maxNotionalUsd);
        checkConfirmed(confirm, "execute_trade");
        checkQuoteFresh(stored.createdAt, now());
        chains.rpcUrl(stored.chainId);
        if (stored.execution) {
          throw new ToolError(
            stored.execution.txHash
              ? `quote ${quote_id} was already executed in ${stored.execution.txHash}; get a new quote to trade again`
              : `quote ${quote_id} is already being executed`,
          );
        }

        const watched = [...new Set([...stored.quote.inputs.map((i) => i.address), ...stored.quote.estimated_outputs.map((o) => o.token)])];
        const before = await balancesOf(chains, stored.chainId, wallet, watched);
        const pending = await approvalsFor(stored, wallet);
        const pendingView = approvalsView(pending, stored.decimals, stored.symbols);

        if (!cfg.executeEnabled) {
          let built: Build | undefined;
          let preflight: unknown = { ok: null, error: "skipped: INFRARED_API_KEY not set, so the transaction could not be built" };
          if (cfg.apiKey) {
            built = await api.build(quote_id);
            preflight = await chains.preflight(built, wallet);
          }
          return {
            quote_id,
            dry_run: true,
            sent: false,
            would_approve: pendingView,
            would_send: built?.transaction ?? null,
            preflight,
            note: pending.length > 0 ? "pre-flight is expected to revert until the approvals above are in place; a live run sends them first" : undefined,
            how_to_enable: "start the server with EXECUTE_ENABLED=true to send transactions",
          };
        }

        stored.execution = { startedAt: now() };
        let built: Build;
        let approvals: Awaited<ReturnType<ChainClients["ensureApprovals"]>>;
        let hash: Hex;
        try {
          approvals = pending.length > 0 ? await chains.ensureApprovals(stored.chainId, pending) : [];
          checkQuoteFresh(stored.createdAt, now());
          built = await api.build(quote_id);
          const preflight = await chains.preflight(built, wallet);
          if (!preflight.ok) throw new ToolError(`pre-flight eth_call reverted, nothing sent: ${preflight.error}`);
          hash = await chains.broadcast(built);
        } catch (err) {
          // Nothing was broadcast: the quote may be retried.
          stored.execution = undefined;
          throw err;
        }
        // From here the swap is in flight: the quote is spent even if the receipt is slow or the swap reverts.
        stored.execution.txHash = hash;
        const receipt = await chains.waitForSuccess(stored.chainId, hash);
        const after = await balancesOf(chains, stored.chainId, wallet, watched);
        const chain = await tokens.chainInfo(stored.chainId);
        return {
          quote_id,
          sent: true,
          tx_hash: receipt.hash,
          explorer_url: chain.block_explorer_url ? `${chain.block_explorer_url.replace(/\/$/, "")}/tx/${receipt.hash}` : undefined,
          block_number: receipt.block_number,
          gas_used: receipt.gas_used,
          approvals_sent: approvals.map((a, i) => ({ ...pendingView[i], tx_hashes: a.tx_hashes })),
          balance_changes: watched.map((t) => {
            const d = stored.decimals.get(lower(t)) as number;
            const b = before.get(lower(t)) as bigint;
            const a = after.get(lower(t)) as bigint;
            return { token: t, symbol: stored.symbols.get(lower(t)), before: fromAtomic(b, d), after: fromAtomic(a, d), delta: fromAtomic(a - b, d) };
          }),
          outputs: built.estimated_outputs.map((o) => {
            const d = stored.decimals.get(lower(o.token)) as number;
            const received = (after.get(lower(o.token)) as bigint) - (before.get(lower(o.token)) as bigint);
            return {
              token: o.token,
              symbol: stored.symbols.get(lower(o.token)),
              expected: fromAtomic(o.expected_amount, d),
              minimum: fromAtomic(o.minimum_amount, d),
              received: fromAtomic(received, d),
              vs_expected_bps: Number.isFinite(bpsDiff(received, BigInt(o.expected_amount))) ? Math.round(bpsDiff(received, BigInt(o.expected_amount)) * (received >= BigInt(o.expected_amount) ? 1 : -1)) : null,
            };
          }),
        };
      }),
  );

  return server;
}

function approvalsView(list: Approval[], decimals: Map<string, number>, symbols: Map<string, string>) {
  return list.map((a) => ({
    token: a.token,
    symbol: symbols.get(lower(a.token)),
    amount: decimals.has(lower(a.token)) ? fromAtomic(a.amount, decimals.get(lower(a.token)) as number) : undefined,
    amount_atomic: a.amount,
    spender: a.spender,
    requires_zero_reset: a.requires_zero_reset,
  }));
}

async function balancesOf(chains: ChainClients, chainId: number, owner: Address, tokens: Address[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  await Promise.all(tokens.map(async (t) => out.set(lower(t), await chains.balance(chainId, owner, t))));
  return out;
}

/** Runs a tool body; ToolErrors (and anything else) become tool-level errors the agent can read and act on. */
async function run(body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await body();
    const text = JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg = err instanceof ToolError ? err.message : `${(err as Error).name ?? "Error"}: ${(err as Error).message ?? String(err)}`;
    return { isError: true, content: [{ type: "text", text: msg }] };
  }
}

export { NATIVE };
