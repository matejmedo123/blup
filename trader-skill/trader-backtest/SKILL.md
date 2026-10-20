---
name: trader-backtest
description: Backtester for day-trading setups on US stocks, crypto and DEX meme coins. Replays one setup rule (opening-range breakout, gap-and-go, VWAP reclaim, bull flag, Asia/US-open range breakout, momentum) over the last N sessions or days with the exit planner's stop/target/time stop, fees and slippage — "Last 59 sessions: 33 triggers, 13 hit target, 15 hit stop, 5 neither." Use when the user asks "does this setup work?", "backtest the ORB on TSLA", "how often does the Asia-range breakout hit target on BTC?", "validate this setup before I trade it", "what's the hit rate?".
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

## Reads / writes (in `trader/`)

- reads `config.json` (costs, horizons), `limits.json` (meme default size)
- writes `backtests/<symbol_key>-<setup>.json` (stats + every trade) and
  `reports/backtest-<symbol_key>-<setup>.html` (cumulative R chart, outcome table, trades)

## How to present results

Quote the summary sentence exactly ("Last 59 sessions: 33 triggers, 13 hit target, 15 hit stop,
5 neither.") then win rate, average net R and max drawdown, and the cost assumptions. Flag thin
samples plainly. Past hit rates are not a promise — say so. Suggest `/trader-timemachine` next.
Always include the disclaimer line.

## Never

- Never present a backtest as a prediction or guarantee, and never cherry-pick parameters until
  the numbers look good without telling the user.
- Never place orders or call a broker/exchange trading API.
