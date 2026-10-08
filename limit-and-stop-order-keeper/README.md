# Limit and Stop Order Keeper

Self-custodial limit, stop-loss and take-profit orders on any token pair, filled at the **executable price** through the [Infrared](https://infraredtrading.com) API. Runs on your machine with a dedicated wallet; no venue, no custodian.

> **Use a fresh wallet that only this keeper controls.** It holds a hot key. Fund it with what you are willing to automate and keep `max_notional_usd` low.
>
> **Dry-run is the default.** Nothing is sent unless you pass `--execute`.

| Order type | Fires when | Example |
|---|---|---|
| `stop_loss` | 1 `sell` token is worth **at most** `trigger_price` `buy` tokens | sell 0.05 WETH for USDC when WETH <= 2200 USDC |
| `take_profit` | 1 `sell` token is worth **at least** `trigger_price` `buy` tokens | sell all WETH for USDC when WETH >= 3500 USDC |
| `limit_buy` | 1 `buy` token costs **at most** `trigger_price` `sell` tokens | spend 100 USDC on WETH when WETH <= 2300 USDC |

Each tick the keeper asks Infrared for a real quote of the order's exact size and judges the trigger on the price that quote would actually deliver (expected output / input, price impact included). `/v1/prices` is only a pre-filter: orders far from their trigger are not quoted.

## Run it

```bash
cp .env.example .env            # PRIVATE_KEY, RPC_URL_<chain_id> per chain, INFRARED_API_KEY
# edit orders.yaml
npm ci && npm run build
set -a && . ./.env && set +a
node dist/cli.js                 # dry-run loop: prints what each order would do
node dist/cli.js --execute       # live
node dist/cli.js --once --json   # one pass, machine-readable (cron is NOT recommended, see below)
```

Docker (the state volume is what makes fill-once survive restarts):

```bash
docker build -t order-keeper .
docker run -d --restart unless-stopped --env-file .env -v keeper-data:/app/data -v "$PWD/orders.yaml:/app/orders.yaml" order-keeper --execute
```

The process exits on its own once every order is filled, expired or failed.

## orders.yaml

```yaml
interval_seconds: 60
max_notional_usd: 500            # default cap per fill
gas_reserve_wei: "2000000000000000"
state_file: ./data/state.json

orders:
  - id: weth-stop                # unique; the state file is keyed by it
    chain_id: 42161
    type: stop_loss
    sell: { token: "0x82aF...bab1", amount: "0.05" }   # or amount: all
    buy:  { token: "0xaf88...5831" }
    trigger_price: 2200          # USDC per WETH
    slippage_bps: 100            # default 50
    confirmations: 2             # consecutive ticks the trigger must hold (default 2)
    prefilter_bps: 300           # quote only within 3% of the trigger (default 300)
    max_notional_usd: 150        # per-order override
    expires: 2026-12-31T00:00:00Z
```

Amounts and prices are human units. Decimals are read on-chain. Use the zero address or `0xEeee...EEeE` for the native currency.

## Safety rails

- **Fill once.** Every order's status lives in `state_file`; filled, expired and failed orders are never re-evaluated. If the process dies mid-fill, the order is marked `failed` with the broadcast hash and is never retried blindly. Back up the state file with the keeper.
- **No GitHub Actions / cron mode on purpose.** A scheduled run without durable state could fill the same order twice. Run one long-lived process.
- **Confirmations.** The trigger must hold for `confirmations` consecutive ticks, so a one-tick wick does not fire a stop.
- **Pre-flight before send.** Build with `simulate:false`, then `eth_call` from the keeper wallet at the gas limit it will send; a revert means nothing is broadcast. Build happens before approvals, so a rejected API key sends nothing.
- `max_notional_usd` per fill (priced by Infrared; an unpriced token refuses), `slippage_bps` enforced on-chain by the Router, exact-amount approvals, `gas_reserve_wei` when selling the native currency, three failed fill attempts mark the order `failed`.

## Verify it end to end

`npm run e2e` forks a real chain with [anvil](https://getfoundry.sh), funds a fresh wallet, and runs the CLI pass by pass against the live API with triggers set just past and just short of the current executable price. It checks: dry-run fires nothing, the pre-filter skips far orders, a 2-confirmation order arms then fills, filled orders never refill, exact on-chain balance changes, expired / capped / empty-balance orders are skipped with reasons, mid-fill crash recovery, and that a rejected API key sends nothing.

```bash
FORK_RPC_URL=<rpc for the chain> INFRARED_API_KEY=<key> npm run e2e -- --chain arbitrum   # or base, ethereum
```

Unit tests: `npm test`.

## API key

Infrared API keys are invite-only for now; request one from the Infrared team.
