# Telegram Partner-Fee Trading Bot

A self-custodial Telegram trading bot on the [Infrared](https://infraredtrading.com) API. Users connect their own wallet over WalletConnect and confirm every transaction on their phone; **you, the operator, earn a partner fee on every swap**, paid on-chain by the Infrared Router to your address.

> The bot never holds a private key. It quotes, builds and pre-flights; the user's wallet signs.
>
> Fork it, set `PARTNER_FEE_BPS` and `PARTNER_RECIPIENT`, run it, share it with your community.

## What users get

| Command | What it does |
|---|---|
| `/connect` | Link a wallet via WalletConnect (QR + copyable link) |
| `/wallet [tokens]` | Address and balances with USD values |
| `/chain [name]` | Pick a chain (Ethereum, Base, Arbitrum by default) |
| `/slippage [bps]` | View or set slippage, capped by the operator |
| `/price USDC WETH` | USD prices |
| `/quote 50 USDC to WETH` | Price a trade: expected and minimum outputs, price impact, fees, gas |
| `/swap 50 USDC to 60% WETH 40% cbBTC` | Same, with **Confirm** / **Cancel** buttons |
| `/fees` | What this bot charges |
| `/disconnect` | Unlink the wallet |

Trades take up to 6 input tokens (`0.01 ETH + 20 USDC to WETH`) and up to 6 outputs, settled in one transaction.

## How the fee works

Every quote carries `partner_fee: { partner_fee_bps, partner_recipient }`. Infrared signs those parameters into the transaction, the Router transfers the fee to your address on-chain in the same swap, and the quote card shows the fee to the user ("Fees: bot 0.5% + Infrared 0.15%"). Capped by the Router's `MAX_PARTNER_FEE_BPS` (currently 200 bps = 2%); the API rejects quotes above it with `PARTNER_FEE_EXCEEDS_CAP`. Your API key stays on the server, so nobody can re-quote the route without your fee through your bot.

## Safety

- **Self-custodial.** Every approve and swap is an `eth_sendTransaction` request the user accepts in their own wallet; the wallet is the taker and `msg.sender`.
- **Confirm button**, then build with `simulate:false` and a local `eth_call` pre-flight from the user's address at the gas it will send. A revert means no wallet prompt.
- **Quotes expire**: Confirm only works for 90 seconds (Infrared quotes build for 2 minutes), only for the user who requested it, and **once**.
- **Exact-amount approvals** to the Router only, zero-reset first for USDT-style tokens.
- Balance checked before quoting, decimals read on-chain, slippage capped by `MAX_SLIPPAGE_BPS`, optional `ALLOWED_USER_IDS`, `/connect` only in private chats.
- Per-user settings live in `DATA_DIR/users.json`; WalletConnect sessions in `DATA_DIR/walletconnect`. Back up `DATA_DIR` or users reconnect.

## Run it

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Create a free WalletConnect project at [cloud.reown.com](https://cloud.reown.com) and copy the project id.
3. `cp .env.example .env` and fill it in (an Infrared API key is required for building transactions).

```bash
npm ci && npm run build
set -a && . ./.env && set +a
node dist/index.js
```

Docker:

```bash
docker build -t infrared-tg-bot .
docker run -d --restart unless-stopped --env-file .env -v tg-bot-data:/app/data infrared-tg-bot
```

Any always-on host works (a $5 VPS, Fly.io, Railway); the bot uses long polling, so no public URL is needed.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | required | From @BotFather |
| `WALLETCONNECT_PROJECT_ID` | required | From cloud.reown.com |
| `INFRARED_API_KEY` | required | Infrared API key |
| `PARTNER_FEE_BPS` | `0` | Your fee per swap in bps (50 = 0.5%) |
| `PARTNER_RECIPIENT` | unset | Address that receives the fee; required when the fee is > 0 |
| `PARTNER_FEE_ON_OUTPUT` | `false` | Charge the fee on the output token instead of the input |
| `CHAINS` | `1,8453,42161` | Enabled chain ids; each needs `RPC_URL_<id>` |
| `RPC_URL_<id>` | unset | JSON-RPC per enabled chain |
| `DEFAULT_SLIPPAGE_BPS` | `50` | Slippage for new users |
| `MAX_SLIPPAGE_BPS` | `300` | Highest slippage a user may set |
| `ALLOWED_USER_IDS` | unset | Restrict the bot to these Telegram user ids |
| `DATA_DIR` | `./data` | Users file and WalletConnect storage |
| `BOT_NAME` | `Infrared Trading Bot` | Shown to wallets and in /start |

## Verify it end to end

`npm run e2e` forks a real chain with [anvil](https://getfoundry.sh), starts a real WalletConnect wallet peer in-process that signs with a fresh key, and drives the bot's handlers with Telegram updates while recording its replies (Telegram's HTTP API is the only thing not real). It checks the quote card, cancel, a live swap with exact input spent, outputs at or above the quoted minimum, the 60/40 split, the **partner fee landing in the recipient's wallet**, exact approval, no double execution, wallet rejection, and the user allowlist:

```bash
FORK_RPC_URL=<rpc> INFRARED_API_KEY=<key> WALLETCONNECT_PROJECT_ID=<id> npm run e2e -- --chain arbitrum   # or base, ethereum
```

Unit tests: `npm test`.

## API key

Infrared API keys are invite-only for now; request one from the Infrared team.
