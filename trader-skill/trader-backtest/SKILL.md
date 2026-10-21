---
name: trader-backtest
description: Backtester for day-trading setups on US stocks, crypto and DEX meme coins. Replays one setup rule (opening-range breakout, gap-and-go, VWAP reclaim, bull flag, Asia/US-open range breakout, momentum) over the last N sessions or days with the exit planner's stop/target/time stop, fees and slippage — "Last 59 sessions: 33 triggers, 13 hit target, 15 hit stop, 5 neither." Also the backtest lab (`lab.py`): every crypto setup on dozens of coins and on 5-minute, 1-hour and 4-hour bars, a grid of 160 exits, walk-forward validation, and the playbook of validated coin+setup combinations the autopilot trades crypto from — sized by how certain the result is. Use when the user asks "does this setup work?", "backtest the ORB on TSLA", "how often does the Asia-range breakout hit target on BTC?", "validate this setup before I trade it", "what's the hit rate?", "backtest more coins", "which crypto setup has the highest chance?", "find the best exits", or "refresh the playbook".
---

# Trader · Backtester

Runs a setup rule over every past session (stocks) or UTC day (crypto, meme coins):

1. finds the first trigger in each window with the **same rule code** as the scanner and entry timer;
2. sets stop / target / time stop with the **same logic** as the exit planner (`plan_levels`);
3. walks the following bars: stop first if a bar touches both, gaps through the stop fill at the open,
   stocks are flat by 3:55 p.m. ET, crypto/meme exit at the horizon;
4. charges fees + slippage per side (config `costs`; meme coins add an estimated price impact
   for `--size-usd` against today's pool liquidity).

Output: counts of target / stop / neither, win rate, average and total R (net of costs), max
drawdown in R, and the trade list. The Time Machine reads this file for its historical check.

## Run

```bash
python3 "${CLAUDE_SKILL_DIR}/backtest.py" TSLA --setup orb15 --sessions 60
python3 "${CLAUDE_SKILL_DIR}/backtest.py" BTCUSDT --setup asia_range --days 30 --horizon 4h
python3 "${CLAUDE_SKILL_DIR}/backtest.py" SOL:<mint> --setup momentum --size-usd 500
python3 "${CLAUDE_SKILL_DIR}/backtest.py" TSLA --setup orb15 --target-r 1.5 --trail breakeven:1 --fee-bps 1
# offline demo on fixture data
python3 "${CLAUDE_SKILL_DIR}/backtest.py" --offline TSLA --setup orb15
```

Options: `--setup`, `--sessions` (stocks) / `--days` (crypto, meme), `--target-r`, `--stop
auto|range|level|atr`, `--atr-mult`, `--horizon 1h|4h|24h`, `--trail`, `--fee-bps`, `--slippage-bps`,
`--size-usd`, `--include-current` (also test today), plus the common
`--asset --offline --now --home --json --no-html --open`.

Free Yahoo data keeps only ~60 calendar days of 5-minute bars (≈ 40 sessions); meme coins often
have only days of history — the tool warns when the sample is thin (< 10 triggers).

## Backtest lab — many coins, every setup, honest validation

```bash
python3 "${CLAUDE_SKILL_DIR}/lab.py"                                  # top 25 coins · 5m 180 d · 1h 365 d · 4h 730 d · 1d ~8 y
python3 "${CLAUDE_SKILL_DIR}/lab.py" --symbols BTCUSDT,ETHUSDT --timeframes 1h,4h
python3 "${CLAUDE_SKILL_DIR}/lab.py" --objective win                  # highest share of winners instead of certainty
python3 "${CLAUDE_SKILL_DIR}/lab.py" --min-target-r 2                 # only exits that aim for 2R or more
python3 "${CLAUDE_SKILL_DIR}/lab.py" --fee-bps 25                     # e.g. Alpaca's crypto taker fee
```

* Setups: the one-day crypto rules on 5-minute bars, four swing rules on 1-hour and 4-hour bars
  (trend pullback, oversold bounce, Bollinger-band bounce, 24-bar breakout — all long, all above the
  200 EMA), and two daily rules with built-in exits, both active only while Bitcoin is above its 200-day
  average: **trend_breakout** (close above the 20-day high; out at the first close below the 10-day
  low, ≤ 60 days, 3×ATR stop) and **dip_in_uptrend** (3 lower closes, RSI(2) < 10, above the 50- and
  200-day averages; out at the first close above the 5-day average, ≤ 10 days, 3×ATR stop), plus the
  user's cheat-sheet strategies **trend_ema** (20 EMA > 50 EMA, higher highs and lows; out below the
  50-day EMA; stop below the 10-day swing low) and **breakout_volume** (20-day high on 1.5× volume; out
  below the 10-day low; stop 1 ATR under the broken high).
  Rule-exit setups skip the exit grid — the rule is the exit.
* Exits: targets 0.5–5R × structure stop or 1/1.5/2/3×ATR × four time stops (5m: 1–24 h; 1h: 12–72 h;
  4h: 1–7 days) = 160 per setup and timeframe, fees and slippage on every trade.
* **Certainty first, walk-forward:** the history is cut into four equal periods. For each of the last
  three, the exit with the highest *profit chance* (how often 20 trades ended in profit) among exits
  with a net edge is picked on everything before it, all coins pooled, and then traded unchanged in
  that period, which the choice never saw. A setup **holds** only if it made money in every one of
  those periods; a coin is **validated** only if it made money out of sample, including the latest
  period. The exit traded is the one chosen last.
* The report also shows the highest *win chance* each setup can reach and what it earned — usually a
  lot of small wins and a loss overall — and an overfitting check: how many per-coin "best settings"
  survived the latest period.
* **Letting winners ride:** for setups with a runner rule (trend breakout) the lab also trades every
  out-of-sample period a second way — a winner above its 200-day average sells a third at the exit rule
  and keeps two thirds until a daily close below the 50-day EMA, stop at the buy price — and reports
  whether that paid ("✓ let winners ride: … added +0.44R per trade, profit chance 93 % → 92 %"). The
  verdict goes into the playbook; the autopilot lets winners ride only while it says yes.
* Validated combinations go to `trader/backtests/playbook.json` (valid 14 days). The autopilot trades
  crypto **only** from it, with those exits, and sizes by certainty: profit chance ≥ 90 % → risk × 2,
  ≥ 80 % → × 1.5, ≥ 70 % → × 1, lower → × 0.5 (a boost needs ≥ 30 unseen trades; `limits.json` caps
  always apply). The daemon re-runs the lab weekly.
* History is cached in `trader/cache/lab/` and only the new tail is downloaded next time (the first run
  downloads ~6 months of 5-minute bars per coin and takes 10–15 minutes).

## Reads / writes (in `trader/`)

- reads `config.json` (costs, horizons), `limits.json` (meme default size)
- writes `backtests/<symbol_key>-<setup>.json` (stats + every trade) and
  `reports/backtest-<symbol_key>-<setup>.html` (cumulative R chart, outcome table, trades)
- lab: writes `backtests/lab-crypto.json`, `backtests/playbook.json`, `reports/lab-crypto.html` and the
  candle store `cache/lab/<symbol>-<interval>.json`

## How to present results

Quote the summary sentence exactly ("Last 59 sessions: 33 triggers, 13 hit target, 15 hit stop,
5 neither.") then win rate, average net R and max drawdown, and the cost assumptions. Flag thin
samples plainly. Past hit rates are not a promise — say so. Suggest `/trader-timemachine` next.
For the lab: lead with how many combinations were validated on unseen data, then the validated list
(win chance, edge, profit chance, out-of-sample trades), then the "highest win chance" table to explain why a
high hit rate alone loses money, and the overfitting check. If nothing was validated, say plainly that
the autopilot will not trade crypto until something is. Always include the disclaimer line.

## Never

- Never present a backtest as a prediction or guarantee, and never cherry-pick parameters until
  the numbers look good without telling the user — the lab's walk-forward exists for exactly this;
  quote out-of-sample numbers, not training ones.
- Never place orders or call a broker/exchange trading API.
