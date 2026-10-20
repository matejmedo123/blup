# Trader — a day-trading skill pack for Claude Code

Twelve Claude Code skills for **intraday trading** across three asset classes, sharing one
data layer and one state folder — plus two add-ons: a four-role AI trading desk and a read-only
arbitrage gap monitor:

| Asset class | Examples | Market clock |
|---|---|---|
| **US stocks** | `TSLA`, `NVDA`, `BRK.B` | NYSE regular session 9:30–16:00 ET, 2026–2027 holidays and 1:00 p.m. early closes |
| **Crypto (CEX)** | `BTCUSDT`, `BTC-USD`, `ETH/USDT`, `SOL` | 24/7; a "session" is the UTC day or your horizon (1h / 4h / 24h) |
| **Meme coins (DEX)** | `SOL:<mint>`, `base:0x…`, a bare Solana mint | 24/7, extreme volatility, rug-pull risk |

The asset class is detected from the symbol, or set with `--asset stock|crypto|meme`.

The skills scan thousands of charts, watch the news, time entries and exits, size and
risk-check every trade, and — the headline feature — **replay the rest of the trade 10,000 times
before a single dollar is risked** (the Time Machine).

> **Educational tool, not financial advice.** Quotes from free public sources may be delayed or
> wrong. **Meme coins:** most go to zero, liquidity can vanish in seconds and volume can be faked —
> only risk what you can afford to lose entirely.

## What it never does

1. **Never places an order by itself.** Paper trading is the default. A ticket is only handed to a
   brokerage MCP connector (e.g. Alpaca's official MCP server — paper account by default) after you
   type an explicit **yes** for that exact ticket; your reply is recorded verbatim in
   `trader/approvals.jsonl`. No skill calls a broker or exchange trading API.
2. **Never touches wallets or keys.** No private keys, seed phrases, signing or DEX swaps. For meme
   coins it prepares a plan and a manual checklist; you execute in your own wallet.
3. **No paid APIs, no API keys, no sign-up, nothing to `pip install`.** Python 3.8+ standard library only.
4. **Free public data, used politely** — cached, rate-limited per host, back-off on HTTP 429,
   automatic fallback to the next source (and a note when that happens).

## Install

Pick one:

* **Paste the repo URL into Claude** and say "install skill".
* **Plugin marketplace:**
  ```
  /plugin marketplace add <owner>/trader-skill
  /plugin install trader-skill@trader-skill
  ```
  Skills then show up as `/trader-scanner` … (or namespaced, `/trader-skill:trader-scanner`).
* **Copy the folders** — include `shared/`, every skill imports it from the folder next to it, and
  copy the desk's three subagents:
  ```bash
  cp -r trader-* shared ~/.claude/skills/
  mkdir -p ~/.claude/agents && cp agents/*.md ~/.claude/agents/
  ```

Requirements: Python 3.8 or newer (`python3 --version`). Nothing else.

## Configure

The first run creates `trader/config.json` and `trader/limits.json` in your project (override the
folder with `TRADER_HOME`). Edit them:

```json
{
  "sec_user_agent": "Jane Doe jane@example.org",
  "account_size": 25000,
  "risk_per_trade_pct": 0.5,
  "watchlists": {"stocks": ["TSLA", "NVDA"], "crypto": ["BTCUSDT", "ETHUSDT"], "meme": ["SOL:<mint>"]},
  "meme_chains": ["solana", "base"],
  "quote_currency": "USDT",
  "crypto_horizon": "4h",
  "paper": true
}
```

* `sec_user_agent` — SEC EDGAR asks for a real name + e-mail (or set `SEC_USER_AGENT`). Without it the
  8-K feed is skipped with a note.
* `limits.json` — separate limits per asset class: max $ risk per trade, max daily loss, max open
  positions, max position % of account, total exposure caps for crypto and meme coins (meme default
  5 % of the account), blocked symbols, shorts/margin/leverage/options switches, meme minimum
  liquidity, maximum slippage, % of pool, and which rugcheck verdicts are acceptable.

## The 12 skills

| # | Command | Job |
|---|---|---|
| 1 | `/trader-scanner` | Scans a universe on 5-min candles and ranks setups into `trader/setups.json` — stocks: ~5,000 US tickers (opening-range breakout 15/30, VWAP reclaim, gap-and-go, bull flag, high relative volume); crypto: top coins by volume (Asia / US-open / UTC-day range breakouts, VWAP reclaim, volume spikes, funding extremes, breakouts with rising open interest); meme: DexScreener boosted + new pairs (volume and buy-pressure spikes, momentum breakouts, first-hour launches) — every meme hit is run through rugcheck and hidden if it fails |
| 2 | `/trader-news` | Only what is new since the last check, newest first, with why it matters — headlines + SEC 8-K filings, crypto news (listings, ETF flows, hacks, unlocks, regulation), meme token profile/boost/liquidity changes |
| 3 | `/trader-entry` | Watches a setup candle by candle and says exactly when to get in ("Status: Watching → TRIGGERED — the 10:10 candle just closed above the opening range. Get in $364.18.") — with a liquidity and slippage check for meme coins |
| 4 | `/trader-exit` | Stop (structure or ATR), R-multiple target, time stop (stocks flat by 3:55 p.m. ET; crypto/meme your horizon), optional trailing stop; meme scale-outs and a liquidity exit |
| 5 | `/trader-timemachine` ⭐ | Replays the rest of the session 10,000 times from the symbol's own candles and shows the odds of target vs stop, expected value, the 90 % close range, a histogram and a fan chart |
| 6 | `/trader-risk` | PASS or BLOCK against `limits.json`, with the reason. A meme coin that has not passed rugcheck is always blocked |
| 7 | `/trader-sizer` | Size = (account × risk %) ÷ (entry − stop), capped by position %; shares, exchange lot sizes, or a USD amount capped by pool liquidity |
| 8 | `/trader-alerts` | Rings once on price levels, stops/targets, % moves, the opening bell; meme: liquidity pulled, dev wallet selling, holder concentration jump — built for `/loop` or a scheduled task |
| 9 | `/trader-broker` | Turns a risk-PASSED order into a plain ticket + the exact JSON for the brokerage MCP connector, waits for your "yes"; meme coins get a manual wallet checklist |
| 10 | `/trader-journal` | Logs every trade and computes win rate, average R, expectancy, best/worst setups — overall and per asset class |
| 11 | `/trader-backtest` | Runs a setup rule over the last N sessions/days with fees and slippage: "Last 59 sessions: 33 triggers, 13 hit target, 15 hit stop, 5 neither." |
| 12 | `/trader-rugcheck` 🛡️ | Safety gate for meme coins: liquidity, LP lock/burn, mint/freeze authority, honeypot/taxes, holder concentration, dev share, age, buy/sell ratio, fake-volume hints → score 0–100 and SAFE / RISKY / DANGER with reasons. It never says a token is safe to buy — only "no red flags found in these checks" |

Every tool has `--help`, takes `--asset`, prints a compact text summary, writes JSON state to
`trader/`, and — when there is a chart — a self-contained HTML report to `trader/reports/`
(inline SVG, light theme, works on a phone, no CDN). Add `--json` for machine output, `--open`
to open the report.

## Workflows

```
stocks / crypto:  scanner → news → entry → exit → timemachine → sizer → risk → broker → journal
meme coins:       scanner → rugcheck → news → entry → exit → timemachine → sizer → risk → manual checklist → journal
alerts / news:    stocks during market hours; crypto & meme 24/7 on a schedule (/loop 5m …)
validate first:   backtest → timemachine
second opinion:   /trader-desk  (Researcher → Skeptic → Lead → Trader, each checking the others)
```

## Walkthroughs (real output of `bash scripts/demo.sh`, offline fixtures)

The demo runs everything below on synthetic fixtures with a pinned clock (`--offline --now …`).
Output is trimmed; every tool also prints the disclaimer and writes an HTML report
(`demo/trader/reports/index.html` lists them all).

### 1 · TSLA opening-range breakout

```text
$ python3 trader-scanner/scan.py --asset stock --offline --now 2026-10-20T14:15:00Z
6 of 30 US stocks scanned, 13 setups
  1. TSLA  TRIGGERED  Opening-range breakout (15 min)  $364.18 · 5-min close above opening range high $362.18 (9:30–9:45 ET) · 10:10 ET · relvol 2.8× · flags: high_relvol · score 85
  2. NVDA  TRIGGERED  Opening-range breakout (30 min)  $194.90 · …
  5. AMD   TRIGGERED  VWAP reclaim                     $240.31 · 5-min close back above VWAP ($238.87) after 5 closes below   ← served by Stooq: Yahoo had no data

$ python3 trader-news/news.py --symbols TSLA …
TSLA — 5 new since last check
  [!!!] 9:05 ET  Tesla–SpaceX merger mania strikes Wall Street ahead of earnings — Yahoo Finance (also: Google News) — merger + earnings: expect a volatile open
  [!! ] 7:31 ET  8-K filed: Regulation FD disclosure (often guidance or investor deck) — SEC EDGAR — guidance: official filing — read it before trading

$ python3 trader-entry/entry.py --id TSLA-20261020-orb15 …      (at 10:05, then at 10:15)
Opening range high $362.18 (9:30–9:45 ET). Rule: 5-min close above.
Status: WATCHING — waiting for a 5-min close above $362.18
Status: Watching → TRIGGERED — the 10:10 candle just closed above the opening range. Get in $364.18.

$ python3 trader-exit/exit.py --id TSLA-20261020-orb15 …
Get in $364.18 · Stop $358.32 · Target $375.90 (2R) · Time stop 3:55 p.m. ET
Stop: below the opening range low ($5.86 risk per share = 3.4× ATR).

$ python3 trader-backtest/backtest.py TSLA --setup orb15 …
Last 59 sessions: 33 triggers, 6 hit target, 17 hit stop, 10 neither.
Win rate 39% · avg -0.12R net per trade · total -3.89R · max drawdown -7.37R

$ python3 trader-timemachine/replay.py --id TSLA-20261020-orb15 --seed 7 …
10,000 replays (seed 7) from 60 sessions of 5-min candles (Yahoo Finance)
  Target first   24.3%  ███████
  Stop first     55.7%  █████████████████
  Neither        20.0%  ██████
Expected value  +0.02R  (≈ +$2.00 on 17 shares)
9 in 10 close between $346.60 and $383.29 · median $364.17
Backtest: 18% target / 52% stop / 30% neither over 33 triggers

$ python3 trader-sizer/size.py --id TSLA-20261020-orb15 …
BUY 17 TSLA ≈ $6,191 · risk $99.62 (0.40% of account) · limit $364.20 · capped by max position 25%

$ python3 trader-risk/risk.py …
PASS ✓  all 12 checks passed

$ python3 trader-broker/ticket.py prepare …
  BUY 17 TSLA, limit $364.20, stop $358.32, day — PAPER
Reply yes to send this exact ticket to the PAPER account.
$ python3 trader-broker/ticket.py approve --ticket tkt-ord-TSLA-20261020-141500 --reply "yes"
APPROVED — hand this payload unchanged to the alpaca MCP tool place_stock_order:
{"symbol": "TSLA", "side": "buy", "quantity": 17, "order_type": "limit", "limit_price": 364.2, "time_in_force": "day",
 "order_class": "bracket", "take_profit_limit_price": 375.9, "stop_loss_stop_price": 358.32, …}
Recorded the reply 'yes' in trader/approvals.jsonl. This approval covers this one ticket only.

$ python3 trader-journal/journal.py add --plan TSLA-20261020-orb15 --auto --now 2026-10-20T20:05:00Z …
JOURNAL — CLOSED TSLA orb15 · $364.18 → $375.90 (target) · +2.00R · P&L $196.72 (fees $0.00, slippage $2.52)
```

Note what the Time Machine and the backtest said *before* the trade: stop-first was more likely than
target-first, and the rule had lost money on TSLA over 59 sessions. That this paper trade hit the target is
one outcome, not proof of an edge.

### 2 · BTC/USD breakout of the Asia range at the US open, rising open interest, 4h horizon

```text
$ python3 trader-scanner/scan.py --asset crypto --offline --now 2026-10-20T14:40:00Z
4 of 7 coins scanned (top 30 by volume via CoinGecko), 10 setups
  1. BTC/USDT  TRIGGERED  Asia-range breakout  $67,448.60 · 5-min close above Asia range high $67,420.00 (00:00–08:00 UTC) · 14:35 UTC · vol 4.0× · flags: volume_spike, rising_oi · score 92

$ python3 trader-entry/entry.py BTC-USD --setup asia_range …
Status: Watching → TRIGGERED — the 14:35 UTC candle just closed above the Asia range. Get in $67,448.60.

$ python3 trader-exit/exit.py --id BTCUSD-20261020-asia_range --horizon 4h …
Get in $67,448.60 · Stop $67,320.53 · Target $67,704.74 (2R) · Time stop 18:40 UTC (4h horizon)
Stop: just below the breakout level (1×ATR) — the structure low $66,612.40 is more than 4×ATR away.

$ python3 trader-timemachine/replay.py --id BTCUSD-20261020-asia_range --seed 7 …
10,000 replays (seed 7) from 29.6 days of 5-min candles (Binance)
  Target first   33.2%  ██████████
  Stop first     66.8%  ████████████████████
Expected value  -0.00R  ·  9 in 10 close between $66,424.30 and $68,498.20

$ python3 trader-sizer/size.py …   →   BUY 0.05559 BTC/USD ≈ $3,749 · limit $67,462.09 · capped by max position 15%
$ python3 trader-risk/risk.py …    →   PASS ✓  all 13 checks passed
$ python3 trader-broker/ticket.py prepare …
  BUY 0.05559 BTC/USD, limit $67,462.09, gtc — PAPER
  stop $67,320.53 — place it as a separate stop order after the fill (crypto has no bracket orders on Alpaca)
```

On the live network the same command chain works unchanged: `api.binance.com` answered HTTP 451 from
this machine, so the data layer used `data-api.binance.vision`, and Binance futures data came from OKX.

### 3 · A Solana meme coin from DexScreener — one passes, one is BLOCKED

```text
$ python3 trader-scanner/scan.py --asset meme --offline --now 2026-10-20T15:55:00Z
3 meme tokens scanned (DexScreener boosted + new tokens on solana, base), 2 setups shown, 1 hidden by rugcheck
  1. PUPKIN  TRIGGERED  Momentum breakout  $0.004712 · 5-min close above the 12-bar high $0.004424 on 4.0× volume · liq $412.4k · rugcheck SAFE 95
  2. NEWT    FLAG       First-hour launch  Launched 35 min ago with $38.5k liquidity · rugcheck RISKY 55
  hidden: MLAMBO (solana) — rugcheck DANGER: LP not locked or burned (0% locked) — the deployer can pull liquidity; Top holder owns 40.0% of supply; …

$ python3 trader-rugcheck/rugcheck.py SOL:<PUPKIN> …
Verdict: SAFE — No red flags found in these checks (not a guarantee)   Score 95/100
  ✓ Pool liquidity $412.4k   ✓ Mint authority revoked   ✓ Freeze authority revoked   ✓ LP 100% locked/burned   ✓ Top-10 17.8%

$ python3 trader-rugcheck/rugcheck.py SOL:<MLAMBO> …
Verdict: DANGER — Serious red flags — do not trade this   Score 0/100
  ✗ LP locked or burned      0% locked/burned (-30)
  ✗ Largest single holder    40.0% (-30)
  ✗ Top-10 holder share      54.7% (-30)

$ python3 trader-risk/risk.py --symbol SOL:<MLAMBO> --notional 100 --entry 0.000918 --stop 0.00078 …
BLOCK ✗ — rugcheck DANGER (score 0): LP not locked or burned (0% locked) — the deployer can pull liquidity; Top holder owns 40.0% of supply; …

$ python3 trader-exit/exit.py …
Get in $0.004712 · Stop $0.004348 · Target $0.005804 (3R) · Time stop 19:55 UTC (4h horizon)
Scale-out: sell 50% at 2× — recovers the initial stake ($0.009424) (beyond the target — only if you let a runner go).
Liquidity exit: get out if pool liquidity drops 30% (below $288.6k).

$ python3 trader-timemachine/replay.py --seed 7 …
10,000 replays (seed 7) from 2.5 days of 5-min candles (GeckoTerminal)
  Target first 1.1% · Stop first 20.9% · Neither 77.0% · Rug pull 0.9%
Expected value -0.16R (≈ -$6.14 on a $500 position)
  ! thin sample: only 2.5 days of history — volatility widened ×1.25

$ python3 trader-sizer/size.py …   →   BUY $500.00 of PUPKIN · est. slippage 0.24% · 0.12% of pool · capped by max position 2%
$ python3 trader-risk/risk.py …    →   PASS ✓  all 17 checks passed (rugcheck SAFE, score 95, 0 min old)
$ python3 trader-broker/ticket.py prepare …
  MANUAL SWAP — BUY $500.00 of PUPKIN on solana (you execute it in your own wallet)
  [ ] Token contract address: Fk6KsBpN…pump      [ ] Max slippage: 3.0% (estimated impact 0.24%)
  [ ] Verify on DexScreener / Solscan / rugcheck.xyz   [ ] Compare the address character by character from two sources
  [ ] Use a wallet that holds only this trade's amount; never sign an unlimited approval
  [ ] A DEX has no stop orders: set /trader-alerts for the stop, the target and a liquidity drop
  [ ] Never paste your seed phrase or private key anywhere — this pack never asks for them.
```

## Add-ons

### `/trader-desk` — a team of four that checks its own work

| Role | Who | Job |
|---|---|---|
| Researcher | subagent `agents/trader-researcher.md` | the sourced case: setup, entry, news, 8-K filings, rugcheck |
| Skeptic | subagent `agents/trader-skeptic.md` | tries to prove it wrong — backtest, Time Machine, liquidity, event risk → `O1 [critical] …` |
| Lead | subagent `agents/trader-lead.md` | answers every objection (rebutted / mitigated / accepted), decides GO / NO-GO / WAIT |
| Trader | the main conversation | only on a verified GO: sizer → risk → broker ticket → **your** "yes" |

`desk.py verify` refuses a GO with an unanswered objection, an accepted critical objection, a failed hard
gate (exit plan, fresh rugcheck for meme coins, a Time Machine run on the current plan with EV ≥ minimum),
or a replay made before the plan changed. From the demo (canned memos standing in for the subagents):

```text
$ python3 trader-desk/desk.py verify --id TSLA-20261020-orb15 …
Status: NO-GO — The Trader stands down, no money moves.
  O1 [critical] Earnings land tomorrow after the close … → Lead: mitigated
  O2 [major] This rule lost money on TSLA: backtest expectancy is negative after costs → Lead: accepted
  O3 [major] Time Machine: stop first is about twice as likely as target → Lead: accepted
  ✗ backtest expectancy   Last 59 sessions: 33 triggers, 6 hit target, 17 hit stop, 10 neither. · expectancy -0.12R after costs (soft)
```

X/Twitter is not part of the Researcher's sources — its API is not free.

### `/trader-arb` — arbitrage gap monitor (read-only)

Compares the same meme token across its DEX pools, or the same coin across Binance / Coinbase / Kraken
(USDT converted to USD), and subtracts both legs' fees, slippage at your size and network costs:

```text
$ python3 trader-arb/arb.py SOL:<PUPKIN> BTCUSDT …
PUPKIN (solana) — 2 pools, size $500 per leg
  best route: buy meteora → sell raydium · gap +0.15% − costs 6.27% (fees 0.50% + slippage 5.76%) = net -6.12%
  Verdict: NO EDGE AFTER COSTS.
BTC/USDT — 3 venues, size $1,000 per leg
  best route: buy Kraken → sell Binance · gap +0.05% − costs 0.54% = net -0.49%
  Verdict: NO EDGE AFTER COSTS.
```

It never trades. Real arbitrage is a millisecond race won by bots co-located with exchanges and
validators (MEV searchers on Solana); free APIs lag by seconds to minutes. Viral "$1 → $400k arbitrage
bot" stories are survivorship bias at best, and bots that ask for your private key or a deposit are a
common scam.

## Data sources (all free, no keys)

| Data | Primary | Fallbacks |
|---|---|---|
| Stock candles & quotes | Yahoo Finance chart JSON | Stooq CSV |
| Stock universe | SEC `company_tickers_exchange.json` | Nasdaq Trader symbol directory |
| Stock news | Yahoo Finance RSS, Google News RSS | — |
| Filings | SEC EDGAR 8-K Atom feed (User-Agent with name + e-mail, ≤ 10 req/s) | — |
| Crypto candles & quotes | Binance public klines (`api.binance.com`) | `data-api.binance.vision` mirror → Coinbase Exchange → Kraken |
| Crypto universe | CoinGecko markets | Binance 24h tickers |
| Funding & open interest | Binance futures | OKX public swap data |
| Lot / tick sizes | Binance `exchangeInfo` | Coinbase product → built-in defaults |
| Crypto news | CoinDesk, Cointelegraph, The Block RSS | — |
| Meme pairs, boosts, new launches | DexScreener public API | — |
| Meme candles | GeckoTerminal pool OHLCV | the token's next-deepest pool |
| Meme safety | RugCheck (Solana), honeypot.is (Base, Ethereum, BSC) | — (verdict capped at RISKY if unavailable) |

`api.binance.com` and Binance futures answer HTTP 451 from some countries (including the US); the
data layer notices, stops asking, and moves on to the mirror / OKX automatically.

## Offline mode, tests and the demo

```bash
python3 -m unittest                 # 227 tests, no network (fixtures only), Python 3.8+
bash scripts/demo.sh                # the three walkthroughs below, end to end, offline
python3 trader-scanner/scan.py --asset stock --offline --now 2026-10-20T14:15:00Z
```

`--offline` serves every HTTP request from `tests/fixtures/http/` — synthetic data stored in each
API's raw response format, so offline runs exercise exactly the same parsing code as live runs.
`--now` (or `TRADER_NOW`) pins the clock.

## Known limits

* **Delayed, rate-limited, sometimes wrong data.** Free endpoints change without notice, throttle
  hard and can be geo-blocked. Yahoo keeps only ~60 calendar days of 5-minute bars (≈ 40 sessions),
  so live replays and backtests use ~40 sessions, not 60. Scanning all ~5,000 US stocks within a
  time budget means only part of the universe gets a full chart each run (a cheap bulk pre-filter
  picks which).
* **Simulation ≠ prediction.** The Time Machine resamples the symbol's own past 5-minute behaviour.
  It cannot know about news, halts, gaps or regime changes. Treat its odds as a sanity check on
  the stop/target geometry, not as a forecast.
* **Backtests are small samples.** 30–60 windows is not much; costs and slippage are estimates.
* **Meme-coin data can be manipulated.** Wash trading and fake volume are common, holder lists can
  hide insiders behind many wallets, LP locks can expire, and contracts can change. A clean rugcheck
  means "no red flags found in *these* checks", nothing more. Slippage estimates assume a
  constant-product pool.
* **The desk is only as good as its evidence.** Subagents can still be wrong together; the desk's
  checks are mechanical (every objection answered, hard gates passed), not a guarantee of judgement.
* **Not an execution system.** Tickets need your explicit "yes", and the connector call is made by
  Claude through your brokerage's MCP server. Bracket orders exist for stocks on Alpaca but not
  for crypto — the crypto stop is a separate order after the fill.

## Repo layout

```
trader-skill/
  README.md  LICENSE  .claude-plugin/{plugin.json, marketplace.json, icon.png}
  trader-scanner/ trader-news/ trader-entry/ trader-exit/ trader-timemachine/ trader-risk/
  trader-sizer/ trader-alerts/ trader-broker/ trader-journal/ trader-backtest/ trader-rugcheck/
  trader-desk/ trader-arb/        add-ons
  agents/        trader-researcher.md, trader-skeptic.md, trader-lead.md (the desk's subagents)
  shared/        data.py (get_candles / get_quote), sources/*, symbols.py, market_clock.py,
                 setups.py, trade_sim.py, indicators.py, cache.py, http.py, offline.py, html.py, cli.py
  tests/         test_*.py, fixtures/ (make_fixtures.py regenerates them)
  docs/SCHEMAS.md  every trader/ state file, field by field
  scripts/demo.sh  the walkthroughs, offline (scripts/demo.py does the work; Windows: python scripts/demo.py)
```

## License

MIT — see [LICENSE](LICENSE).
