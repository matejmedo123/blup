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
bar's low. Rules fixed on the first 5 weeks (train), judged on the last 3½ (test). The candles are cleaned
first (`clamp_to_volume`): pump.fun's candles carry broken prints — a dust trade at a price 1,000× off, an
open from the curve's first minute — and in a constant-product pool a bar can only move the price as far as
its own volume pushes the reserve; anything outside that is pulled back. 86 % of the corrections are within
±5 % (SOL-price noise); the rest are the broken prints. It barely moved the result (−€345 raw, −€339 clean).
SOL's price is each Kraken bar's open, known when the bar starts (an earlier version used the close of the
bar still running — up to a day ahead; fixing it moved the totals by a few euros).

3,366 coins, 22 Aug – 21 Oct 2026 (`results/history_report.txt`):

| €10 a trade, €100 cap | Trades | Won | Mean per trade | Total € | 90 % range (by day) | Ended in a rug |
|---|---|---|---|---|---|---|
| **The sniper as configured** | 137 | 25 % | −25 % | **−€339** | −€460 … −€223 | 32 % |
| — last 3½ weeks only (test) | 34 | 29 % | −9 % | −€29 | −€75 … +€26 | 6 % |
| — momentum / breakout / pullback | 111 / 17 / 9 | | −23 % / −38 % / −25 % | | | |
| Stops filled exactly at the stop (best case) | 140 | 38 % | 0 % | −€6 | −€65 … +€54 | 33 % |
| Without coins whose curve filled in < 10 min (bundled launches — a stand-in for the holder checks) | 39 | 26 % | −3 % | −€12 | −€44 … +€19 | 3 % |
| Buying every coin 10 min after launch | 864 | 10 % | −19 % | −€1,594 | | 15 % |

Only one week of ten ended ahead (+€17). The pattern behind most losses: flat bot volume, a stair-step pump
that looks like momentum, then one −99.9 % candle. 78 % of graduated coins filled their curve in under ten
minutes — bundled launches where insiders hold the supply.

The sample is ~40 of the ~1,500 graduations a day. The real bot would see far more candidates and run into
its 20-trades-a-day and €30-a-day caps; at about −€2.50 a trade that is a bot that loses its daily limit on
most days.

## The moonbag ladder — after graduation, half at every 2×, the rest rides free (`moonbag.py`)

The idea: watch a coin after it graduates to PumpSwap; if it holds up, buy €10; at 2× sell half (the stake is
back), at 4× half of the rest, at 8× half again … never sell the last part, and move on to the next coin. The
same graduated coins (2,087 with a SOL pool), their whole life since — 5-minute candles for the first 80 h,
hourly ones after (up to 60 days) — cleaned as above, the sniper's $25k liquidity floor, decided on a closed
bar and filled at the next bar's open, fees, price impact, network fees (`results/moonbag_report.txt`).

The plain idea was fixed before looking: wait 30 min, buy only if the price is still at or above where it
graduated and never fell under half of it, half at every doubling, no stop, keep the rest.

| €10 a trade | Trades | Won | Reached 2× | Mean per trade | Wallet: €100 → |
|---|---|---|---|---|---|
| **The plain idea**, first 5 weeks | 245 | 19 % | 31 % | −€6.05 | €4.94 after 22 buys (short of €10 on day 2) |
| **The plain idea**, last 3½ weeks | 111 | 27 % | 27 % | −€4.51 | €1.63 after 13 buys |
| Best of 128 variants on the first 5 weeks (wait 30 min, half at 1.5×, stop −50 %, out after 24 h without a sale) | 250 | 16 % | 51 % | −€4.11 | €7.09 |
| — the same on the last 3½ weeks | 118 | 18 % | 38 % | −€3.58 | €9.81 after 32 buys |

**0 of 128 variants** (wait 5 / 15 / 30 / 60 min, with or without the hold-up check, with or without bundled
launches, half at 1.5× or 2×, stop −50 % or none, out after 24 h or keep) were ahead on either period.
Of the coins the plain idea buys, 32 % ever reach 2×, 2 % reach 10×, none 100×. The arithmetic: selling half
at 2× only gets the €10 back on the third that get there; the other two thirds lose most of their €10. To
break even, the half kept from each coin that doubled would have to bring in about €18–20 more on average;
what was left of them at the end was worth a few cents each (the best single trades: +€51, +€41, +€34). The
moonbags that do moon are too rare to pay for the rest.

## A partial profit at +20 % or more, the rest kept (`partial.py`)

The user's next idea: take part of the profit early (+20 %, +30 % or +50 %; sell 50 or 75 %), keep the rest
in case the coin explodes. 216 variants (wait 5 / 30 / 60 min, with or without the hold-up check, stop −20 / −30 %
before the sale, the rest with a stop at entry, a 50 % trailing stop, or kept for good), same data and fills as
above (`results/partial_report.txt`): **0 of 216 ahead** on either period; the best lost €1.4–2.9 a €10 trade.
70 % of these coins do reach +20 % first — but selling 75 % at +20 % only brings back €9 of the €10, so the trade
lives on what is kept, and what is kept is usually rugged between two candles (0.3× or 0.003× at the next open).

## Also tested on 22–23 Oct (scratch studies, results only)

- **Buy right after graduation, sell all at +30 %** — the first PumpSwap bar after the migration, $10k floor,
  1,215 coins: 42–49 % reach the target, −€1.56 to −€2.36 a €10 trade; 24–47 % of the trades lose over 90 %
  in one candle, and one of those wipes out two or three winners.
- **What the big winners had in common** — 3× or 10× OUR entry price within 7 days, normal 50–100 SOL
  graduations only: bought at graduation, 12–16 % reach 3× and 1–2.5 % reach 10×; bought 30 minutes later,
  6–7 % and ~1 %. Two connections hold on both periods (3×, 30 minutes in): a slower curve, not a bundled
  launch (10–12 % against 4–6 %), and steady volume rather than one burst (10–15 % against ~0 %). They
  double the odds of 3× and still leave ~88 % of the picks short of it — as trading rules they lost (below).

- **Which coins win, known at graduation** — ~45 features (curve speed, volume path, run-up and drawdown so
  far, hour and weekday, how many coins graduated in the last hour, SOL's move, pump.fun metadata: socials,
  description, the creator's earlier launches) on 2,792 graduations, 4,171 one- and two-condition rules and 32
  small models, all chosen inside time-blocked cross-validation: nothing lifted the +50 %-before-−30 % rate to
  the 56–60 % that pays; the search itself lost €1.7–2.5 a trade out of sample. One-candle −90 % dumps are
  somewhat predictable (AUC 0.68–0.78) — but the coins least likely to dump also rise least. 91–95 % of the
  coins that clear the $25k floor filled their curve in under 6 seconds (bundled launches).
- **Survivors** — coins still trading 1–7 days after graduation, with trend, dip, breakout and hold rules on
  hourly bars, 664 variants: the 3 frozen on the first period lost €3.8–3.9 a trade on the second (one rule
  was +€0.27 and turned negative with fills an hour later). Two "established" pools with ~$200k of liquidity
  went to zero during the test.
- **Following "smart" wallets** — 789,523 trades from 228,555 wallets in the first 30 minutes after
  graduation of 1,787 coins. The 57 wallets that bought early and often are graduation snipers and scalpers
  (three quarters of their buys in the first minute, a median round trip of 1.02× before costs), and their
  scores are no better than shuffled outcomes give. The 3 lists frozen on the first period lost €2.93–5.43 a
  €10 trade on the second; their buys came with a lower +50 %-first rate (28–30 %) than no signal at all.
- **Speed alone, as an outsider** — 1,984 new coins (all launches, not just graduates), 167,229 trades from
  their first 10 minutes: buying in the next slot, 2 slots, 5 s, 10 s, 30 s or 60 s after the create loses
  7–9 % a trade after pump.fun's 1.25 % fee per side (measured on chain) and a 0.001 SOL tip; the typical coin
  doesn't move (median −7.2 % = costs), and even a perfect exit within 5 minutes is negative at a 0.005 SOL
  tip. 87 % of launches have a dev buy inside the create transaction; 31 % also have other wallets in the
  creation slot, taking a median 17 % of the supply. Slot-level speed needs a paid Geyser / ShredStream feed
  and Jito — and the delays it would unlock lose the same.
- **ChatGPT's swing playbook** (7+ days old, $250k volume, breakout-retest / pullback / recovery on 4 h bars,
  +2R partial, trailing stop), 90 eligible Solana memes from CoinGecko's category (27 % dead today):
  −0.32R a trade on the first period, −0.30R on the second; the one positive variant lives on a single
  10× trade and turns negative with +1 % slippage.
- **ChatGPT's scalping and intraday plans** (1-min breakout-retest / pullback, 15-5-1-min breakout /
  pullback / flag, half at +1R or +1.5R, the rest on a trail; −3R day stop, 3 losses in a row stop) on two
  universes: pump.fun graduates in their first 80 h, from 2.5 M ticks (fills ≥ 2 s after the bar, pump.fun
  fee measured on the fills: median 0.52 % a side), and 10 big Solana meme pools (TRUMP, PENGU, WIF, FARTCOIN,
  POPCAT, PNUT, MEW, BOME, GOAT, MOODENG) on 1-min bars. As written the rules almost never fire (0 trades on
  the graduates). 48 combinations of the strict and a looser set, none positive on the first period; the 5
  frozen ones on the second: −0.66R a trade scalping (n = 83) and −0.63R intraday (n = 28) on the big pools,
  6–7 % winners, €100 → €89.85 in 25 days. The graduates gave 16 trades in two months — too few to judge;
  the one positive cell (5 trades) lives on a single +35 % minute and turns negative at +1 % slippage. Why: a
  median stop of 0.77 % against ~1.1 % of round-trip costs at €10, and entries that drift −0.4 % before costs.
- **What others found** — no published strategy that pays a retail buyer on new meme coins: 74 % of Solana
  meme-coin buyers lose money while sandwich bots win every week (Bitquery); insiders take ~80 % of realized
  profit (memescope); the snipers that do win are funded by the deployers and buy in the creation block (Pine
  Analytics, 87 % of their snipes profitable); copying "smart" wallets two minutes late lost 41 % a token
  (TokenPost); an open-source paper bot found none of 15 strategies beat holding after costs; a backtested
  dev-reputation filter lost money live (Scorp Labs).

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
python3 moonbag.py fetch    # ~15 min: hourly candles for the graduated coins (their life after 80 h)
sh reproduce.sh backtest    # offline: the reports into results/ (moonbag.py too)
python3 partial.py          # offline: the +20 % partial study
sh reproduce.sh collect     # ~6 h: today's new pools, forward
```
Stdlib only. Downloads go to `data/` (not in git). `tests/test_sniper_research.py` keeps the replay running
on the sniper's current rules.
