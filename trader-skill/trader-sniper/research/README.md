# The sniper study — does it make money? (22 Oct 2026)

**Short answer: no edge was found.** The sniper's own rules, replayed on two months of pump.fun history and
on one day of new pools, lost money after costs; its first live paper day lost on all three trades. That is
why live trading now waits for the sniper's own paper record to pay (`sniper.live_needs_paper_proof`).

## Historical replay — the sniper's real rules on 61 days of Solana history

`history.py` lists every PumpSwap migration (graduation) of the last 62 days from the Solana chain itself and
samples them evenly in time — 40 graduated coins and 20 bonding-curve coins a day, **dead and rugged coins
included** (no survivorship). `replay.py` imports `trader-sniper/sniper.py` and lets its own `prefilter`,
`signal`, `MIN_STOP_PCT` and `budget_refusal` decide, with the exits of `manage()`, on 5-minute candles:
€10 a trade, at most €100 open, 10 positions, 20 trades a day, €30 daily loss, costs (PumpSwap / pump.fun
fee, price impact from the pool's own reserves, network fee). Buys fill at the next bar's open, stops at the
bar's low. Rules fixed on the first 5 weeks (train), judged on the last 3½ (test).

3,366 coins, 22 Aug – 21 Oct 2026 (`results/history_report.txt`):

| €10 a trade, €100 cap | Trades | Won | Mean per trade | Total € | 90 % range (by day) | Ended in a rug |
|---|---|---|---|---|---|---|
| **The sniper as configured** | 136 | 26 % | −25 % | **−€345** | −€467 … −€224 | 34 % |
| — last 3½ weeks only (test) | 33 | 30 % | −10 % | −€34 | −€81 … +€26 | 9 % |
| — momentum / breakout / pullback | 111 / 17 / 8 | | −24 % / −35 % / −24 % | | | |
| Stops filled exactly at the stop (best case) | 139 | 40 % | +0.3 % | +€4 | −€58 … +€67 | 35 % |
| Without coins whose curve filled in < 10 min (bundled launches — a stand-in for the holder checks) | 37 | 30 % | −4 % | −€13 | −€49 … +€24 | 5 % |
| Buying every coin 10 min after launch | 843 | 10 % | −20 % | −€1,681 | | 15 % |

Only one week of ten ended ahead (+€10). The pattern behind most losses: flat bot volume, a stair-step pump
that looks like momentum, then one −99.9 % candle. 78 % of graduated coins filled their curve in under ten
minutes — bundled launches where insiders hold the supply.

The sample is ~40 of the ~1,500 graduations a day. The real bot would see far more candidates and run into
its 20-trades-a-day and €30-a-day caps; at about −€2.50 a trade that is a bot that loses its daily limit on
most days.

## One day forward — 22 Oct 2026 (`results/forward_report.txt`)

2,460 pools created on Solana (pump.fun curve and PumpSwap), BSC and Base, followed for at least 4 hours:
buying every one under the €100 budget lost 77 % on average (−€1,077); a launch-momentum rule (chosen on the
first half of the day) broke even under the budget (66 trades, −€0.06); breakout and pullback fired too rarely
to judge.

## The real sniper on paper, live data — 22 Oct 2026, 13:15–17:30 CEST

3 trades, all momentum, all lost: −$17.51. Two of the three were rugged minutes after a +60 % run (the pool
went from $46k to $3k and from $29k to $2k); selling half at +60 % saved the first one.

## What a replay can't see

RugCheck, holder concentration, mint/freeze authority and LP state at the time (assumed to pass — the
replay takes trades the real sniper would refuse); trade counts and trades per wallet (not in candles);
X posts; MEV sandwiches (+1 % a side: slightly worse); failed transactions and latency (one bar later:
slightly worse); the sniper polls every 45 s, the replay steps 5 minutes. BSC and Base have no unbiased
history in free sources (four.meme's API is geo-blocked, GeckoTerminal can't list old pools by creation).

## Re-run

```bash
sh reproduce.sh history     # ~2 h: the last 62 days from the Solana public RPC + pump.fun candles
sh reproduce.sh backtest    # offline: both reports into results/
sh reproduce.sh collect     # ~6 h: today's new pools, forward
```
Stdlib only. Downloads go to `data/` (not in git). `tests/test_sniper_research.py` keeps the replay running
on the sniper's current rules.
