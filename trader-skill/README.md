# Trader — a day-trading skill pack for Claude Code

Twelve Claude Code skills for **intraday trading** across three asset classes, sharing one
data layer and one state folder:

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
* **Copy the folders** — include `shared/`, every skill imports it from the folder next to it:
  ```bash
  cp -r trader-* shared ~/.claude/skills/
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
```

WALKTHROUGHS_PLACEHOLDER

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
python3 -m unittest                 # all tests, no network (fixtures only)
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
* **Not an execution system.** Tickets need your explicit "yes", and the connector call is made by
  Claude through your brokerage's MCP server. Bracket orders exist for stocks on Alpaca but not
  for crypto — the crypto stop is a separate order after the fill.

## Repo layout

```
trader-skill/
  README.md  LICENSE  .claude-plugin/{plugin.json, marketplace.json, icon.png}
  trader-scanner/ trader-news/ trader-entry/ trader-exit/ trader-timemachine/ trader-risk/
  trader-sizer/ trader-alerts/ trader-broker/ trader-journal/ trader-backtest/ trader-rugcheck/
  shared/        data.py (get_candles / get_quote), sources/*, symbols.py, market_clock.py,
                 setups.py, trade_sim.py, indicators.py, cache.py, http.py, offline.py, html.py, cli.py
  tests/         test_*.py, fixtures/ (make_fixtures.py regenerates them)
  docs/SCHEMAS.md  every trader/ state file, field by field
  scripts/demo.sh  the walkthroughs, offline
```

## License

MIT — see [LICENSE](LICENSE).
