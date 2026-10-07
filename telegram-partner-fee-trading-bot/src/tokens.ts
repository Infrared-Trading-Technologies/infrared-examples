import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import type { ChainReaders } from "./chain.js";
import { NATIVE, ToolError } from "./config.js";
import type { ChainInfo, InfraredClient, TokenInfo } from "./infrared.js";

/** Resolves token identifiers (address or symbol) and decimals, preferring on-chain reads over the Infrared registry. */
export class TokenResolver {
  private chainsPromise?: Promise<Map<number, ChainInfo>>;
  private readonly decimalsCache = new Map<string, number>();
  private readonly symbolCache = new Map<string, string>();
  private chains?: ChainReaders;

  constructor(private readonly api: InfraredClient) {}

  attach(chains: ChainReaders): void {
    this.chains = chains;
  }

  async allChains(): Promise<Map<number, ChainInfo>> {
    if (!this.chainsPromise) {
      this.chainsPromise = this.api.chains().then((list) => new Map(list.map((c) => [c.chain_id, c])));
      this.chainsPromise.catch(() => (this.chainsPromise = undefined));
    }
    return this.chainsPromise;
  }

  async chainInfo(chainId: number): Promise<ChainInfo> {
    const chains = await this.allChains();
    const c = chains.get(chainId);
    if (!c) throw new ToolError(`chain ${chainId} is not supported by Infrared; supported: ${[...chains.keys()].join(", ")}`);
    return c;
  }

  /** Accepts a checksummed/lowercase address, the zero address or native symbol (native currency), or an exact token symbol. */
  async resolve(chainId: number, ident: string): Promise<Address> {
    const s = ident.trim();
    if (isAddress(s, { strict: false })) {
      const a = getAddress(s);
      return a === zeroAddress || a.toLowerCase() === NATIVE.toLowerCase() ? NATIVE : a;
    }
    if (!/^[A-Za-z0-9$._+-]{1,32}$/.test(s)) throw new ToolError(`"${ident}" is neither an address nor a token symbol`);
    const chain = await this.chainInfo(chainId);
    if (s.toUpperCase() === chain.native_symbol.toUpperCase()) return NATIVE;
    const list = await this.api.tokens({ chain_id: chainId, search: s, limit: 50 });
    const pick = pickBySymbol(list.tokens, s);
    if (pick.ok) {
      this.remember(chainId, pick.token);
      return getAddress(pick.token.address);
    }
    if (pick.reason === "none") {
      const near = list.tokens.slice(0, 5).map((t) => `${t.symbol} ${t.address}`);
      throw new ToolError(`no token with symbol "${s}" on chain ${chainId}${near.length ? `; similar: ${near.join("; ")}` : ""}. Pass the contract address instead.`);
    }
    const candidates = pick.candidates.map((t) => `${t.address} (${t.name}, ${t.pool_count} pools)`);
    throw new ToolError(`symbol "${s}" is ambiguous on chain ${chainId}; pass one of these addresses: ${candidates.join("; ")}`);
  }

  /** On-chain decimals() when an RPC is configured, otherwise the Infrared registry. Unknown decimals are an error, never a default. */
  async decimals(chainId: number, token: Address): Promise<number> {
    if (token.toLowerCase() === NATIVE.toLowerCase()) return 18;
    const key = `${chainId}:${token.toLowerCase()}`;
    const cached = this.decimalsCache.get(key);
    if (cached !== undefined) return cached;
    let d: number;
    if (this.chains?.hasRpc(chainId)) {
      d = await this.chains.decimals(chainId, token);
    } else {
      const info = await this.registry(chainId, token);
      if (!info) {
        throw new ToolError(`token ${token} on chain ${chainId} is not in the Infrared registry and no RPC_URL_${chainId} is set to read decimals() on-chain`);
      }
      d = info.decimals;
    }
    this.decimalsCache.set(key, d);
    return d;
  }

  /** Best-effort display symbol; empty string when unknown. */
  async symbol(chainId: number, token: Address): Promise<string> {
    if (token.toLowerCase() === NATIVE.toLowerCase()) return (await this.chainInfo(chainId)).native_symbol;
    const key = `${chainId}:${token.toLowerCase()}`;
    const cached = this.symbolCache.get(key);
    if (cached !== undefined) return cached;
    try {
      const info = await this.registry(chainId, token);
      this.symbolCache.set(key, info?.symbol ?? "");
    } catch {
      this.symbolCache.set(key, "");
    }
    return this.symbolCache.get(key) ?? "";
  }

  private async registry(chainId: number, token: Address): Promise<TokenInfo | undefined> {
    const list = await this.api.tokens({ chain_id: chainId, search: token, limit: 5 });
    const hit = list.tokens.find((t) => t.address.toLowerCase() === token.toLowerCase());
    if (hit) this.remember(chainId, hit);
    return hit;
  }

  private remember(chainId: number, t: TokenInfo): void {
    const key = `${chainId}:${t.address.toLowerCase()}`;
    this.symbolCache.set(key, t.symbol);
    if (!this.chains?.hasRpc(chainId)) this.decimalsCache.set(key, t.decimals);
  }
}

export type SymbolPick = { ok: true; token: TokenInfo } | { ok: false; reason: "none" } | { ok: false; reason: "ambiguous"; candidates: TokenInfo[] };

/**
 * Exact-symbol match. Many vault shares reuse their underlying's symbol (e.g. "USDC") but have no pools,
 * so when exactly one match is routable (pool_count > 0) it wins; otherwise the choice is the caller's.
 */
export function pickBySymbol(tokens: TokenInfo[], symbol: string): SymbolPick {
  const exact = tokens.filter((t) => t.symbol.toUpperCase() === symbol.toUpperCase());
  if (exact.length === 0) return { ok: false, reason: "none" };
  if (exact.length === 1) return { ok: true, token: exact[0] as TokenInfo };
  const routable = exact.filter((t) => t.pool_count > 0);
  if (routable.length === 1) return { ok: true, token: routable[0] as TokenInfo };
  const candidates = [...exact].sort((a, b) => b.pool_count - a.pool_count).slice(0, 5);
  return { ok: false, reason: "ambiguous", candidates };
}
