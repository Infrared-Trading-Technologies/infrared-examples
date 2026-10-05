import type { Address, Hex } from "viem";
import { BotError } from "./config.js";

export const DEFAULT_API_URL = "https://api.infraredtrading.com";
const RETRIES = 3;

export interface QuoteInput {
  chain_id: number;
  address: Address;
  amount: string;
}

export interface QuoteOutput {
  chain_id: number;
  address: Address;
  ratio_bps: number;
}

export interface QuoteRequest {
  inputs: QuoteInput[];
  outputs: QuoteOutput[];
  taker: Address;
  slippage_tolerance_bps: number;
}

export interface EstimatedOutput {
  token: Address;
  chain_id: number;
  expected_amount: string;
  minimum_amount: string;
}

export interface Approval {
  token: Address;
  amount: string;
  spender: Address;
  requires_zero_reset: boolean;
}

export interface Quote {
  quote_id: string;
  estimated_outputs: EstimatedOutput[];
  approvals?: Approval[];
}

export interface Build {
  transaction: { to: Address; data: Hex; value: Hex; gas: number; chain_id: number };
  estimated_outputs: EstimatedOutput[];
}

export interface ChainInfo {
  chain_id: number;
  name: string;
  healthy: boolean;
}

/** An Infrared API error with its machine-readable code (e.g. NO_ROUTE_FOUND). */
export class ApiError extends BotError {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Typed client for the public Infrared HTTP API (https://api.infraredtrading.com). */
export class InfraredClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_API_URL,
  ) {}

  quote(req: QuoteRequest): Promise<Quote> {
    return this.call<Quote>("POST", "/v1/quote", req);
  }

  build(quoteId: string): Promise<Build> {
    return this.call<Build>("POST", "/v1/build", { quote_id: quoteId });
  }

  async prices(chainId: number, tokens: Address[]): Promise<Map<string, number>> {
    const q = new URLSearchParams({ chain_id: String(chainId), addresses: tokens.join(",") });
    const res = await this.call<{ prices: Record<string, number> }>("GET", `/v1/prices?${q}`);
    const out = new Map<string, number>();
    for (const [token, price] of Object.entries(res.prices ?? {})) out.set(token.toLowerCase(), price);
    return out;
  }

  chains(): Promise<ChainInfo[]> {
    return this.call<ChainInfo[]>("GET", "/v1/chains");
  }

  /** Retries rate-limit and transient server errors (429, 5xx) with backoff; anything else fails immediately. */
  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once<T>(method, path, body);
      } catch (err) {
        const transient = err instanceof ApiError && (err.status === 429 || err.status >= 500);
        if (!transient || attempt >= RETRIES) throw err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }

  private async once<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: { "content-type": "application/json", "x-api-key": this.apiKey },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new BotError(`Infrared API ${method} ${path} unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    let json: { data?: T; error?: { code?: string; message?: string } };
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, "BAD_RESPONSE", `Infrared API ${path} returned ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.ok || json.data === undefined) {
      const code = json.error?.code ?? `HTTP_${res.status}`;
      const msg = json.error?.message ?? text.slice(0, 200);
      if (res.status === 401 || res.status === 403) {
        throw new ApiError(res.status, code, `Infrared API rejected INFRARED_API_KEY (${res.status} ${code}: ${msg})`);
      }
      throw new ApiError(res.status, code, `Infrared API ${path} failed (${res.status} ${code}): ${msg}`);
    }
    return json.data;
  }
}
