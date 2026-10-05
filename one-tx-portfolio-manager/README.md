# One-Tx Portfolio Manager

Rebalance a wallet, dollar-cost average into several assets, or sweep leftover tokens, each in **one transaction** via the [Infrared](https://infraredtrading.com) API. Self-custodial: your key signs locally and never leaves the machine or runner.

> **Use a fresh wallet that only this bot controls.** It holds a hot key. Fund it with what you're willing to automate, and keep `max_notional_usd` low.
>
> **Dry-run is the default.** Nothing is sent unless you pass `--execute` (or set `EXECUTE=true` in Actions).

| Mode | What it does | Example |
|---|---|---|
| `rebalance` | Sells every overweight token and buys every underweight one in a single swap | 40% USDC / 30% WETH / 30% WBTC |
| `dca` | Splits one input across up to 6 assets | 25 USDC -> 60% WETH + 40% WBTC |
| `sweep` | Turns up to 6 leftover tokens into one; tokens with no route are skipped and reported | WETH + WBTC -> USDC |

Chains: Ethereum (`1`), Arbitrum (`42161`). Base is coming soon.

## Run it on a schedule (GitHub Actions, no server)

1. Click **Use this template** on the `infrared-examples` repo to create your own copy.
2. Edit `one-tx-portfolio-manager/config.yaml`: chain, tokens, weights, caps.
3. **Settings -> Secrets and variables -> Actions -> Secrets**: add `PRIVATE_KEY`, `RPC_URL`, `INFRARED_API_KEY`.
4. **Actions -> one-tx-portfolio-manager -> Run workflow**. The log shows the plan; nothing is sent.
5. When the plan looks right, add the repository **variable** `EXECUTE` = `true`. Optionally set `MODE` to `dca` or `sweep` (default `rebalance`).

It runs Mondays 14:00 UTC; change the `cron` in `.github/workflows/one-tx-portfolio-manager.yml`.

## Run it locally

Node 20+, from the `one-tx-portfolio-manager/` directory:

```bash
cp .env.example .env    # fill in PRIVATE_KEY, RPC_URL, INFRARED_API_KEY
npm ci && npm run build
set -a && . ./.env && set +a
node dist/cli.js rebalance            # dry-run: prints the plan
node dist/cli.js rebalance --execute  # sends it
```

Docker:

```bash
docker build -t one-tx-portfolio-manager .
docker run --rm --env-file .env -v "$PWD/config.yaml:/app/config.yaml" one-tx-portfolio-manager dca
```

Add `--json` for a machine-readable plan.

## Safety rails

- `max_notional_usd`: any run worth more is refused before anything is sent.
- `slippage_bps`: the Infrared Router enforces the quoted minimum output on-chain; a worse fill reverts.
- Approvals are for the exact amount being sold, to the Router the swap calls, never unlimited.
- Token decimals are read on-chain; an unreadable token aborts the run.
- At most 6 tokens in and 6 out per transaction; larger configs are rejected, never truncated.
- `gas_reserve_wei` keeps ETH back for gas whenever ETH is traded.

## Verify it end to end

`npm run e2e` forks a real chain with [anvil](https://getfoundry.sh), funds a fresh wallet, runs every mode against the live API, and checks the resulting on-chain balances:

```bash
FORK_RPC_URL=<rpc for the chain> INFRARED_API_KEY=<key> npm run e2e -- --chain arbitrum   # or ethereum
```

## API key

Infrared API keys are invite-only for now; request one from the Infrared team.
