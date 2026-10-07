import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base, mainnet, optimism, polygon } from "viem/chains";
import { NATIVE, ToolError, type ServerConfig } from "./config.js";
import type { Approval, Build, ChainInfo } from "./infrared.js";

const KNOWN: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [base.id]: base,
  [arbitrum.id]: arbitrum,
  [optimism.id]: optimism,
  [polygon.id]: polygon,
};

/** Some multi-output routes need more than the recommended limit; unused gas is refunded. */
const GAS_HEADROOM = 2n;

export interface PreflightResult {
  ok: boolean;
  gas_limit: string;
  error?: string;
}

/** Per-chain viem clients built lazily from RPC_URL_<chain_id>; the signer is optional (read-only server). */
export class ChainClients {
  private readonly pubs = new Map<number, PublicClient>();
  private readonly checked = new Set<number>();
  readonly account?: Account;

  constructor(
    private readonly cfg: ServerConfig,
    private readonly chainInfo: (chainId: number) => Promise<ChainInfo>,
  ) {
    if (cfg.privateKey) this.account = privateKeyToAccount(cfg.privateKey);
  }

  hasRpc(chainId: number): boolean {
    return this.cfg.rpcUrls.has(chainId);
  }

  configuredChains(): number[] {
    return [...this.cfg.rpcUrls.keys()].sort((a, b) => a - b);
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
    if (!url) throw new ToolError(`no RPC configured for chain ${chainId}; set RPC_URL_${chainId}`);
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
        throw new ToolError(`RPC_URL_${chainId} unreachable: ${(err as Error).message.split("\n")[0]}`);
      }
      if (rpcChain !== chainId) throw new ToolError(`RPC_URL_${chainId} is actually chain ${rpcChain}`);
      this.checked.add(chainId);
    }
    return p;
  }

  async wallet(chainId: number): Promise<{ wallet: WalletClient; account: Account; chain: Chain; pub: PublicClient }> {
    if (!this.account) throw new ToolError("no wallet configured: set PRIVATE_KEY (use a fresh wallet that only this server controls)");
    const pub = await this.pub(chainId);
    const chain = await this.chain(chainId);
    const wallet = createWalletClient({ chain, transport: http(this.rpcUrl(chainId), { timeout: 60_000 }), account: this.account });
    return { wallet, account: this.account, chain, pub };
  }

  /** Reads decimals() on-chain. Never guesses: an unreadable token is an error. */
  async decimals(chainId: number, token: Address): Promise<number> {
    if (token.toLowerCase() === NATIVE.toLowerCase()) return 18;
    const pub = await this.pub(chainId);
    try {
      const d = await pub.readContract({ account: this.account?.address, address: token, abi: erc20Abi, functionName: "decimals" });
      return Number(d);
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

  /** eth_call of the built transaction from the taker at the gas limit that will be sent. Needs only the taker's address. */
  async preflight(built: Build, from: Address): Promise<PreflightResult> {
    const tx = built.transaction;
    const pub = await this.pub(tx.chain_id);
    const gas = BigInt(tx.gas) * GAS_HEADROOM;
    try {
      await pub.call({ account: from, to: tx.to, data: tx.data, value: BigInt(tx.value), gas });
      return { ok: true, gas_limit: gas.toString() };
    } catch (err) {
      return { ok: false, gas_limit: gas.toString(), error: (err as Error).message.split("\n").slice(0, 3).join(" ") };
    }
  }

  /** Approves the exact amount (never unlimited) to the Router, zero-resetting first when the token needs it. */
  async ensureApprovals(chainId: number, approvals: Approval[]): Promise<{ token: Address; tx_hashes: Hex[] }[]> {
    const { wallet, account, chain, pub } = await this.wallet(chainId);
    const out: { token: Address; tx_hashes: Hex[] }[] = [];
    for (const a of approvals) {
      if (a.token.toLowerCase() === NATIVE.toLowerCase()) continue;
      const need = BigInt(a.amount);
      const current = await this.allowance(chainId, account.address, a.token, a.spender);
      if (current >= need) continue;
      const hashes: Hex[] = [];
      const approve = async (amount: bigint) => {
        const hash = await wallet.writeContract({ address: a.token, abi: erc20Abi, functionName: "approve", args: [a.spender, amount], account, chain });
        const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
        if (receipt.status !== "success") throw new ToolError(`approve ${a.token} reverted (${hash})`);
        hashes.push(hash);
      };
      if (current > 0n && a.requires_zero_reset) await approve(0n);
      await approve(need);
      out.push({ token: a.token, tx_hashes: hashes });
    }
    return out;
  }

  /** Signs and broadcasts the built transaction; returns the hash as soon as the node accepts it. Callers pre-flight first. */
  async broadcast(built: Build): Promise<Hex> {
    const tx = built.transaction;
    const { wallet, account, chain } = await this.wallet(tx.chain_id);
    return wallet.sendTransaction({ account, chain, to: tx.to, data: tx.data, value: BigInt(tx.value), gas: BigInt(tx.gas) * GAS_HEADROOM });
  }

  async waitForSuccess(chainId: number, hash: Hex): Promise<{ hash: Hex; block_number: string; gas_used: string }> {
    const pub = await this.pub(chainId);
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new ToolError(`swap transaction ${hash} reverted on-chain; get a new quote to try again`);
    return { hash, block_number: receipt.blockNumber.toString(), gas_used: receipt.gasUsed.toString() };
  }
}
