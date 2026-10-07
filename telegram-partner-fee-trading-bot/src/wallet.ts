import { SignClient } from "@walletconnect/sign-client";
type ISignClient = InstanceType<typeof SignClient>;
import type { SessionTypes } from "@walletconnect/types";
import { join } from "node:path";
import { getAddress, type Address, type Hex } from "viem";
import { ToolError, type BotConfig } from "./config.js";

export interface WalletTx {
  from: Address;
  to: Address;
  data: Hex;
  value: Hex;
  gas: Hex;
}

const METHODS = ["eth_sendTransaction"];
const EVENTS = ["chainChanged", "accountsChanged"];

/**
 * WalletConnect v2 link to each user's own wallet. The bot never sees a private key: every approve and
 * swap is an eth_sendTransaction request the user accepts on their phone, so their wallet is the taker.
 */
export class WalletLink {
  private constructor(
    readonly client: ISignClient,
    private readonly cfg: BotConfig,
  ) {}

  static async init(cfg: BotConfig): Promise<WalletLink> {
    const client = await SignClient.init({
      projectId: cfg.walletConnectProjectId,
      logger: "error",
      storageOptions: { database: join(cfg.dataDir, "walletconnect") },
      metadata: {
        name: cfg.botName,
        description: "Self-custodial trading bot on the Infrared API",
        url: "https://github.com/Infrared-Trading-Technologies/infrared-examples",
        icons: [],
      },
    });
    return new WalletLink(client, cfg);
  }

  /** Starts a pairing: returns the wc: URI to show the user and a promise for the approved session. */
  async connect(preferredChainId: number): Promise<{ uri: string; approval: () => Promise<{ topic: string; address: Address; chains: number[] }> }> {
    const all = this.cfg.chains.map((id) => `eip155:${id}`);
    const { uri, approval } = await this.client.connect({
      requiredNamespaces: { eip155: { methods: METHODS, chains: [`eip155:${preferredChainId}`], events: EVENTS } },
      optionalNamespaces: { eip155: { methods: METHODS, chains: all, events: EVENTS } },
    });
    if (!uri) throw new ToolError("WalletConnect did not return a pairing URI");
    return {
      uri,
      approval: async () => {
        const session = await approval();
        return { topic: session.topic, address: this.addressOf(session, preferredChainId), chains: this.chainsOf(session) };
      },
    };
  }

  session(topic: string | undefined): SessionTypes.Struct | undefined {
    if (!topic || !this.client.session.keys.includes(topic)) return undefined;
    const s = this.client.session.get(topic);
    return s.expiry * 1000 > Date.now() ? s : undefined;
  }

  chainsOf(session: SessionTypes.Struct): number[] {
    const ns = session.namespaces.eip155;
    const ids = new Set<number>();
    for (const c of ns?.chains ?? []) ids.add(Number(c.split(":")[1]));
    for (const a of ns?.accounts ?? []) ids.add(Number(a.split(":")[1]));
    return [...ids].filter((n) => Number.isInteger(n));
  }

  /** The account the wallet exposed for a chain (wallets expose one address per chain; falls back to the first account). */
  addressOf(session: SessionTypes.Struct, chainId: number): Address {
    const accounts = session.namespaces.eip155?.accounts ?? [];
    const hit = accounts.find((a) => a.startsWith(`eip155:${chainId}:`)) ?? accounts[0];
    if (!hit) throw new ToolError("the wallet session exposes no EVM account");
    return getAddress(hit.split(":")[2] as string);
  }

  /** Asks the user's wallet to sign and broadcast; resolves with the hash once the wallet returns it. */
  async sendTransaction(topic: string, chainId: number, tx: WalletTx): Promise<Hex> {
    let result: unknown;
    try {
      result = await this.client.request<Hex>({ topic, chainId: `eip155:${chainId}`, request: { method: "eth_sendTransaction", params: [tx] } });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (/reject|denied|cancel/i.test(msg)) throw new ToolError("you rejected the request in your wallet; nothing was sent");
      throw new ToolError(`wallet request failed: ${msg.split("\n")[0]}`);
    }
    if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) throw new ToolError(`wallet returned an unexpected result: ${JSON.stringify(result).slice(0, 120)}`);
    return result as Hex;
  }

  async disconnect(topic: string): Promise<void> {
    if (!this.client.session.keys.includes(topic)) return;
    await this.client.disconnect({ topic, reason: { code: 6000, message: "User disconnected" } });
  }

  onSessionDelete(cb: (topic: string) => void): void {
    this.client.on("session_delete", ({ topic }) => cb(topic));
    this.client.on("session_expire", ({ topic }) => cb(topic));
  }

  onAccountsChanged(cb: (topic: string, address: Address) => void): void {
    this.client.on("session_event", ({ topic, params }) => {
      if (params.event.name !== "accountsChanged") return;
      const first = Array.isArray(params.event.data) ? params.event.data[0] : undefined;
      if (typeof first !== "string") return;
      const raw = first.includes(":") ? first.split(":").pop() : first;
      try {
        cb(topic, getAddress(raw as string));
      } catch {
        // ignore malformed account payloads
      }
    });
  }
}
