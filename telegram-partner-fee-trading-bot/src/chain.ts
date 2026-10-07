import { createPublicClient, defineChain, erc20Abi, http, type Address, type Chain, type Hex, type PublicClient } from "viem";
import { arbitrum, base, mainnet, optimism, polygon } from "viem/chains";
import { NATIVE, ToolError, type BotConfig } from "./config.js";
import type { Build, ChainInfo } from "./infrared.js";

const KNOWN: Record<number, Chain> = { [mainnet.id]: mainnet, [base.id]: base, [arbitrum.id]: arbitrum, [optimism.id]: optimism, [polygon.id]: polygon };

/** Some multi-output routes need more than the recommended limit; unused gas is refunded. */
export const GAS_HEADROOM = 2n;

export interface PreflightResult {
  ok: boolean;
  gas_limit: bigint;
  error?: string;
}

/** Read-only per-chain viem clients from RPC_URL_<chain_id>. The bot never holds a key: users sign in their own wallet. */
export class ChainReaders {
  private readonly pubs = new Map<number, PublicClient>();
  private readonly checked = new Set<number>();

  constructor(
    private readonly cfg: BotConfig,
    private readonly chainInfo: (chainId: number) => Promise<ChainInfo>,
  ) {}

  hasRpc(chainId: number): boolean {
    return this.cfg.rpcUrls.has(chainId);
  }

  async chain(chainId: number): Promise<Chain> {
    const known = KNOWN[chainId];
    if (known) return known;
    const info = await this.chainInfo(chainId);
    return defineChain({
      id: chainId,
      name: info.name,
      nativeCurrency: { name: info.native_name, symbol: info.native_symbol, decimals: 18 },
      rpcUrls: { default: { http: [this.rpcUrl(chainId)] } },
    });
  }

  rpcUrl(chainId: number): string {
    const url = this.cfg.rpcUrls.get(chainId);
    if (!url) throw new ToolError(`chain ${chainId} is not enabled on this bot`);
    return url;
  }

  async pub(chainId: number): Promise<PublicClient> {
    let p = this.pubs.get(chainId);
    if (!p) {
      p = createPublicClient({ chain: await this.chain(chainId), transport: http(this.rpcUrl(chainId), { timeout: 60_000 }) }) as PublicClient;
      this.pubs.set(chainId, p);
    }
    if (!this.checked.has(chainId)) {
      let rpcChain: number;
      try {
        rpcChain = await p.getChainId();
      } catch (err) {
        throw new ToolError(`RPC for chain ${chainId} is unreachable: ${(err as Error).message.split("\n")[0]}`);
      }
      if (rpcChain !== chainId) throw new ToolError(`RPC_URL_${chainId} is actually chain ${rpcChain}`);
      this.checked.add(chainId);
    }
    return p;
  }

  /** Reads decimals() on-chain. Never guesses: an unreadable token is an error. */
  async decimals(chainId: number, token: Address): Promise<number> {
    if (token.toLowerCase() === NATIVE.toLowerCase()) return 18;
    const pub = await this.pub(chainId);
    try {
      return Number(await pub.readContract({ account: "0x000000000000000000000000000000000000dEaD", address: token, abi: erc20Abi, functionName: "decimals" }));
    } catch {
      throw new ToolError(`cannot read decimals() for token ${token} on chain ${chainId}; refusing to guess`);
    }
  }

  async balance(chainId: number, owner: Address, token: Address): Promise<bigint> {
    const pub = await this.pub(chainId);
    if (token.toLowerCase() === NATIVE.toLowerCase()) return pub.getBalance({ address: owner });
    return pub.readContract({ account: owner, address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  }

  async allowance(chainId: number, owner: Address, token: Address, spender: Address): Promise<bigint> {
    const pub = await this.pub(chainId);
    return pub.readContract({ account: owner, address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
  }

  /** eth_call of the built transaction from the taker at the gas limit that will be sent. */
  async preflight(built: Build, from: Address): Promise<PreflightResult> {
    const tx = built.transaction;
    const pub = await this.pub(tx.chain_id);
    const gas = BigInt(tx.gas) * GAS_HEADROOM;
    try {
      await pub.call({ account: from, to: tx.to, data: tx.data, value: BigInt(tx.value), gas });
      return { ok: true, gas_limit: gas };
    } catch (err) {
      return { ok: false, gas_limit: gas, error: (err as Error).message.split("\n").slice(0, 3).join(" ") };
    }
  }

  async waitForReceipt(chainId: number, hash: Hex): Promise<{ success: boolean; block_number: bigint; gas_used: bigint }> {
    const pub = await this.pub(chainId);
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
    return { success: r.status === "success", block_number: r.blockNumber, gas_used: r.gasUsed };
  }
}
