---
name: trader-journal
description: Trade journal and performance stats for day trading stocks, crypto and meme coins. Logs every trade (asset class, setup, entry, exit, R result, fees and slippage, chart) and computes win rate, average R, expectancy, profit factor and best/worst setups — overall and per asset class — with an HTML report. Can play a paper trade forward on the candles to find where it ended. Use when the user says "log this trade", "journal it", "how did that trade end", "close the trade", "what's my win rate", "which setups work", "show my stats", "trading journal", or at the end of the day.
---

# Trader · Trade Journal

Keeps `trader/journal.json` honest and turns it into numbers that tell you which setups actually pay.

- **add** — log a trade from a plan (and its order, for the quantity):
  - `--auto` plays the plan forward on the closed candles since the entry with the same stop / target / time stop /
    trailing / scale-out rules as the backtester (stop assumed first when one bar touches both). Closed if a stop,
    target or time stop was reached; otherwise it stays **open** with a mark price.
  - `--exit-price X [--exit-time ISO] [--reason target|stop|time|manual|liquidity|rug]` logs a real exit.
  - no exit flags → logs the trade as open.
- **close TRADE_ID** — close an open trade with `--exit-price` (or `--auto`).
- **list [--open-only]**, **stats [--asset stock|crypto|meme]**.

R = (exit − entry) ÷ (entry − stop). P&L = qty × (exit − entry) − fees − slippage (meme coins: USD amount ×
(exit/entry − 1) − costs). Fees default to `costs[asset].fee_bps` from config; `--auto` also estimates slippage from
`slippage_bps`. The meme liquidity exit cannot be replayed from candles — watch it with /trader-alerts.

## Run

```bash
python3 "${CLAUDE_SKILL_DIR}/journal.py" add --plan TSLA-20261020-orb15 --auto
python3 "${CLAUDE_SKILL_DIR}/journal.py" add --plan TSLA-20261020-orb15 --exit-price 371.20 --reason manual --fees 1.00
python3 "${CLAUDE_SKILL_DIR}/journal.py" close trd-TSLA-20261020-orb15 --exit-price 358.10 --reason stop
python3 "${CLAUDE_SKILL_DIR}/journal.py" list --open-only
python3 "${CLAUDE_SKILL_DIR}/journal.py" stats --asset crypto --open
```

Options: `add|close|list|stats`, `TRADE_ID`, `--plan`, `--order`, `--auto`, `--exit-price`, `--exit-time`, `--reason`,
`--qty`, `--fees`, `--slippage`, `--notes`, `--open-only`, plus the common
`--asset --offline --fixtures --now --home --json --no-html --open` (`--open` opens the HTML report).

## Reads / writes

- Reads `trader/plan.json`, `trader/orders.json`, `trader/config.json`, candles via the shared data layer.
- Writes `trader/journal.json`, `trader/reports/journal.html` (tiles, cumulative-R chart, per-asset and per-setup
  tables, all trades) and `trader/reports/trade-{id}.html` (the trade on its candles with entry/exit, stop/target).

## How to present results

For a logged trade: one line with symbol, setup, entry → exit, reason, R and P&L (fees and slippage included), and
whether it was paper or live. For stats: win rate, average R, expectancy, profit factor and P&L overall, then per asset
class, then best and worst setup — and say plainly when the sample is too small to mean much (under ~20 trades).
Link the HTML report. Always end with the disclaimer the tool prints.

## Never

- Never invent or "round up" exits — use the user's real fills or `--auto`, and label paper trades as paper.
- Never delete or rewrite past trades to improve the stats.
- Never place, change or cancel orders from here.
