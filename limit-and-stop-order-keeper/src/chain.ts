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
import { BotError, NATIVE } from "./config.js";
import type { Approval, Build, ChainInfo } from "./infrared.js";

const KNOWN: Record<number, Chain> = { [mainnet.id]: mainnet, [base.id]: base, [arbitrum.id]: arbitrum, [optimism.id]: optimism, [polygon.id]: polygon };

/** Some multi-hop routes need more than the recommended limit; unused gas is refunded. */
const GAS_HEADROOM = 2n;

/** Per-chain viem clients from RPC_URL_<chain_id> plus the keeper's own signer. */
export class ChainClients {
  private readonly pubs = new Map<number, PublicClient>();
  private readonly checked = new Set<number>();
  private readonly decimalsCache = new Map<string, number>();
  readonly account: Account;

  constructor(
    private readonly rpcUrls: Map<number, string>,
    privateKey: string,
    private readonly chainInfo: (chainId: number) => Promise<ChainInfo>,
  ) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new BotError("PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
    this.account = privateKeyToAccount(privateKey as Hex);
  }

  rpcUrl(chainId: number): string {
    const url = this.rpcUrls.get(chainId);
    if (!url) throw new BotError(`no RPC for chain ${chainId}: set RPC_URL_${chainId}`);
    return url;
  }

  async chain(chainId: number): Promise<Chain> {
    const known = KNOWN[chainId];
    if (known) return known;
    const info = await this.chainInfo(chainId);
    return defineChain({ id: chainId, name: info.name, nativeCurrency: { name: info.native_name, symbol: info.native_symbol, decimals: 18 }, rpcUrls: { default: { http: [this.rpcUrl(chainId)] } } });
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
        throw new BotError(`RPC_URL_${chainId} unreachable: ${(err as Error).message.split("\n")[0]}`);
      }
      if (rpcChain !== chainId) throw new BotError(`RPC_URL_${chainId} is actually chain ${rpcChain}`);
      this.checked.add(chainId);
    }
    return p;
  }

  private async wallet(chainId: number): Promise<{ wallet: WalletClient; chain: Chain; pub: PublicClient }> {
    const pub = await this.pub(chainId);
    const chain = await this.chain(chainId);
    return { wallet: createWalletClient({ chain, transport: http(this.rpcUrl(chainId), { timeout: 60_000 }), account: this.account }), chain, pub };
  }

  /** Reads decimals() on-chain once per token. Never guesses: an unreadable token is an error. */
  async decimals(chainId: number, token: Address): Promise<number> {
    if (token.toLowerCase() === NATIVE.toLowerCase()) return 18;
    const key = `${chainId}:${token.toLowerCase()}`;
    const cached = this.decimalsCache.get(key);
    if (cached !== undefined) return cached;
    const pub = await this.pub(chainId);
    let d: number;
    try {
      d = Number(await pub.readContract({ account: this.account.address, address: token, abi: erc20Abi, functionName: "decimals" }));
    } catch {
      throw new BotError(`cannot read decimals() for token ${token} on chain ${chainId}; refusing to guess`);
    }
    this.decimalsCache.set(key, d);
    return d;
  }

  async symbol(chainId: number, token: Address): Promise<string> {
    if (token.toLowerCase() === NATIVE.toLowerCase()) return (await this.chainInfo(chainId)).native_symbol;
    const pub = await this.pub(chainId);
    try {
      return await pub.readContract({ account: this.account.address, address: token, abi: erc20Abi, functionName: "symbol" });
    } catch {
      return `${token.slice(0, 6)}…${token.slice(-4)}`;
    }
  }

  async balance(chainId: number, token: Address): Promise<bigint> {
    const pub = await this.pub(chainId);
    const owner = this.account.address;
    if (token.toLowerCase() === NATIVE.toLowerCase()) return pub.getBalance({ address: owner });
    return pub.readContract({ account: owner, address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  }

  /** Approves the exact amount (never unlimited) to the Router, zero-resetting first when the token needs it. */
  async ensureApprovals(chainId: number, approvals: Approval[]): Promise<Hex[]> {
    const { wallet, chain, pub } = await this.wallet(chainId);
    const hashes: Hex[] = [];
    for (const a of approvals) {
      if (a.token.toLowerCase() === NATIVE.toLowerCase()) continue;
      const need = BigInt(a.amount);
      const current = await pub.readContract({ account: this.account.address, address: a.token, abi: erc20Abi, functionName: "allowance", args: [this.account.address, a.spender] });
      if (current >= need) continue;
      const approve = async (amount: bigint) => {
        const hash = await wallet.writeContract({ address: a.token, abi: erc20Abi, functionName: "approve", args: [a.spender, amount], account: this.account, chain });
        const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
        if (r.status !== "success") throw new BotError(`approve ${a.token} reverted (${hash})`);
        hashes.push(hash);
      };
      if (current > 0n && a.requires_zero_reset) await approve(0n);
      await approve(need);
    }
    return hashes;
  }

  /** eth_call of the built transaction from the keeper wallet at the gas limit that will be sent. */
  async preflight(built: Build): Promise<{ ok: boolean; gas: bigint; error?: string }> {
    const tx = built.transaction;
    const pub = await this.pub(tx.chain_id);
    const gas = BigInt(tx.gas) * GAS_HEADROOM;
    try {
      await pub.call({ account: this.account, to: tx.to, data: tx.data, value: BigInt(tx.value), gas });
      return { ok: true, gas };
    } catch (err) {
      return { ok: false, gas, error: (err as Error).message.split("\n").slice(0, 3).join(" ") };
    }
  }

  async broadcast(built: Build, gas: bigint): Promise<Hex> {
    const tx = built.transaction;
    const { wallet, chain } = await this.wallet(tx.chain_id);
    return wallet.sendTransaction({ account: this.account, chain, to: tx.to, data: tx.data, value: BigInt(tx.value), gas });
  }

  async waitForReceipt(chainId: number, hash: Hex): Promise<{ success: boolean; block_number: bigint }> {
    const pub = await this.pub(chainId);
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
    return { success: r.status === "success", block_number: r.blockNumber };
  }
}
