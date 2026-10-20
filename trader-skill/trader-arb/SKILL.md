---
name: trader-arb
description: Read-only arbitrage gap monitor for crypto and meme coins — compares the same token across its DEX pools (DexScreener) or the same coin across exchanges (Binance, Coinbase, Kraken) and shows whether any price gap survives fees, slippage at your size and network costs. Never trades. Use when the user asks "is there an arbitrage opportunity on X", "check price gaps between pools/exchanges", "could an arb bot make money on this token", "compare BTC price across exchanges", or shares one of those "arbitrage bot turned $1 into $400k" stories.
---

# Trader · Arbitrage Gap Monitor (add-on, read-only)

Shows how big the price gap between venues really is **after costs** — and explains why a gap you
can see on free data is almost never one you can trade.

* **Meme coins** — every pool of the token on its chain (DexScreener): price, liquidity, pool fee
  (typical tier per DEX), estimated slippage at your size (constant-product pool), network cost per
  swap, and whether the pool traded in the last 5 minutes (no trades → stale price).
  Pools too thin for your size are listed but excluded from routes.
* **Crypto** — Binance (USDT, converted to USD with Kraken's USDT/USD rate), Coinbase (USD), Kraken,
  each with a retail taker fee and a small slippage allowance.
* For every buy-here / sell-there route: gap − (both fees + both slippages + network) = net.

Verdicts: `no edge after costs`, `no tradeable gap`, `paper gap on a stale quote`,
`gap above estimated costs` (always with the warning that it will be gone before anyone can act),
`only one venue`.

## Run

```bash
python3 "${CLAUDE_SKILL_DIR}/arb.py" SOL:<mint> --size-usd 500
python3 "${CLAUDE_SKILL_DIR}/arb.py" BTCUSDT ETHUSDT --size-usd 2000
python3 "${CLAUDE_SKILL_DIR}/arb.py" --from-setups --asset meme      # every crypto/meme hit from the scanner
python3 "${CLAUDE_SKILL_DIR}/arb.py" SOL:<mint> --offline             # fixture demo, no network
```

| Option | Meaning |
|---|---|
| `symbols…` | meme coin (`SOL:<mint>`, `base:0x…`) or crypto symbol (`BTCUSDT`, `BTC-USD`) |
| `--size-usd X` | size per leg (default: meme = max position % of account, crypto = $1,000) |
| `--from-setups` | check every crypto/meme symbol in `trader/setups.json` |
| common | `--asset --offline --now --home --json --no-html --open` |

## Reads / writes

* reads `trader/config.json`, `trader/limits.json`, `trader/setups.json` (with `--from-setups`)
* writes `trader/arb/{symbol_key}.json` (latest check), appends `trader/arb_log.jsonl`,
  writes `trader/reports/arb-YYYYMMDD-HHMM.html`

## How to present results

Lead with the verdict and the best route's arithmetic ("gap +0.15 % − costs 6.27 % = net −6.12 %").
Then the reality check, in plain words: real arbitrage is a millisecond race won by bots co-located
with exchanges or validators (MEV searchers on Solana); free APIs lag by seconds to minutes; the
viral "$1 → $400k arbitrage bot" stories are survivorship bias at best, and bots or services that ask
for a private key or a deposit are a common scam. Always include the disclaimer.

## Never

* Never call it an "opportunity" or suggest trading a gap — this tool only watches.
* Never execute swaps or trades, never connect a wallet, never ask for or store keys or API secrets.
* Never recommend third-party "arbitrage bots", copy-trading services or contracts to deposit into.
* Never hide costs or the stale-quote warning to make a gap look better.
