// The "phone": a WalletConnect wallet peer that approves sessions and signs eth_sendTransaction
// requests with a fresh key against the anvil fork. Runs as a child process of e2e/run.ts because
// two WalletConnect clients cannot share one Node process. Controlled over IPC.
import { SignClient } from "@walletconnect/sign-client";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

type Cmd = { type: "pair"; uri: string } | { type: "rejectNext" } | { type: "stats" };

async function main(): Promise<void> {
  const projectId = process.env.WALLETCONNECT_PROJECT_ID as string;
  const key = process.env.PEER_PRIVATE_KEY as Hex;
  const rpc = process.env.PEER_RPC_URL as string;
  const dir = process.env.PEER_DATA_DIR as string;
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, transport: http(rpc) });
  const client = await SignClient.init({ projectId, logger: "error", storageOptions: { database: dir }, metadata: { name: "e2e wallet", description: "fork signer", url: "https://example.invalid", icons: [] } });
  let rejectNext = false;
  let handled = 0;
  const send = (msg: unknown) => process.send?.(msg);

  client.on("session_proposal", async ({ id, params }) => {
    const chains = [...new Set([...(params.requiredNamespaces.eip155?.chains ?? []), ...(params.optionalNamespaces?.eip155?.chains ?? [])])];
    const { acknowledged } = await client.approve({
      id,
      namespaces: { eip155: { chains, accounts: chains.map((c) => `${c}:${account.address}`), methods: ["eth_sendTransaction"], events: ["chainChanged", "accountsChanged"] } },
    });
    await acknowledged();
    send({ type: "approved" });
  });

  client.on("session_request", async ({ id, topic, params }) => {
    handled++;
    if (params.request.method !== "eth_sendTransaction") {
      await client.respond({ topic, response: { id, jsonrpc: "2.0", error: { code: 5101, message: "unsupported method" } } });
      return;
    }
    if (rejectNext) {
      rejectNext = false;
      await client.respond({ topic, response: { id, jsonrpc: "2.0", error: { code: 5000, message: "User rejected the request" } } });
      return;
    }
    const tx = params.request.params[0] as { to: Address; data: Hex; value: Hex; gas: Hex; from: Address };
    if (tx.from.toLowerCase() !== account.address.toLowerCase()) {
      await client.respond({ topic, response: { id, jsonrpc: "2.0", error: { code: 5000, message: `request from ${tx.from} is not this wallet` } } });
      return;
    }
    const hash = await wallet.sendTransaction({ account, chain: null, to: tx.to, data: tx.data, value: BigInt(tx.value), gas: BigInt(tx.gas) });
    await client.respond({ topic, response: { id, jsonrpc: "2.0", result: hash } });
  });

  process.on("message", async (cmd: Cmd) => {
    try {
      if (cmd.type === "pair") {
        await client.pair({ uri: cmd.uri });
        send({ type: "paired" });
      } else if (cmd.type === "rejectNext") {
        rejectNext = true;
        send({ type: "ok" });
      } else if (cmd.type === "stats") {
        send({ type: "stats", handled });
      }
    } catch (err) {
      send({ type: "error", message: (err as Error).message });
    }
  });
  send({ type: "ready", address: account.address });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
