import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, mainnet } from "viem/chains";
import { BotError, NATIVE } from "./config.js";
import type { Approval, Build } from "./infrared.js";

// Base (8453) is held back until an Infrared split-routing fix ships; it is a one-line addition here.
const CHAINS: Record<number, Chain> = { [mainnet.id]: mainnet, [arbitrum.id]: arbitrum };

export interface Wallet {
  chain: Chain;
  account: Account;
  pub: PublicClient;
  wallet: WalletClient;
}

export async function connect(chainId: number, rpcUrl: string, privateKey: string): Promise<Wallet> {
  const chain = CHAINS[chainId];
  if (!chain) {
    throw new BotError(`chain_id ${chainId} is not supported; supported: ${Object.keys(CHAINS).join(", ")}`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new BotError("PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
  const account = privateKeyToAccount(privateKey as Hex);
  const transport = http(rpcUrl, { timeout: 60_000 });
  const pub = createPublicClient({ chain, transport }) as PublicClient;
  const wallet = createWalletClient({ chain, transport, account });
  let rpcChain: number;
  try {
    rpcChain = await pub.getChainId();
  } catch (err) {
    throw new BotError(`RPC_URL unreachable: ${(err as Error).message.split("\n")[0]}`);
  }
  if (rpcChain !== chainId) throw new BotError(`RPC_URL is chain ${rpcChain} but config chain_id is ${chainId}`);
  return { chain, account, pub, wallet };
}

// Reads are sent from the wallet's own address: some proxy tokens reject calls from the default (zero) caller.

/** Reads decimals() on-chain for every token. Never falls back to a default: unreadable decimals abort the run. */
export async function readDecimals(w: Wallet, tokens: Address[]): Promise<Map<Address, number>> {
  const out = new Map<Address, number>();
  await Promise.all(
    tokens.map(async (t) => {
      if (t === NATIVE) {
        out.set(t, w.chain.nativeCurrency.decimals);
        return;
      }
      let d: number;
      try {
        d = await w.pub.readContract({ account: w.account.address, address: t, abi: erc20Abi, functionName: "decimals" });
      } catch {
        throw new BotError(`cannot read decimals() for token ${t} on chain ${w.chain.id}; refusing to guess`);
      }
      out.set(t, Number(d));
    }),
  );
  return out;
}

export async function readBalances(w: Wallet, tokens: Address[]): Promise<Map<Address, bigint>> {
  const owner = w.account.address;
  const out = new Map<Address, bigint>();
  await Promise.all(
    tokens.map(async (t) => {
      const bal =
        t === NATIVE
          ? await w.pub.getBalance({ address: owner })
          : await w.pub.readContract({ account: owner, address: t, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
      out.set(t, bal);
    }),
  );
  return out;
}

/** Ensures each required allowance is in place by approving the exact amount (never unlimited), zero-resetting first when the token needs it. */
export async function ensureApprovals(w: Wallet, approvals: Approval[]): Promise<Hex[]> {
  const hashes: Hex[] = [];
  for (const a of approvals) {
    if (a.token.toLowerCase() === NATIVE.toLowerCase()) continue;
    const need = BigInt(a.amount);
    const current = await w.pub.readContract({
      account: w.account.address,
      address: a.token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [w.account.address, a.spender],
    });
    if (current >= need) continue;
    if (current > 0n && a.requires_zero_reset) hashes.push(await approve(w, a.token, a.spender, 0n));
    hashes.push(await approve(w, a.token, a.spender, need));
  }
  return hashes;
}

async function approve(w: Wallet, token: Address, spender: Address, amount: bigint): Promise<Hex> {
  const hash = await w.wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
    account: w.account,
    chain: w.chain,
  });
  await confirm(w, hash, `approve ${token}`);
  return hash;
}

/**
 * The gas limit sent is a multiple of the build's recommendation: some multi-output routes need more than
 * the recommended figure, and unused gas is not charged.
 */
const GAS_HEADROOM = 2n;

/** Pre-flights the built transaction on the user's RPC at the exact gas limit it will send, then sends it. */
export async function sendBuilt(w: Wallet, built: Build): Promise<Hex> {
  const tx = built.transaction;
  const gas = BigInt(tx.gas) * GAS_HEADROOM;
  const req = { account: w.account, to: tx.to, data: tx.data, value: BigInt(tx.value), gas };
  try {
    await w.pub.call(req);
  } catch (err) {
    throw new BotError(`swap pre-flight reverted on RPC_URL, nothing sent: ${(err as Error).message.split("\n")[0]}`);
  }
  const hash = await w.wallet.sendTransaction({ ...req, chain: w.chain });
  await confirm(w, hash, "swap");
  return hash;
}

async function confirm(w: Wallet, hash: Hex, what: string): Promise<void> {
  const receipt = await w.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new BotError(`${what} transaction ${hash} reverted`);
}
