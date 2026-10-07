# Infrared Trading MCP

An [MCP](https://modelcontextprotocol.io) server that lets Claude (Desktop, Code) and any other MCP client quote, build, pre-flight and, only when you opt in, execute trades through the [Infrared](https://infraredtrading.com) API. Self-custodial: the key signs locally and never leaves the machine.

> **Use a fresh wallet that only this server controls**, fund it with what you are willing to let an agent trade, and keep `MAX_NOTIONAL_USD` low.
>
> **Nothing is sent unless `EXECUTE_ENABLED=true`.** Without it, `execute_trade` runs the whole pipeline up to the local pre-flight and reports what it would have sent.

## Tools

| Tool | Needs | What it does |
|---|---|---|
| `get_wallet_status` | nothing | Wallet address, live/dry-run mode, caps, chains with an RPC |
| `list_chains` | nothing | Supported chains and health |
| `list_protocols` | nothing | Routable protocols; ids usable in `include_protocols` / `exclude_protocols` |
| `search_tokens` | nothing | Registry search by symbol, name, address or tags |
| `get_prices` | nothing | USD prices (null when unknown, never guessed) |
| `get_balances` | nothing | Balances with USD value; from your RPC when configured, else via Infrared |
| `get_allowances` | nothing | ERC-20 allowances for (token, spender) pairs |
| `get_network` | nothing | Gas tiers and latest block |
| `get_quote` | nothing | Up to 6 inputs -> up to 6 outputs in one transaction; human amounts, symbols or addresses; returns `quote_id`, expected and minimum outputs, USD value, approvals needed |
| `build_transaction` | `INFRARED_API_KEY` | Unsigned Router transaction (`to`, `data`, `value`, `gas`) plus an `eth_call` pre-flight from the taker at the gas it would send |
| `approve_token` | key + wallet | Exact-amount approvals to the Infrared Router only. Guarded like `execute_trade` |
| `execute_trade` | key + wallet | Approve -> build -> pre-flight -> sign -> send -> receipt -> on-chain balance changes. Guarded |

## Safety model

- **Dry-run by default.** `EXECUTE_ENABLED` must be exactly `true`, and only together with `PRIVATE_KEY`.
- **Explicit confirmation.** `execute_trade` and `approve_token` require `confirm: true`; the server instructions tell the agent to show the user the quote first. Keep your MCP client's own tool-approval prompt on for these two tools.
- **Notional cap.** Inputs are priced via Infrared; anything above `MAX_NOTIONAL_USD` (default 100) or with an unpriced input is refused.
- **Slippage ceiling.** `MAX_SLIPPAGE_BPS` (default 100 = 1%). The Router enforces the quoted minimum output on-chain; a worse fill reverts.
- **Only quotes this server created can be executed**, within 90 seconds of creation (Infrared quotes build for 2 minutes), with this wallet as taker, and **exactly once**: Infrared will build a quote again, so the server tracks what it has already sent.
- **Pre-flight before send.** Build with `simulate:false`, then `eth_call` from the wallet at the gas limit that will be sent; a revert means nothing is broadcast.
- **Exact approvals** to the Router for the amount being sold, never unlimited; USDT-style tokens get the zero-reset first.
- **Decimals come from the chain** (or the Infrared registry when no RPC is configured). An unknown token aborts; nothing is ever assumed.
- The private key is read from the environment once and no tool ever returns it.

## Run it with Claude Desktop

Node 20+. From this directory: `npm ci && npm run build`. Then add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "infrared": {
      "command": "node",
      "args": ["/absolute/path/to/infrared-trading-mcp/dist/index.js"],
      "env": {
        "INFRARED_API_KEY": "...",
        "RPC_URL_8453": "https://base-mainnet.g.alchemy.com/v2/<key>",
        "PRIVATE_KEY": "0x...",
        "MAX_NOTIONAL_USD": "50"
      }
    }
  }
}
```

Leave out `PRIVATE_KEY` for a read-only server (quotes and pre-flights still work). Add `"EXECUTE_ENABLED": "true"` when you are ready to let it send.

## Run it with Claude Code

```bash
claude mcp add infrared -e INFRARED_API_KEY=... -e RPC_URL_42161=https://... -e PRIVATE_KEY=0x... -- node /absolute/path/to/infrared-trading-mcp/dist/index.js
```

Then: "Quote 25 USDC into 60% WETH and 40% WBTC on Arbitrum, and execute it if the price impact is under 20 bps."

## Docker

```bash
docker build -t infrared-trading-mcp .
# MCP speaks over stdio, so the client runs the container:
#   "command": "docker", "args": ["run", "-i", "--rm", "--env-file", "/path/to/.env", "infrared-trading-mcp"]
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `INFRARED_API_KEY` | unset | Required for `build_transaction`, `approve_token`, `execute_trade` |
| `RPC_URL_<chain_id>` | unset | JSON-RPC per chain (e.g. `RPC_URL_1`, `RPC_URL_8453`, `RPC_URL_42161`). Needed to pre-flight and trade on that chain |
| `PRIVATE_KEY` | unset | Hot key of a fresh wallet. Without it the server is read-only |
| `EXECUTE_ENABLED` | `false` | Exactly `true` to send transactions |
| `MAX_NOTIONAL_USD` | `100` | Refuse trades whose inputs are worth more |
| `MAX_SLIPPAGE_BPS` | `100` | Refuse quotes asking for more slippage |
| `INFRARED_API_URL` | `https://api.infraredtrading.com` | API base URL |

## Verify it end to end

`npm run e2e` forks a real chain with [anvil](https://getfoundry.sh), funds a fresh wallet, starts the server over stdio in read-only, dry-run and live configurations, drives it with the MCP client SDK against the live API, and checks the resulting on-chain balances (exact input spent, outputs at or above the quoted minimum, 60/40 split, exact approval, no double execution):

```bash
FORK_RPC_URL=<rpc for the chain> INFRARED_API_KEY=<key> npm run e2e -- --chain arbitrum   # or ethereum, base
```

Unit tests: `npm test`.

## API key

Infrared API keys are invite-only for now; request one from the Infrared team. Quotes need no key.
