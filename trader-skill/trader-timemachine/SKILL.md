---
name: trader-timemachine
description: Time Machine — before risking a dollar, replay the rest of today (stocks) or the next 1h/4h/24h (crypto, meme coins) 10,000 times from the symbol's own 5-minute candles and show where the planned trade most likely ends — probability of target first / stop first / neither (plus rug pulls for meme coins), expected value in R and $, the 90 % closing range, a fan chart and a histogram. Use after /trader-exit has written a plan, when the user says "replay this trade", "run the time machine", "what are the odds", "simulate the rest of the day", "monte carlo this setup", "how likely is my target", "10,000 simulations".
---

# Trader · Time Machine ⭐

Takes the plan from `/trader-exit` (entry, stop, target, time stop) and replays the
rest of the trade 10,000 times:

1. Loads the symbol's own history up to the entry — stocks ~60 sessions of 5-min bars,
   crypto ~60 days, meme coins whatever exists (under 3 days → flagged *thin*, uncertainty widened).
   Nothing after the entry is ever used.
2. Builds each path by **block bootstrap** of real bars (30-minute blocks by default) drawn
   from the same time-of-day bucket — stocks: morning / midday / power hour; crypto: Asia /
   Europe / US hours. Each bar keeps its real high/low range, so jumps and fat tails survive.
   Volatility is scaled bucket by bucket to recent realized volatility; the average drift is
   removed (a few days' trend is not a forecast; `--keep-drift` keeps it).
3. Meme coins: a share of paths ends in a **rug pull** (liquidity pulled, −90 %), set from the
   `/trader-rugcheck` score, and exits pay estimated pool slippage.
4. Walks every path with the same stop/target/time-stop logic as `/trader-backtest`
   (stop before target when one bar touches both, gaps through the stop fill at the open).

## Run

```bash
python3 "${CLAUDE_SKILL_DIR}/replay.py"                          # latest plan in trader/plan.json
python3 "${CLAUDE_SKILL_DIR}/replay.py" --id TSLA-20261020-orb15
python3 "${CLAUDE_SKILL_DIR}/replay.py" --id BTCUSD-20261020-asia_range --horizon 4h
python3 "${CLAUDE_SKILL_DIR}/replay.py" --with-backtest          # also run /trader-backtest if none on file
python3 "${CLAUDE_SKILL_DIR}/report.py" --file timemachine/TSLA-20261020.json --open   # rebuild the page
```

Offline demo (fixtures, no network): add `--offline --now 2026-10-20T14:15:00Z` after a
plan exists (see the README walkthroughs).

Options: `--paths 10000` · `--seed 7` (same seed → same numbers) · `--horizon 1h|4h|24h`
(crypto/meme) · `--block 6` (bars per bootstrap block) · `--rug-share 0.1` / `--no-rug` (meme) ·
`--size-usd 500` (meme slippage) · `--sample 200` (paths in the fan chart) · `--keep-drift` ·
`--json` · `--no-html` · `--open`.

## Reads / writes

- Reads `trader/plan.json` (from `/trader-exit`), `trader/orders.json` (position size, if
  `/trader-sizer` ran), `trader/backtests/{symbol}-{setup}.json` (historical check),
  `trader/rugcheck/{chain}-{address}.json` (meme rug share), `trader/config.json`, `trader/limits.json`.
- Writes `trader/timemachine/{symbol}-{YYYYMMDD}.json` and
  `trader/reports/timemachine-{symbol}-{YYYYMMDD}.html` (fan chart of 200 paths with a live
  "6,904 … 10,000 simulated sessions" counter, closing-price histogram with Stop / Entry /
  Target lines, backtest comparison, method notes).

## How to present results

Lead with the plain-English summary the tool prints, e.g. *"Entry $364.18, stop $358.32,
target $375.90. I replayed the rest of today 10,000 times from TSLA's own candles… Target
first 24 % · Stop first 56 % · Neither 20 %. 9 in 10 replays close between $346.60 and
$383.29."* Then the expected value in R and $, the backtest comparison if present, and the
report path. Always repeat that this is a statistical simulation of past price behaviour,
not a prediction — it ignores news shocks and gaps — and pass on any *thin sample* or
rug-scenario warning. Show the disclaimer (the stronger one for meme coins).

## Never

- Never present the probabilities as a forecast, a guarantee, or a reason to size up.
- Never use data after the entry time, and never invent a plan — if `trader/plan.json` has
  none, ask the user to run `/trader-exit` first.
- Never place orders or touch wallets; the next steps are `/trader-sizer` → `/trader-risk`.
