# Trader — a day-trading toolkit for Claude Code

Day-trading skills for **US stocks, crypto and DEX meme coins**, one shared data layer, a
**web dashboard** that shows everything, an opt-in **24/7 autopilot** that picks its own stocks and
coins, reads the news and SEC filings before every trade, learns from its own record and trades for
you (simulator or paper by default), a four-role **AI trading desk** that has to agree before any
trade happens, and a **deploy kit** to run it all on a small server with phone notifications.

| Asset class | Examples | Market clock |
|---|---|---|
| **US stocks** | `TSLA`, `NVDA`, `BRK.B` | NYSE 9:30–16:00 ET, 2026–2027 holidays and 1:00 p.m. early closes |
| **Crypto (CEX)** | `BTCUSDT`, `BTC-USD`, `ETH/USDT`, `SOL` | 24/7; a "session" is the UTC day or your horizon (1h / 4h / 24h) |
| **Meme coins (DEX)** | `SOL:<mint>`, `base:0x…` | 24/7, extreme volatility, rug-pull risk — analysed, never auto-traded |

> **Educational tool, not financial advice.** Free data can be delayed or wrong. Most trading
> strategies have no edge after costs — including most of the setups in this pack on the demo data.
> **Meme coins:** most go to zero, liquidity can vanish in seconds and volume can be faked — only risk
> what you can afford to lose entirely.

## Quick start

Needs Python 3.8+ and nothing else.

```bash
python3 scripts/demo.py                                    # every walkthrough below, offline, ~25 s
python3 app/server.py --home demo/autopilot --offline      # the dashboard on the demo day → http://127.0.0.1:8765
python3 app/server.py --autopilot                          # for real: dashboard + autopilot in the local simulator
python3 trader-autopilot/autopilot.py daemon --approve     # or the 24/7 daemon on its own (deploy/ runs both on a VPS)
```

## What's in the box

| Command | What it does |
|---|---|
| `/trader-scanner` | Scans ~5,000 US stocks, the top coins or DexScreener's trending meme coins on 5-min candles and ranks setups (opening-range breakout, VWAP reclaim, gap-and-go, bull flag, relative volume, range breakouts, funding extremes, rising open interest, buy pressure, first-hour launches) |
| `/trader-news` | Only what's new, ranked by why it matters: Yahoo/Google headlines, **SEC 8-K filings**, CoinDesk/Cointelegraph/The Block, **X** (your token, daily budget) and **StockTwits** crowd mood — one deduplicated feed |
| `/trader-entry` | Watches a setup candle by candle: "Status: Watching → TRIGGERED — the 10:10 candle just closed above the opening range. Get in $364.18." |
| `/trader-exit` | Stop, R-multiple target, time stop, trailing stop; meme scale-outs and liquidity exit |
| `/trader-timemachine` ⭐ | Replays the rest of the session 10,000 times from the symbol's own candles: odds of target vs stop, expected value, 90 % close range, fan chart |
| `/trader-backtest` | "Last 59 sessions: 33 triggers, 6 hit target, 17 hit stop, 10 neither." — with fees and slippage |
| `/trader-desk` | Researcher → Skeptic → Lead: every objection must be answered; GO only through hard gates. AI subagents, a rule-based mode (`desk.py auto`, incl. a news & filings gate) or the optional Claude API desk (`ai_desk.py`, veto-only) |
| `/trader-sizer` · `/trader-risk` | Position size from account × risk %; PASS/BLOCK against `limits.json` (per asset class, daily loss, exposure, rugcheck) |
| `/trader-broker` | A plain ticket + the exact JSON for your brokerage MCP connector, sent only after you type **yes**; meme coins get a manual wallet checklist |
| `/trader-autopilot` | Trades for you **24/7**: picks its own universe (~40 liquid US stocks ranked by today's movement + the day's most active names, the 20 most traded coins), fetches the latest news and SEC filings before every trade, runs every gate, places orders through the **local simulator** (default) or **Alpaca** (paper; live only through an explicit opt-in), manages exits, journals fills, learns from its own record, notifies your phone, kill switch |
| `/trader-alerts` | Rings once on levels, stops/targets, % moves, the opening bell, liquidity pulled, dev selling |
| `/trader-journal` | Every trade with its chart; win rate, expectancy (net of costs), best/worst setups per asset class |
| `/trader-rugcheck` 🛡️ | Meme-coin safety gate: LP lock, mint/freeze authority, honeypot/taxes, holder concentration, dev share, age, fake-volume hints → SAFE / RISKY / DANGER |
| `/trader-arb` | Read-only arbitrage gap monitor — shows why visible gaps don't survive fees and slippage |
| **Dashboard** `app/server.py` | Equity, P&L today/total, positions, orders, every trade with its chart, the bot's decisions and reasons, is it alive (heartbeat), what it watches and why, what it learned, news & social feed, notifications, AI desk spend, reports, bot controls |
| **Deploy kit** `deploy/` | Docker Compose or systemd for a small VPS (daemon + dashboard as two services), HTTPS via Caddy, step-by-step guide in Slovak |

## Safety model

* **Manual mode (default).** Nothing is ever sent without your explicit "yes" for that exact ticket;
  the reply is recorded verbatim in `trader/approvals.jsonl`.
* **Autopilot is opt-in.** Starting it (`--autopilot` / `--approve`, or `autopilot.enabled: true`) is a
  *standing approval* for orders that pass **every** gate:
  1. a fresh trigger (the setup fired on the last closed bar),
  2. **a real edge in the backtest** — ≥ 10 past triggers on that symbol and expectancy ≥ +0.05R after costs,
  3. a Time Machine replay that doesn't reject the stop/target geometry (EV ≥ −0.05R),
  4. no fresh red-flag news or filing for the symbol (fetched right before the decision: dilution /
     offering, bankruptcy, delisting, restatement 8-Ks; hacks and delistings for coins),
  5. its own record doesn't argue against it (setups that lost money for the bot are paused; a symbol
     with three losses in a row sits out; a losing streak halves the size; a 10 % drawdown pauses the bot),
  6. desk verdict GO — and, if you enable the optional **AI desk**, Claude doesn't veto it (it can only
     say no, never yes to something the rules rejected) — then sizing and a risk PASS against `limits.json`,
  7. stocks and crypto only — **meme coins are never auto-traded** (no wallets, no keys, ever).

  It also stops opening trades after `max_new_trades_per_day`, takes no new stock entries after 15:30 ET,
  kills itself (cancels orders, flattens) if the day's loss hits `max_daily_loss_usd`, and has a KILL
  button in the dashboard.
* **Where it trades.** `simulator` (default) fills orders against real market data in a local paper book — no
  account. `alpaca` + `paper` uses your free Alpaca paper account. **Live** requires *all* of: broker
  `alpaca`, `autopilot.mode: "live"`, top-level `"paper": false`, live keys, and
  `"live_confirmation": "I ACCEPT REAL MONEY RISK"` — set by you in your own files. There is
  deliberately no button for it; anything missing and the autopilot refuses to start in live mode.
* **24/7 means crypto.** Crypto trades around the clock; US stocks only in the regular session
  (9:30–16:00 ET = 15:30–22:00 in Central Europe). Pre-market, after-hours and overnight stock
  sessions are deliberately not traded — the setups and backtests are built on regular-session bars.
* **Be honest with yourself.** On the demo data, almost every rule *lost* money in its backtest, so the
  autopilot skipped almost every setup it found. A bot trading a strategy without an edge loses money faster than
  you would by hand. Run it on paper for weeks and only consider live if the journal shows a positive
  edge net of costs over a meaningful number of trades.

## Install

* **Plugin:** `/plugin marketplace add <owner>/trader-skill` then `/plugin install trader-skill@trader-skill`
* **Copy the folders** (keep `shared/` next to the skills; the desk's subagents go to `~/.claude/agents/`):
  ```bash
  cp -r trader-* shared ~/.claude/skills/
  mkdir -p ~/.claude/agents && cp agents/*.md ~/.claude/agents/
  ```
  The dashboard and scripts run straight from the repo folder.

## Configure

The first run creates `trader/config.json` and `trader/limits.json` (override the folder with
`TRADER_HOME`). The keys that matter most:

```json
{
  "account_size": 25000, "risk_per_trade_pct": 0.5, "paper": true,
  "watchlists": {"stocks": ["TSLA", "NVDA", "AAPL"], "crypto": ["BTCUSDT", "ETHUSDT"], "meme": []},
  "sec_user_agent": "Jane Doe jane@example.org",
  "autopilot": {"enabled": false, "broker": "simulator", "mode": "paper", "max_new_trades_per_day": 3,
                "universe": {"mode": "auto", "stocks": {"top_n": 40}, "crypto": {"top_n": 20}, "exclude": []}},
  "news": {"x": {"enabled": true, "max_reads_per_day": 300, "poll_minutes": 15}},
  "notify": {"enabled": false, "ntfy_topic": "", "telegram": false},
  "ai_desk": {"enabled": false, "model": "claude-opus-5-5", "max_usd_per_day": 3.0}
}
```

Every other knob (news gate tags and lookbacks, learning thresholds, scan budget …) is listed in
`docs/SCHEMAS.md` and `trader-autopilot/SKILL.md`.

Keys and passwords go in environment variables or `trader/secrets.env` (never in git; `chmod 600` it):

```bash
ALPACA_PAPER_KEY_ID=...          # free paper account: alpaca.markets → Paper Trading → API keys
ALPACA_PAPER_SECRET_KEY=...
X_BEARER_TOKEN=...               # optional: X developer account, pay-per-use
TRADER_DASHBOARD_PASSWORD=...    # only needed to open the dashboard from your phone
TELEGRAM_BOT_TOKEN=...           # optional: notifications via your own Telegram bot (+ TELEGRAM_CHAT_ID)
ANTHROPIC_API_KEY=...            # optional: the AI desk (pip install anthropic)
```

Nothing ever prints, logs or returns a key — the dashboard only shows "set / not set".

### News from X and StockTwits

* **X** works through the official API with *your* bearer token. Since 2026 X bills **pay-per-use**
  (third-party sources put a post read around $0.005 — your X Developer Console shows the real price),
  so every read counts against `news.x.max_reads_per_day` (default 300) and each query is cached for
  `poll_minutes`. It follows cashtags on your watchlist plus curated breaking-news accounts
  (configurable). Scraping x.com or using Nitter is not supported.
* **StockTwits** is free and needs no key: crowd sentiment per symbol plus the top messages — labelled
  as crowd mood, not information.
* Everything lands in one ranked, deduplicated `trader/news_feed.json` (the same story from Yahoo and
  X becomes one item), shown in the dashboard's News tab.

### Optional AI desk (Claude, veto-only)

The rule-based desk reads numbers; it can't read a headline, an 8-K or a tweet and judge what it
means. Set `ai_desk.enabled: true`, `pip install anthropic` and put `ANTHROPIC_API_KEY` in your
environment or `trader/secrets.env`, and every trade the rules already cleared gets a second look: an
AI Skeptic (default model `claude-opus-5-5`) tries to prove it wrong from the case — plan, backtest,
Time Machine, news and filings — then an AI Lead answers each objection and decides GO / NO-GO / WAIT.
It can only stop a trade: it never runs on, or revives, an idea the rules rejected. Headlines, posts
and filings are passed to it as untrusted data, never as instructions. Spending is capped per day
(`max_calls_per_day`, default 40 calls = 20 reviews; `max_usd_per_day`, default $3 — roughly
$0.10–0.20 per review) and logged in `trader/ai_usage.json`. If it is off, offline, out of budget or
failing, `ai_desk.on_unavailable` decides: `rule_based` keeps the rule-based decision, `skip` places no
trade. Try it by hand: `python3 trader-desk/ai_desk.py --id <idea>`. The rest of the pack never needs
the SDK.

## Running it for real — 24/7

```bash
python3 trader-autopilot/autopilot.py daemon --approve   # the bot, around the clock (one per trader/ folder)
python3 app/server.py                                    # the dashboard, in another terminal
python3 trader-autopilot/autopilot.py status             # alive? what is it doing?
python3 trader-autopilot/autopilot.py universe           # what it watches and why
python3 trader-autopilot/autopilot.py learned            # what its own trades taught it
python3 trader-autopilot/autopilot.py kill --confirm KILL
```

The bot only trades while it runs, so for 24/7 it belongs on a small always-on server, not a laptop
that sleeps. `deploy/` has everything for a ~5 €/month Linux VPS: `install-vps.sh` (two systemd
services, a dedicated user, secrets in `/etc/trader/trader.env`), a `docker-compose.yml` alternative,
a Caddy config for HTTPS, and a step-by-step guide in Slovak (`deploy/NAVOD.sk.md`). The dashboard
stays on 127.0.0.1 — open it through an SSH tunnel, or behind Caddy with a password.

**What "24/7" does:** every minute the daemon syncs the broker, manages exits and the kill switch; every
closed 5-minute bar it scans its universe (crypto always, stocks 9:30–15:30 ET); between cycles it
refreshes the news feed in the background. It writes a heartbeat (the dashboard shows *alive* /
*stale*), holds a lock so two copies can't trade one account, backs off and notifies you when cycles
keep failing, and stops cleanly on SIGTERM.

**Phone notifications:** set `notify.enabled: true` and either an [ntfy](https://ntfy.sh) topic (free
app, no account — use a long random topic name) or your own Telegram bot. You get trade opened/closed,
kill switch, drawdown pause, what it learned, repeated errors and a daily summary after the US close.
`autopilot.py notify-test` checks the setup.

## Dashboard

A local web app over the `trader/` folder (stdlib server, no CDN, dark/light, built for phones):
Overview (equity curve, P&L today/total, win rate, expectancy, positions, latest decisions, top news,
desk verdicts, bot heartbeat and trading sessions) · Trades (every trade with a candle chart, entry/exit, stop/target, R, fees) · Bot
(status, pause / resume / run once / KILL, mode and what live would need, gates, decision timeline,
the universe with reasons, what it learned, notifications, AI desk spend) ·
News (X, StockTwits, news, SEC with importance and sentiment) · Setups · Reports.

Security: binds to 127.0.0.1 unless you give a password; every button needs a per-session CSRF token;
no response ever contains a key; reports are served sandboxed; live trading cannot be switched on from
the dashboard. `python3 app/devdata.py --home /tmp/trader-sample` writes clearly-marked SAMPLE data.

## Walkthroughs (real output of `python3 scripts/demo.py`, offline fixtures)

The demo pins the clock and serves synthetic fixtures. The desk runs before every Trader step — only a
**GO** leads to sizing, a risk check and a ticket. Output is trimmed.

### 1 · NVDA opening-range breakout — the desk says GO

NVDA's fixture history is generated with an opening-range follow-through, so this is the one setup in
the demo with a genuine (synthetic) edge.

```text
$ python3 trader-entry/entry.py NVDA --setup orb15            [9:50 ET]
Status: Watching → TRIGGERED — the 9:45 candle just closed above the opening range. Get in $193.92.
$ python3 trader-exit/exit.py --id NVDA-20261020-orb15
Get in $193.92 · Stop $190.90 · Target $199.96 (2R) · Time stop 3:55 p.m. ET
$ python3 trader-backtest/backtest.py NVDA --setup orb15
Last 59 sessions: 27 triggers, 12 hit target, 9 hit stop, 6 neither.   avg +0.67R net per trade
$ python3 trader-timemachine/replay.py --id NVDA-20261020-orb15 --seed 7
Target first 3.7% · Stop first 27.3% · Neither 69.0% · Expected value -0.01R
$ python3 trader-desk/desk.py auto NVDA
Status: GO — Cleared by the desk.
  O1 [minor] stop first is 27% vs target first 4% — fine only if the backtest edge is real → Lead: accepted
  ✓ Time Machine expected value  EV -0.01R (minimum EV -0.05R)
  ✓ backtest expectancy          … expectancy +0.67R after costs
$ python3 trader-sizer/size.py   →  BUY 32 NVDA ≈ $6,205 · risk $96.64 · limit $193.93 · capped by max position 25%
$ python3 trader-risk/risk.py    →  PASS ✓  all 12 checks passed
$ python3 trader-broker/ticket.py prepare
  BUY 32 NVDA, limit $193.93, stop $190.90, day — PAPER
Reply yes to send this exact ticket to the PAPER account.
$ python3 trader-broker/ticket.py approve --ticket tkt-ord-NVDA-20261020-135000 --reply "yes"
APPROVED — hand this payload unchanged to the alpaca MCP tool place_stock_order: {…"order_class": "bracket"…}
$ python3 trader-journal/journal.py add --plan NVDA-20261020-orb15 --auto        [after the close]
JOURNAL — CLOSED NVDA orb15 · $193.92 → $196.32 (time) · +0.80R · P&L $74.30
```

### 2 · TSLA — a real catalyst, but the desk says NO-GO

```text
$ python3 trader-news/news.py --symbols TSLA
  [!!!] 9:05 ET  Tesla–SpaceX merger mania strikes Wall Street ahead of earnings — Yahoo Finance (also: Google News)
  [!! ] 7:31 ET  8-K filed: Regulation FD disclosure — SEC EDGAR — guidance: official filing — read it before trading
$ python3 trader-entry/entry.py --id TSLA-20261020-orb15     [10:15 ET]
Status: Watching → TRIGGERED — the 10:10 candle just closed above the opening range. Get in $364.18.
$ python3 trader-backtest/backtest.py TSLA --setup orb15
Last 59 sessions: 33 triggers, 6 hit target, 17 hit stop, 10 neither.   avg -0.12R net per trade
$ python3 trader-desk/desk.py auto TSLA
Status: NO-GO — The Trader stands down, no money moves.
  O1 [critical] this rule lost money on TSLA: expectancy -0.12R after costs over 33 triggers → Lead: accepted
  O3 [minor] earnings headlines in the feed — event risk inside or right after the holding window
[desk] NO-GO → the Trader stands down: no sizing, no ticket, no money moves.
```

A merger headline and a clean breakout make TSLA *feel* like a trade. The history says this rule
loses money on TSLA, so nothing is sized or sent.

### 3 · BTC/USD Asia-range breakout at the US open — NO-GO

```text
$ python3 trader-scanner/scan.py --asset crypto
  1. BTC/USDT  TRIGGERED  Asia-range breakout  $67,448.60 · 14:35 UTC · flags: volume_spike, rising_oi · score 92
$ python3 trader-exit/exit.py --id BTCUSD-20261020-asia_range --horizon 4h
Get in $67,448.60 · Stop $67,320.53 · Target $67,704.74 (2R) · Time stop 18:40 UTC (4h horizon)
$ python3 trader-desk/desk.py auto BTC-USD
Status: NO-GO — O1 [critical] this rule lost money on BTC/USD: expectancy -1.31R after costs over 15 triggers
```

### 4 · A Solana meme coin — rugcheck passes one, blocks the other, the desk says NO-GO

```text
$ python3 trader-scanner/scan.py --asset meme
  1. PUPKIN  TRIGGERED  Momentum breakout  $0.004712 · liq $412.4k · rugcheck SAFE 95
  2. NEWT    FLAG       First-hour launch  liq $38.5k · rugcheck RISKY 55
  hidden: MLAMBO (solana) — rugcheck DANGER: LP not locked or burned (0% locked); Top holder owns 40.0% of supply; …
$ python3 trader-risk/risk.py --symbol SOL:<MLAMBO> --notional 100 --entry 0.000918 --stop 0.00078
BLOCK ✗ — rugcheck DANGER (score 0): LP not locked or burned (0% locked) — the deployer can pull liquidity; Top holder owns 40.0% …
$ python3 trader-timemachine/replay.py --seed 7
Target first 1.1% · Stop first 20.9% · Neither 77.0% · Rug pull 0.9% · EV -0.16R   (thin sample: 2.5 days of history)
$ python3 trader-desk/desk.py auto SOL:<PUPKIN>
Status: NO-GO — O2 [critical] the replay says this geometry loses: EV -0.16R (minimum -0.05R)
```

On a GO, the Trader would hand you a manual swap checklist (contract address, chain, pool, amount, max
slippage, links to verify the address, "use a wallet that holds only this trade's amount", "a DEX has no
stop orders — set alerts"). Meme coins are never sent anywhere automatically.

### 5 · Autopilot — it picks its own symbols and trades the whole day in the simulator

```text
$ python3 trader-autopilot/autopilot.py replay --from 2026-10-20T13:35:00Z --to 2026-10-20T20:00:00Z --step 5m --approve
AUTOPILOT REPLAY · 78 cycles in 14.4 s
  13:45 UTC  skipped NVDA gap_and_go
  13:50 UTC  taken NVDA orb15
  13:50 UTC  skipped PLTR orb15
  13:55 UTC  filled 32 NVDA @ $193.92
  13:55 UTC  skipped XRP/USDT vwap_reclaim
  14:15 UTC  skipped TSLA orb15
  14:40 UTC  skipped BTC/USDT asia_range
  …
  19:55 UTC  closed NVDA (time) @ $196.28 · P&L $75.52
Decisions: 1 taken · 23 skipped · 0 errors
  skipped NVDA     gap_and_go     desk NO-GO: the edge is too thin to pay for mistakes: expectancy +0.00R (want ≥ +0.05R)
  skipped PLTR     orb15          desk NO-GO: this rule lost money on PLTR: expectancy -0.73R after costs over 3 triggers
  skipped META     orb15          desk NO-GO: thin sample: only 3 past triggers (want ≥ 10)
  skipped TSLA     orb15          desk NO-GO: this rule lost money on TSLA: expectancy -0.12R after costs over 33 triggers
  trade NVDA 32 $193.92 → $196.28 (time) · +0.78R · $75.52
Equity $25,075.52 · cash $25,075.52 · running · watching 6 stocks + 7 coins · 0 open, 0 pending

$ python3 trader-autopilot/autopilot.py universe
UNIVERSE · mode auto
stock: 6 symbols · built-in liquid list ranked by Yahoo spark + Yahoo most actives / day gainers
  TSLA       watchlist          …
  PLTR       top mover: gap +0.8% · move +3.9%
crypto: 7 symbols · CoinGecko top by 24h volume
  BTCUSDT    watchlist          …
  XRPUSDT    top 20 by 24h volume ($4.4B)
excluded: BYND (market cap $490.0M below $2.0B), MULN (price $0.31 below min_price $2.00)

$ python3 trader-autopilot/autopilot.py learned
WHAT THE AUTOPILOT LEARNED FROM ITS OWN TRADES · on
Risk × 1.0 · equity $25,075.52 · peak $25,088.32 · drawdown 0.1%
  setup stock:orb15              1 trades · 1 wins · +0.78R · active
```

The offline fixtures only cover a handful of symbols; live, the universe is ~40 stocks and 20 coins.
Then open the dashboard on that day: `python3 app/server.py --home demo/autopilot --offline`.

### Arbitrage gap monitor

```text
$ python3 trader-arb/arb.py SOL:<PUPKIN> BTCUSDT
PUPKIN — best route: buy meteora → sell raydium · gap +0.15% − costs 6.27% = net -6.12%  → NO EDGE AFTER COSTS
BTC/USDT — best route: buy Kraken → sell Binance · gap +0.05% − costs 0.54% = net -0.49%  → NO EDGE AFTER COSTS
```

Real arbitrage is a millisecond race won by bots co-located with exchanges and validators; viral
"$1 → $400k arbitrage bot" stories are survivorship bias at best, and bots that ask for your private
key or a deposit are a common scam. This tool only watches.

## Workflows

```
manual (stocks / crypto):  scanner → news → entry → exit → backtest → timemachine → DESK → sizer → risk → broker (your yes) → journal
meme coins:                scanner → rugcheck → news → entry → exit → timemachine → DESK → sizer → risk → manual checklist → journal
autopilot (24/7):          own universe → the same chain + just-in-time news & filings + its own record → DESK (+ AI veto) → orders only on GO + risk PASS
always on:                 dashboard · alerts · news feed (stocks in market hours, crypto & meme 24/7)
```

## Data sources (free unless noted)

| Data | Primary | Fallbacks |
|---|---|---|
| Stock candles & quotes | Yahoo Finance chart JSON | Stooq CSV |
| Stock universe | SEC `company_tickers_exchange.json` | Nasdaq Trader symbol directory |
| Autopilot universe | built-in ~150 liquid US names ranked by Yahoo spark · Yahoo most actives / day gainers · CoinGecko by volume | the watchlists |
| Stock news / filings | Yahoo & Google News RSS · SEC EDGAR 8-K (User-Agent with name + e-mail) | — |
| Crypto candles & quotes | Binance (`api.binance.com`) | `data-api.binance.vision` mirror → Coinbase → Kraken |
| Crypto universe · funding & OI | CoinGecko · Binance futures | Binance tickers · OKX |
| Crypto news | CoinDesk, Cointelegraph, The Block RSS | — |
| Meme pairs · candles · safety | DexScreener · GeckoTerminal · RugCheck / honeypot.is | next-deepest pool |
| Social | **X API (your token, pay-per-use)** · StockTwits (free) | — |
| Trading | Local simulator · **Alpaca** (free paper account; live by explicit opt-in) | — |
| Notifications | ntfy.sh (free) · Telegram Bot API (your bot) | — |
| AI desk (optional) | Claude API (your key, pay-per-use, daily budget) | the rule-based desk |

`api.binance.com` and Binance futures answer HTTP 451 from some countries; the data layer notices and
moves on to the mirror / OKX automatically.

## Offline mode, tests and the demo

```bash
python3 -m unittest            # 375 tests, no network (fixtures only), Python 3.8+
python3 scripts/demo.py        # all walkthroughs; reports in demo/trader/reports/index.html
```

`--offline` serves every request from `tests/fixtures/http/` — synthetic data in each API's raw
format, so offline runs go through the same parsing code as live runs. `--now` pins the clock.

## Known limits

* **Free data is delayed, rate-limited and sometimes wrong.** Yahoo keeps only ~60 calendar days of
  5-minute bars (≈ 40 sessions live). Endpoints change without notice.
* **Backtests are small samples** (tens of trades); costs and slippage are estimates. A positive backtest
  is necessary, not sufficient.
* **The Time Machine is not a prediction.** It resamples ordinary bars, so it cannot see the conditional
  behaviour after a breakout, news shocks, halts or gaps; a fair 2:1 bracket replays to about 0R.
* **The autopilot is simple on purpose:** long only, one position per symbol, bracket exits, no
  pre/after-market or overnight stock trading. It is as good as the edge in your rules — which you have
  to prove on paper first. "Learning" means pausing what lost and trading smaller after losses; it does
  not invent new strategies.
* **The news gate reads headline tags, not meaning.** It catches the obvious (a dilution 8-K, a hack);
  the optional AI desk reads the text, but it can be wrong too, and neither sees news that isn't
  published yet. SEC filings need `sec_user_agent` set to your name and e-mail.
* **X costs money and its timeline is noisy;** StockTwits is crowd mood. Neither is a signal by itself.
* **Meme-coin data can be manipulated** (wash trading, hidden insiders, expiring LP locks). A clean
  rugcheck means "no red flags found in these checks", nothing more.

## Repo layout

```
trader-skill/
  README.md  LICENSE  .claude-plugin/{plugin.json, marketplace.json, icon.png}
  trader-scanner/ trader-news/ trader-entry/ trader-exit/ trader-timemachine/ trader-risk/ trader-sizer/
  trader-alerts/ trader-broker/ trader-journal/ trader-backtest/ trader-rugcheck/
  trader-desk/ trader-arb/ trader-autopilot/
  agents/        trader-researcher.md, trader-skeptic.md, trader-lead.md (the desk's subagents)
  app/           server.py + static/ (the dashboard), devdata.py (sample data)
  deploy/        Dockerfile, docker-compose.yml, systemd units, install-vps.sh, Caddyfile, guides (EN + SK)
  shared/        data.py, sources/* (incl. x.py, stocktwits.py), brokers/ (simulator, alpaca), symbols, market_clock,
                 setups, trade_sim, indicators, cache, http, offline, secrets, html, cli,
                 universe (what the autopilot watches), adapt (what it learned), notify (ntfy / Telegram)
  tests/         test_*.py, fixtures/ (make_fixtures.py regenerates them)
  docs/SCHEMAS.md  every trader/ state file, field by field
  scripts/demo.py  the walkthroughs, offline (scripts/demo.sh wraps it)
```

## License

MIT — see [LICENSE](LICENSE).
