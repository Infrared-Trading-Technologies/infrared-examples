import type { Address, Hex } from "viem";
import { ToolError } from "./config.js";

const RETRIES = 3;

export interface QuoteInput {
  chain_id: number;
  address: Address;
  amount: string;
}

export interface QuoteOutput {
  chain_id: number;
  address: Address;
  ratio_bps?: number;
  amount?: string;
}

export interface QuoteRequest {
  inputs: QuoteInput[];
  outputs: QuoteOutput[];
  taker: Address;
  recipient?: Address;
  slippage_tolerance_bps: number;
  include_protocols?: string[];
  exclude_protocols?: string[];
  include_usd_pricing?: boolean;
  check_allowances?: boolean;
  partner_fee?: PartnerFee;
}

export interface PartnerFee {
  partner_fee_bps: number;
  partner_recipient: Address;
  partner_fee_on_output?: boolean;
}

export interface FeeConfig {
  protocol_fee_bps?: number;
  partner_fee_bps?: number;
  partner_recipient?: Address;
  partner_fee_on_output?: boolean;
  pass_positive_slippage_to_user?: boolean;
}

export interface EstimatedOutput {
  token: Address;
  chain_id: number;
  expected_amount: string;
  minimum_amount: string;
  price_impact_bps?: number;
}

export interface Approval {
  token: Address;
  amount: string;
  spender: Address;
  requires_zero_reset: boolean;
}

export interface Costs {
  gas_cost_wei?: string;
  gas_cost_usd?: number | null;
  total_cost_usd?: number | null;
  total_gas_units?: number;
  max_fee_per_gas?: number;
  max_priority_fee_per_gas?: number;
  gas_priority?: string;
}

export interface Quote {
  quote_id: string;
  taker: Address;
  inputs: QuoteInput[];
  outputs: QuoteOutput[];
  estimated_outputs: EstimatedOutput[];
  approvals?: Approval[];
  costs?: Costs;
  protocols_used?: string[];
  total_price_impact_bps?: number;
  fee_config?: FeeConfig;
}

export interface Build {
  transaction: { to: Address; data: Hex; value: Hex; gas: number; chain_id: number };
  estimated_outputs: EstimatedOutput[];
}

export interface ChainInfo {
  chain_id: number;
  name: string;
  native_symbol: string;
  native_name: string;
  wrapped_native_address: Address;
  block_time_ms: number;
  is_l2: boolean;
  is_testnet: boolean;
  healthy: boolean;
  block_explorer_url: string;
}

export interface TokenInfo {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  chain_id: number;
  pool_count: number;
  tags?: string[];
  logo_uri?: string | null;
  coingecko_id?: string | null;
}

export interface TokenList {
  tokens: TokenInfo[];
  pagination: { limit: number; offset: number; has_more: boolean };
}

export interface Protocol {
  name: string;
  products: { id: string; product: string; chains: number[] }[];
}

export interface GasTier {
  max_priority_fee_per_gas: number;
  max_fee_per_gas: number;
}

export interface NetworkInfo {
  chain_id: number;
  block_number: number;
  base_fee_wei: number;
  gas_prices: Record<string, GasTier>;
}

/** An Infrared API error with its machine-readable code (e.g. NO_ROUTE_FOUND) and endpoint-specific details. */
export class ApiError extends ToolError {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Typed client for the public Infrared HTTP API. The API key is optional for every call except build. */
export class InfraredClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  quote(req: QuoteRequest): Promise<Quote> {
    return this.call<Quote>("POST", "/v1/quote", req);
  }

  /**
   * Builds with simulate:false (the caller pre-flights locally). A just-created quote can briefly 404
   * while it is being stored, so NOT_FOUND is retried here too.
   */
  async build(quoteId: string): Promise<Build> {
    if (!this.apiKey) throw new ToolError("/v1/build requires an API key: set INFRARED_API_KEY (quotes stay available without one)");
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.call<Build>("POST", "/v1/build", { quote_id: quoteId, simulate: false });
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 404 || attempt >= RETRIES) throw err;
        await sleep(1000 * attempt);
      }
    }
  }

  async prices(chainId: number, tokens: Address[]): Promise<Map<string, number>> {
    const q = new URLSearchParams({ chain_id: String(chainId), addresses: tokens.join(",") });
    const res = await this.call<{ prices: Record<string, number> }>("GET", `/v1/prices?${q}`);
    return new Map(Object.entries(res.prices ?? {}).map(([t, p]) => [t.toLowerCase(), p]));
  }

  chains(): Promise<ChainInfo[]> {
    return this.call<ChainInfo[]>("GET", "/v1/chains");
  }

  protocols(chainId?: number): Promise<Protocol[]> {
    const q = chainId === undefined ? "" : `?chain_id=${chainId}`;
    return this.call<Protocol[]>("GET", `/v1/protocols${q}`);
  }

  network(chainId: number): Promise<NetworkInfo> {
    return this.call<NetworkInfo>("GET", `/v1/network?chain_id=${chainId}`);
  }

  tokens(params: { chain_id?: number; search?: string; tags?: string; limit?: number; offset?: number }): Promise<TokenList> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
    return this.call<TokenList>("GET", `/v1/tokens?${q}`);
  }

  /** Lower-cased token -> raw balance. Tokens whose read failed are absent (unknown, not zero). */
  async balances(chainId: number, owner: Address, tokens: Address[]): Promise<Map<string, bigint>> {
    const res = await this.call<{ balances: Record<string, string> }>("POST", "/v1/balances", { chain_id: chainId, owner, tokens });
    return new Map(Object.entries(res.balances ?? {}).map(([t, b]) => [t.toLowerCase(), BigInt(b)]));
  }

  /** Lower-cased "token:spender" -> raw allowance. Pairs whose read failed are absent (unknown, not zero). */
  async allowances(chainId: number, owner: Address, pairs: { token: Address; spender: Address }[]): Promise<Map<string, bigint>> {
    const res = await this.call<{ allowances: Record<string, string> }>("POST", "/v1/allowances", {
      chain_id: chainId,
      owner,
      allowances: pairs,
    });
    return new Map(Object.entries(res.allowances ?? {}).map(([k, v]) => [k.toLowerCase(), BigInt(v)]));
  }

  /** Retries rate-limit and transient server errors (429, 5xx) with backoff; anything else fails immediately. */
  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once<T>(method, path, body);
      } catch (err) {
        const transient = err instanceof ApiError && (err.status === 429 || err.status >= 500);
        if (!transient || attempt >= RETRIES) throw err;
        await sleep(2000 * attempt);
      }
    }
  }

  private async once<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new ToolError(`Infrared API ${method} ${path} unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    let json: { data?: T; error?: { code?: string; message?: string; details?: Record<string, unknown> } };
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, "BAD_RESPONSE", `Infrared API ${path} returned ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.ok || json.data === undefined) {
      const code = json.error?.code ?? `HTTP_${res.status}`;
      const msg = json.error?.message ?? text.slice(0, 200);
      if (res.status === 401 || res.status === 403) {
        throw new ApiError(res.status, code, `Infrared API rejected INFRARED_API_KEY (${res.status} ${code}: ${msg})`, json.error?.details);
      }
      throw new ApiError(res.status, code, `Infrared API ${path} failed (${res.status} ${code}): ${msg}`, json.error?.details);
    }
    return json.data;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
