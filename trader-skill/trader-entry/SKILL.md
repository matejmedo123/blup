---
name: trader-entry
description: Entry Timer for day trades in US stocks, crypto and DEX meme coins. Watches one setup candle by candle and says exactly when to get in (e.g. "the 10:10 candle just closed above the opening range — get in $364.18"), with a liquidity/slippage gate for meme coins. Use when the user asks "when do I get in?", "watch TSLA for the breakout", "is BTC breaking the Asia range?", "tell me when this setup triggers", "did the opening range break yet?", "time my entry on this meme coin".
---

# Trader · Entry Timer

Watches one setup on closed 5-minute candles and reports its status:
`forming` → `watching` → `triggered` (or `invalidated` / `expired`). For meme coins a trigger only
counts if the pool is deep enough: liquidity ≥ the `min_liquidity_usd` limit and estimated slippage
for the trade size ≤ `max_slippage_pct`, otherwise the status is `blocked`.

The rules are the same code the scanner and backtester use (`shared/setups.py`): opening-range
breakout (15/30 min), gap-and-go, VWAP reclaim, bull flag, Asia / UTC-open / US-open range
breakouts, momentum breakout. Only closed candles count — a half-finished bar never triggers.

## Run

```bash
# a setup the scanner found (uses its symbol and rule)
python3 "${CLAUDE_SKILL_DIR}/entry.py" --id TSLA-20261020-orb15

# any symbol + rule
python3 "${CLAUDE_SKILL_DIR}/entry.py" TSLA --setup orb15
python3 "${CLAUDE_SKILL_DIR}/entry.py" BTC-USD --setup asia_range
python3 "${CLAUDE_SKILL_DIR}/entry.py" SOL:<mint> --setup momentum --size-usd 500

# keep watching until it triggers / fails (live data only)
python3 "${CLAUDE_SKILL_DIR}/entry.py" TSLA --follow --every 60 --max-minutes 90

# offline demo on fixture data
python3 "${CLAUDE_SKILL_DIR}/entry.py" --offline TSLA --setup orb15 --now 2026-10-20T14:15:00Z
```

Options: `--setup` (orb15, orb30, gap_and_go, vwap_reclaim, bull_flag, asia_range, us_open_range,
utc_open_range, momentum — default orb15 / asia_range / momentum), `--size-usd` (meme slippage
check; default account × meme max position %), `--follow --every --max-minutes`, plus the common
`--asset --offline --now --home --json --no-html --open`.

Running it again re-checks the same entry and records the transition (e.g. `Watching → TRIGGERED`).
For repeating rules (momentum, VWAP reclaim, bull flag) only triggers after you started watching count.
For a recurring check use `/loop 5m` with the same command instead of `--follow`.

## Reads / writes (in `trader/`)

- reads `setups.json` (for `--id`), `config.json`, `limits.json`, `rugcheck/*.json` (meme warning)
- writes `entries.json` (status, levels, trigger candle, entry price, history; `latest`)
- writes `reports/entry-<id>.html` (candles, range shading, trigger + stop-reference lines, entry marker)

## How to present results

Quote the three lines as printed: the level and rule, then the status line, e.g.
"Opening range high $362.18 (9:30–9:45 ET). Rule: 5-min close above." /
"Status: Watching → TRIGGERED — the 10:10 candle just closed above the opening range. Get in $364.18."
If the trigger is old, say price may have moved. For meme coins always show the liquidity/slippage
line and any rugcheck warning. Next step after a trigger: `/trader-exit` for the stop/target plan.
Always include the disclaimer line.

## Never

- Never place an order or tell the user a trade is certain — this only times an entry.
- Never treat a `blocked` meme trigger as an entry, and never skip `/trader-rugcheck` for meme coins.
- Never call a broker/exchange trading API or touch wallets/keys.
