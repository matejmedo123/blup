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
| `/trader-backtest` | "Last 59 sessions: 33 triggers, 6 hit target, 17 hit stop, 10 neither." — with fees and slippage. Plus the **backtest lab** (`lab.py`): every crypto setup on dozens of coins and on 5m / 1h / 4h bars, 160 exits each, walk-forward validation, a playbook of what held up — the only crypto the autopilot trades, sized by certainty |
| `/trader-desk` | Researcher → Skeptic → Lead: every objection must be answered; GO only through hard gates. AI subagents, a rule-based mode (`desk.py auto`, incl. a news & filings gate) or the optional Claude API desk (`ai_desk.py`, veto-only) |
| `/trader-sizer` · `/trader-risk` | Position size from account × risk %; PASS/BLOCK against `limits.json` (per asset class, daily loss, exposure, rugcheck) |
| `/trader-broker` | A plain ticket + the exact JSON for your brokerage MCP connector, sent only after you type **yes**; meme coins get a manual wallet checklist |
| `/trader-autopilot` | Trades for you **24/7**: picks its own universe (~40 liquid US stocks ranked by today's movement + the day's most active names, the 20 most traded coins), fetches the latest news and SEC filings before every trade, runs every gate, places orders through the **local simulator** (default) or **Alpaca** (paper; live only through an explicit opt-in), manages exits, journals fills, learns from its own record, notifies your phone, kill switch |
| `/trader-alerts` | Rings once on levels, stops/targets, % moves, the opening bell, liquidity pulled, dev selling |
| `/trader-journal` | Every trade with its chart; win rate, expectancy (net of costs), best/worst setups per asset class |
| `/trader-rugcheck` 🛡️ | Meme-coin safety gate: LP lock, mint/freeze authority, honeypot/taxes, holder concentration, dev share, age, fake-volume hints → SAFE / RISKY / DANGER |
| `/trader-arb` | Read-only arbitrage gap monitor — shows why visible gaps don't survive fees and slippage |
| `/trader-sniper` | Meme-coin sniper — new DEX tokens (pump.fun, PumpSwap, Raydium, Meteora, PancakeSwap, Base) found early, checked hard (liquidity at your size, holders, rug pull, honeypot, fake hype), traded small; paper by default, live on Solana from a wallet of its own |
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
  5. crypto: the **backtest lab** validated that coin + setup on months of history it never saw while
     choosing the exit — and the size follows that certainty (more risk only with a high profit chance on
     many unseen trades, never past `limits.json`),
  6. its own record doesn't argue against it (setups that lost money for the bot are paused; a symbol
     with three losses in a row sits out; a losing streak halves the size; a 10 % drawdown pauses the bot —
     the trend profile below loosens these to fit a strategy that wins only 30–40 % of its trades),
  7. desk verdict GO — and, if you enable the optional **AI desk**, Claude doesn't veto it (it can only
     say no, never yes to something the rules rejected) — then sizing and a risk PASS against `limits.json`,
  8. stocks and crypto only — **the autopilot never trades meme tokens on a DEX** and never touches a wallet
     or key; that is the separate `/trader-sniper`'s job — paper by default, live only on Solana from a
     wallet of its own with a hard cap, never from yours, and only once its own paper record pays.
     Meme coins listed on the exchanges (DOGE, SHIB, PEPE, BONK, WIF, …) are off too unless you switch them on
     (`profile --memes` or `autopilot.memes.enabled`): then only the established ones — among the top 40 by
     market cap, a year on the exchange, validated by the lab like any coin — at half the risk.

  It also stops opening trades after `max_new_trades_per_day`, takes no new stock entries in the last
  30 minutes of the session (15:30 ET, 12:30 on early-close days) or a 4th day trade under $25,000 at
  Alpaca, kills itself (cancels orders, flattens) if the day's loss hits `max_daily_loss_usd`, and has a
  KILL button in the dashboard — a KILL is retried every cycle until nothing is left. Its exits and the kill switch sell only what the bot bought and cancel only its
  own orders — shares or coins you hold yourself at the same broker are never touched. A broken file, a
  typo in `config.json`, a full disk or one failing position never stops the stops and time stops of the
  others: the bot then takes no new trades and says why. A setting of the wrong type (`"5%"` for a number,
  `"false"` for a switch) is an error that names the line, never a quiet "yes" or "no limit".
* **Leverage is off.** It needs both `leverage.<asset>` in `config.json` and `allow_leverage` /
  `allow_margin` + `max_leverage` in `limits.json`; no file can go past **2×**, meme coins never, and
  crypto at Alpaca never (there is no crypto margin there). Leverage only lets more positions be open at
  once — the risk per trade is still set by the stop. Borrowed cash costs `borrow_rate_pct` (10 % a year)
  in the simulator.
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
  "leverage": {"stock": 1.0, "crypto": 1.0},
  "watchlists": {"stocks": ["TSLA", "NVDA", "AAPL"], "crypto": ["BTCUSDT", "ETHUSDT"], "meme": []},
  "sec_user_agent": "Jane Doe jane@example.org",
  "autopilot": {"enabled": false, "broker": "simulator", "mode": "paper", "max_new_trades_per_day": 5,
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

## Backtest lab — what actually worked, with how much certainty

```bash
python3 trader-backtest/lab.py                       # top 25 coins · 5m (180 d) + 1h (365 d) + 4h (730 d) + 1d (~8 y)
python3 trader-backtest/lab.py --min-target-r 2      # only exits that aim for 2R or more
python3 trader-backtest/lab.py --universe today      # the old way: today's top coins for the whole history
```

**Point-in-time coins (the default).** Today's biggest coins are partly big *because* they rose, so a
backtest on them alone flatters every trend strategy. The lab trades each period only on the coins that
were biggest (30-day dollar volume) when that period began — including coins that later collapsed or
were delisted (LUNA, FTT, SRM, EOS, WAVES …), from Binance's own history. Each coin still gets its own row,
but sizing trusts the strategy's point-in-time result, not one coin's.

For every crypto setup — the one-day breakouts on 5-minute bars, four swing setups on 1-hour and 4-hour
bars, and four daily strategies with their own exit rules (trend following EMA20/50, trend breakout,
breakout on volume and dip-in-uptrend, all switched on only while Bitcoin is above its 200-day average) —
it tries 160 exits (targets 0.5–5R, structure or 1–3×ATR stops, four time stops), with
fees and slippage. It works **walk-forward**: the history is cut into four periods, and for each of the
last three the exit with the highest **profit chance** (certainty: how often 20 trades ended in profit)
is picked on everything before it — all coins pooled — and then traded unchanged in that period, which
the choice never saw. A setup holds only if it made money in every one of those periods; a coin is
**validated** only if it made money out of sample, including the latest period. Validated combinations
become `trader/backtests/playbook.json`, the only crypto the autopilot trades — with those exits, and
with more size the higher the certainty (never past `limits.json`). The daemon re-runs it weekly.

**Real runs** (21 Oct 2026 · top 30–40 coins by volume · 5m 180 days, 1h 365 days, 4h 730 days, 1d ~8 years ·
0.26 % round-trip costs):

| | Result |
|---|---|
| **Held in all three walk-forward periods** (1d, ~8 years) | **trend following EMA20/50** (20 EMA above the 50 EMA, higher highs and higher lows, out below the 50-day EMA): +3.37R / +0.78R / +0.65R per trade, 30 % wins, 76 % chance that 20 trades end in profit · **trend breakout** (close above the 20-day high, out below the 10-day low): +0.82R / +0.36R / +0.71R, 41 % wins, 82 % — both only while BTC is above its 200-day average; 33 coin + setup combinations validated |
| Everything intraday (5m, 1h, 4h) | nothing held — fees and noise eat it |
| Breakout on 1.5× volume, daily | strong lately (+0.74R, +1.33R) but no edge in the earliest period — not validated |
| Daily dip in an uptrend | 66 % wins but only +0.08R per trade, slightly negative in one period — not validated |
| Closest | 24-bar breakout on 4h bars, 5R target, 1.5×ATR stop, 48 h: +0.34R / −0.34R / +0.18R per trade in the three periods (40 % wins, +0.13R overall) — works in trending stretches, loses in choppy ones |
| Highest win chance | 64–73 % (0.5R target, 2–3×ATR stop) — and −0.09R to −0.17R per trade after costs; the best of them, the 4h band bounce, nets +0.02R |
| A single train/test split | "validated" the 4h band bounce on 6 coins (profit chance up to 98 % on 10 trades) — a different split flipped it, which is why the lab now insists on every period |
| Per-coin tuning | 109 per-coin "best settings" in training, 43 % still profitable in the latest period — worse than a coin flip |
| One-day setups on 5-minute bars | no exit had an edge in any training period: 0.26 % costs are a whole 1R on many of these stops |

**The same daily trend strategies, coins chosen point in time** (21 Oct 2026 · top 10 · 1d ~8 years):

| | Today's top 10 for all 8 years (old) | The top 10 of each period's own time (honest) |
|---|---|---|
| Trend following EMA20/50 | +4.65R / +0.74R / +2.81R per trade · 92 % | **+2.97R / +0.66R / +0.34R** · 35 % wins · **84 %** |
| Trend breakout | +1.27R / +0.47R / +1.36R · 93 % | **+0.84R / +0.29R / +0.59R** · 44 % wins · **83 %** |

Both still made money in every period — but the edge is roughly half of what today's winners suggest, and
in the latest period trend following earned only +0.34R per trade.

**The four classic strategies, as exact daily rules** (crypto: 43 coins 2018–2026, BTC above its 200-day
average; stocks: 162 liquid US names and ETFs 2016–2026; costs included; "chance" = 20 trades end in profit):

| Strategy | Crypto | US stocks |
|---|---|---|
| Trend following (EMA20/50, higher highs/lows) | +1.22R/trade, 31 % wins, 77 % | +0.24R, 33 %, 64 % |
| Breakout (20-day high on 1.5× volume) | +0.92R, 32 %, 73 % | +0.25R, 38 %, 63 % |
| Pullback to the 20 EMA in an uptrend | +0.04R — no edge | +0.08R — weak |
| Range trading (ADX < 20, buy the bottom of the range) | −0.17R to −0.36R — loses | +0.10R — weak |

**What €1,000 would have become** (portfolio simulated day by day, 1 % risk per trade, up to 10 positions,
costs included, EUR/USD moves ignored — the past, not a forecast):

| Since 1 Jan 2020 | Result | per year | worst drop |
|---|---|---|---|
| Crypto trend breakout, 40 coins | €10,891 | +42 % | −30 % |
| … BTC + ETH only (no survivorship bias), 2 % risk | €2,547 | +15 % | −16 % |
| Crypto trend following EMA20/50, BTC + ETH only, 2 % risk | €4,063 | +23 % | −18 % |
| Stock breakout, 162 names | €2,239 | +13 % | −36 % |
| Mix: crypto trend breakout + stock breakout | €5,116 | +27 % | −39 % |
| Buy & hold BTC · buy & hold SPY | €11,545 · €2,367 | | −77 % · −34 % |

Last 12 months (Oct 2025 → Oct 2026): the mix €1,543, BTC buy & hold €768, SPY €1,146. The many-coin
numbers are flattered by survivorship (today's top coins are the ones that survived); the BTC + ETH rows
are the sober estimate. On stocks, none of the four beat simply holding an S&P 500 ETF.

### 2 % risk and a little leverage — `autopilot.py profile`

```bash
python3 trader-autopilot/autopilot.py profile --risk 2 --leverage 1.5 --capital 1000          # shows the changes
python3 trader-autopilot/autopilot.py profile --risk 2 --leverage 1.5 --capital 1000 --write  # saves them
```

One command sets the bot up exactly as the portfolio backtest below ran it: 2 % of equity at risk per
trade (1 % when the lab is less than 70 % sure, never more than 2 %), only the two validated daily trend
strategies on the 10 biggest coins (the intraday stock setups are switched off — nothing trades that this
backtest did not test; stocks come in only through the ETF trend below), 5 positions, up to 25 % of equity in one coin and 100 % in crypto
(both × leverage), crypto leverage 1.5× (stocks stay 1×), and learning rules that fit a strategy with
30–40 % winners: setups judged after 20 trades, a coin sits out after 5 losses in a row, size halves
after 7 losses in a row (at a 35 % win rate seven in a row happen by chance ≈ 5 % of the time, three
≈ 27 %), and the bot pauses at a
−35 % drawdown — just past the worst drop of eight years of history. Dollar limits stay as a backstop at
4× the account; the % limits grow with it. It also lets winners ride (below; `--no-runner` turns that
off). It never touches the broker, live mode, keys or `autopilot.enabled`.

#### Re-checked on 22 Oct 2026 — read this before the older tables below

The tables further down were made with a fixed coin list that **included DOGE** (a meme coin the bot never
trades — it made most of their 2021) and with 0.13 % costs instead of Alpaca's 0.25 % crypto fee. Re-run
with today's code (the lab's own trades, 2 % risk sized at the worst entry price, 0.28 % per side, 4 % on
idle cash, median of 30 orders of same-day signals; € and $ treated alike):

| €1,000, profile 1× | Since 1 Jan 2020 | Last 3 years | Last 12 months | Worst drop |
|---|---|---|---|---|
| Today's 10 biggest coins (hindsight: ZEC alone made €11.6k) | €44,436 | €5,210 | €1,373 | −26 % |
| **Coins chosen point in time** (the 10 biggest on each day, delisted ones included) | **€12,757** | **€2,365** | **€1,133** | −30 % |
| Only the pairs today's lab validates (no ETF: it validates none) | €13,811 | €2,554 | €1,170 | −22 % |
| Older table's coin list, without DOGE | €19,635 | €2,132 | €1,143 | −29 % |
| BTC bought and held | €11,687 | €2,812 | €777 | −77 % |

Started on any week since mid-2018, point in time: a typical year ends at €1,232 (1 in 10 below €965), a
typical three years at €2,687 (1 in 10 below €1,897). That is the honest expectation for crypto — the
same order as holding BTC, with far smaller drops.

**The real bot, replayed week by week through the last 12 months** (`autopilot.py replay`, simulator,
€1,000 profile, one cycle an hour, and before every week the lab run it would have had that day — not
today's): **€1,169.76** (+17 %), worst drop 5 % hour by hour. BTC was under its 200-day average from November
2025 to 19 August 2026, so for ten months the bot held cash at 4 % (+€33); then 11 trades in two months, 7
won, +€131 (ZEC +€95). BTC held over the same year: €777. The backtest row of the lab's validated pairs says
€1,170 for the same 12 months — the running bot and the backtest agree.
Replayed again on 23 Oct 2026 with the chosen split (`profile --risk 2 --core-risk 3 --fixed-risk`), same weekly
labs: **€1,172.50**, worst drop 6.7 % (with the confidence halving left on: €1,168.12, 6.0 %). BTC and ETH
traded at 3 % (BTC's first trade +1.47R = +€43.63 against +€21.78 halved), the rest at 2 %; the bigger
positions took the cash the August XRP breakout needed and ZEC was bought later ($800 instead of $564), so
the year ends about where 2 % everywhere did. **With crypto at 1.5×** (`--leverage 1.5`, same weekly labs):
**€1,315.01** (+31 %), worst drop 8.4 % — the August XRP breakout taken (+€43) and ZEC bought at $564 (+€191);
interest on the borrowed cash came to €0.93 for the year.

**What if there had been cash for those breakouts?** (pre-registered 23 Oct 2026, the pack's lab trades, coins
point in time, median of 30 signal orders; selection 2020-01 → 2024-06 / hold-out 2024-07 → today):

| €1,000, BTC + ETH 3 %, the rest 2 % | Selection | Hold-out | Since 2020 | Worst drop |
|---|---|---|---|---|
| As deployed (1×) | €9,529 | €1,498 | €15,452 | −30 % |
| Buy what fits (≥ half the size) when cash runs short | €9,677 | €1,444 | €17,278 | −30 % |
| BTC / ETH position cap 33 % instead of 50 % | €9,099 | €1,505 | €15,219 | −30 % |
| Crypto 1.5× (`profile --leverage 1.5`, simulator only) | **€11,345** | **€1,885** | **€24,270** | −30 % |
| Borrow exactly what is missing at 10 %/yr (upper bound) | €11,582 | €1,987 | €25,152 | −32 % |
| 2 % everywhere, 1× / 1.5× | €7,194 / €8,285 | €1,615 / €1,899 | €12,758 / €17,404 | −30 % / −28 % |

Only borrowed money helps: at 2–3 % risk with a 3×ATR stop one position is 20–45 % of the account, so five
of them need more than the account — shrinking a position or capping BTC moves the shortfall around but does
not remove it (both fail the pre-registered rule: > 5 % better in both windows). 1.5× passes it, at the same
worst drop (the stop sets the risk; leverage only lets more trades run at once), but Alpaca has no crypto
margin, so it exists in the simulator only.

**Where the leverage comes from decides whether it pays** (pre-registered 23 Oct 2026, same engine): perpetual
futures charge funding on the *whole* position (Binance funding history since 2019: 10–15 %/yr on average, far
more in bull runs — exactly when a trend follower holds), so Kraken perps at 1.5× made €11,397 since 2020 against
€15,452 for spot at 1×. Spot *margin* charges interest only on the borrowed part, only while cash is short:
€24,270 at 10 %/yr, €23,367 at 30 %, still €21,771 at 75 % — the same worst drop. Hence the **Bybit EU** broker
(`autopilot.broker "bybit"`): MiCA-licensed for the EEA, spot margin, 0.1–0.15 % a side, v5 API; paper is
Bybit's testnet. Stops sit at the exchange (TP/SL orders that sell at market on the trigger), a sale never
borrows, the account is set to 2× at most. `profile --venue bybit` makes the simulator charge its costs (0.15 %
+ 0.03 % slippage a side, 20 %/yr on margin loans, no interest on idle cash, crypto only);
`autopilot.py broker-test` checks the keys read-only. Setup in Slovak: [docs/BYBIT.sk.md](docs/BYBIT.sk.md).
The adapter is built to the documented API and tested on simulated replies — Bybit blocks the US cloud it was
written in, so its first real connection is the testnet on your machine.

The setup as it would run at Bybit (point in time, BTC + ETH 3 %, the rest 2 %, 0.18 % a side, margin at
20 %/yr, nothing on idle cash, no ETF leg — selection / hold-out / since 2020 / worst drop): Bybit 1× €8,786 /
€1,667 / €14,784 / −32 %; **Bybit 1.5× €9,684 / €1,901 / €18,582 / −33 %**; for reference Alpaca 1× with the
ETF leg and 4 % on cash €9,529 / €1,498 / €15,452 / −30 %. Moving to Bybit gives up the T-bill yield and the
ETF leg; the margin more than wins it back.

**A bear-market sleeve and more risk** (two pre-registered studies, 24 Oct 2026, research-bear; deployed long book
point in time, 2 % risk unless stated):

| €1,000 | Hold-out 2024-07 → | 2018–2019 bear | Since 2020 | Worst drop (since 2020) |
|---|---|---|---|---|
| Long book alone | €1,928 | €1,226 | €12,922 | −31 % |
| + shorts on 20-day breakdowns while BTC < SMA200 (the pick) | €1,801 | €1,638 | €13,807 | −39 % |
| + bounce trades in the bear (RSI(2) < 5) | €1,717 | €791 | €7,170 | −57 % |

The breakdown short has a real edge (+32R over 359 trades, beats 100 % of 200 random-entry draws) but a small one,
and the bear-market rallies of 2024–2026 cost more than it made: it fails the test (hold-out −7 %, worst drop 6
points deeper). Bounce trades lose in every window. The long book stays long-only.

With margin solving the cash problem (Bybit costs, BTC/ETH +1 point over the rest): the deployed 2 % / 3 % at
1.5× made €2,078 on the hold-out and €20,998 since 2020 (−32 %); 2× changes nothing (€2,091). More risk earns
more and drops deeper — **3 % / 4 % at 2×: €2,458 hold-out, €42,823 since 2020, worst drop −43 %** (−31 % on the
hold-out, 9 points deeper than the deployed setup, so it fails the pre-registered rule and is not the default);
5 % / 8 positions made €56,731 in the selection window and lost money on the hold-out. Eight positions instead
of five lost on the hold-out at every risk level.

**With established meme coins switched on** (`profile --memes`: only while among the biggest coins, a year
listed, validated by the lab, half the risk — DEX tokens never), point in time, same rules otherwise:

| €1,000, profile 1× | Since 1 Jan 2020 | Last 3 years | Last 12 months | 3 years, typical |
|---|---|---|---|---|
| Without meme coins | €12,789 | €2,365 | €1,133 | €2,687 |
| With them, half risk | €12,845 (19 meme trades: −€288) | €2,680 (15: +€63) | €1,125 | €2,984 |
| With them, full 2 % | €13,443 (17: −€749) | €2,841 (14: +€118) | €1,112 | €3,097 |

Only DOGE, SHIB and PEPE ever qualified and traded. The year-on-the-exchange rule kept DOGE's early 2021 run
out of the honest test (DOGE joined the top 10 only in late January 2021); in a "today's top 40" hindsight run
DOGE alone turns €44k into €71k since 2020 — and costs money over the last 3 years. Meme coins add a little
variety, not an edge; the lab decides each week whether any of them trades.

The lab itself, run on 23 Oct 2026 over every exchange-listed meme coin with Binance history (29 on daily
bars, 35 on 4 h / 1 h: DOGE, SHIB, PEPE, BONK, WIF, FLOKI, TRUMP, PENGU, PNUT, BOME, TURBO, NEIRO, DOGS, NOT,
ORDI, PEOPLE, …; 0.1 % a side), with all twelve setup × timeframe families: **nothing held and nothing was
validated**. Daily: breakout on volume +0.12R in the last period only, trend breakout −0.01R, EMA trend
−0.44R, the dip in an uptrend never had an edge on training data. Swing (4 h / 1 h): the 24-bar breakout
+0.03R, everything else had no exit with an edge on training data. Tuning every coin on its own found 80
"winners" in training, 48 % of which stayed profitable afterwards — a coin flip.

**A "meme radar" as a gem hunter** (23 Oct 2026): the user's page scores the 250 biggest meme coins with
*History* (once exploded, held value, old, big) and *FOMO* (rising now, volume up, near the high). Replayed
point in time over one year of daily data (47 Mondays, rules fixed in advance, the last 11 weeks never used
for choosing): neither score nor any of ten rules built on them predicts the next 7, 14 or 30 days. History
is *negatively* related to what follows in the survivor universe (the top decile lags the bottom by 4–31 %)
and that relation vanishes once dead coins are included — it is survivorship, not a signal. FOMO's rank
correlation is ≈ 0; the radar's own "both" picks (33 coin-weeks) lost a median 9 % in a week and 37 % in a
month, and as a weekly top-10 portfolio −85 % / −80 % / −40 % on the test weeks while the 250 coins
equal-weighted made +21 % / +26 % / +18 % and BTC +29–33 %. Of the real gems (+100 % in 30 days: 3–5 % of
coin-weeks), the picks caught 0–1 %; the best any rule managed was one gem per nine signals (30-day
momentum), with the shuffled baseline close behind. What the scores do measure: FOMO ≥ 30 means "something
is happening now" with ~8 % odds of a double and ~50 % odds of a loss.

**Riding the waves** (23 Oct 2026, the user's next question: not holding, "jump on the wave"): the whole
CoinGecko meme category, dead coins included — 1,155 coins with a month or more of real trading (843 from
CoinGecko, 312 from GeckoTerminal pools), 62 % dead today — over one year of daily data, rules fixed in
advance. The waves are real: 724 tradeable doublings within 14 days, a median 2.6× in 9–14 days, a quarter
of them in coins that are dead today, and half of the coins that waved once waved again, typically two weeks
after the last wave ended. What they have in common is *where* they start, not *when*: a wave base is four
times likelier on a day the coin is down > 20 % in a week or > 50 % in a month, twice as likely within 30
days of the coin's last wave, likelier under $10M and three times less likely above $100M or after a +20 %
week — and still one base per 50–75 such days against one per 200–250 overall. By the time a wave is
visible (+25 % off the 20-day low on 2× volume, day 8–10) half the move is gone, two thirds of waves never
show that signal before peaking, and 91–93 % of the signals are false starts; nothing separates the two
with more than ~22 % precision. All eight pre-registered entries (volume surge, breakouts, two +15 % days,
first green day after −80 %, FOMO crossing, the second wave of a coin) × three exits lost on the first eight
months (−2.6 to −10.2 % a trade); the three least bad, run once on the last 12 weeks: −2.5 %, −1.6 % and
+2.6 % a trade — the last on a single +1,218 % trade (407 % of the cell; −8 % without it) — no better than
random entries into the same coins; on the dead-today coins every rule lost 8–22 %. Only buying the crash
itself, within 0–3 days of the base, would have caught the waves, and no rule tells that base from the 98 %
of crashes that keep falling.

**Smart money on Hyperliquid** (23 Oct 2026, via the Coinversa Pulse connector): the exchange's own
classification of every wallet by profitability, on ten meme perps (FARTCOIN, PUMP, DOGE, kPEPE, PENGU, SPX,
kBONK, TRUMP, WIF, MOODENG), 60 days hourly, rules fixed in advance, the last 20 days run once. Neither the
profitable tiers' net positioning nor the crowd's (read contrarian) is a long-only signal: every test cell lost
after 0.1 % costs (−42 to −65 € per €100 trade over 27–70 trades), the one marginal statistic (fading the
crowd at 72 h) made no money and flips sign when the tiers are assigned from the last 30 days instead of
all time — and the API itself marks the series `backtestSuitable: false`. Individual wallets: of 316 lifetime
top earners on these coins, 39 of the 60 screened no longer trade, none passed the swing-trader filter, and
copying 555 recent longs at the next hourly open lost (hit 40 %, −1.5 % a trade); the winners were dip
entries, the losers chases — the edge, where there is one, is in the entry minute. Exchange-wide context:
swing (+$76M) and holding (+$50M) make money, intraday (−$36M) and HFT (−$12M) lose it; the crowd tier lost on
30 of the last 30 days. Two independent TEXT TO QUANT runs on Binance (PEPE 20-day breakout on 2× volume
with a 25 % trail: +8 % in 3 years, −0.2 % on the last 30 %, grade F; DOGE buy-the-crash: +0.3 %, grade F)
agree with the lab.

**The autopilot's own daily trend rules on an independent engine** (23 Oct 2026, TEXT TO QUANT on Binance
data, last 3 years, 0.07 % costs, 1 % risk a trade, one coin and one position per run — its free plan allows
no cross-market condition, so the "BTC above its 200-day average" switch became each coin's own 200-day
average): the trend breakout (close above the 20-day high, 3×ATR stop, out below the 10-day low or after 60
days) made **+0.45R a trade on BTC** (17 trades, 35 % wins, profit factor 1.9) and **+1.13R on SOL** (13
trades, 46 % wins, profit factor 4.3), positive on the untouched last 30 % of both runs, profitable in 3 of 6
walk-forward windows, with the whole profit in the uptrend blocks and losses in chop — the same shape the lab
reports (+0.3–0.8R, ~40 % wins, only while the trend is up). The engine grades both F for sample size: one
coin gives 13–17 trades in three years, which is why the bot pools ten coins. Its trend-following rule fired
only twice on ETH in that engine's wording (the EMA20/50 cross, not the lab's higher-highs confirmation) —
not comparable. Buy-and-hold beat every run over these three bull years (+146 % BTC, +225 % SOL against +8 %
and +15 % at 1 % risk), as the €1,000 tables above already say: the same order as holding, with far smaller
drops, not more.

**Clean-room audit** (23 Oct 2026): the two rules re-implemented from their written description alone, in
separate code, on Coinbase Exchange candles instead of Binance, by an agent that was not allowed to read this
pack's code. BTC + ETH since 2020, like for like (0.13 % a side, no cash yield): trend breakout **€2,436 vs
€2,547 here**, trend following **€3,833 vs €4,063**, drawdowns −17.6 % / −17.1 % vs −16 % / −18 %; per trade
+0.35…+0.60R at 43–46 % wins and +0.6…+2.1R at 34–48 % — the same numbers within what two exchanges' prices
explain. Both rules on ten of today's big coins since 2020: **€12,771 against the point-in-time €12,757**
here; the €44,436 hindsight row did not reproduce, because half of those coins have no Coinbase history
before 2021 and ZEC is not on Coinbase at all — the same reason that row is marked hindsight. Two things the
audit adds: the median trade is negative in every multi-year sample (16–53 % of the profit is one trade, the
edge is a few big winners), and ten position slots did worse than five (cash runs out, drawdown −43 %).

**More winners, same edge?** (23 Oct 2026, the user wants a higher win rate with a good reward-to-risk; 15
coins on Binance 2018–2026, the history cut in four, variants fixed in advance, picked on the first three
periods and judged on the fourth). Raising the win rate costs reward-to-risk, every time:

| Trend breakout | Win rate (periods 1–3 → 4) | Avg win ÷ avg loss | Per trade (1–3 → 4) |
|---|---|---|---|
| As deployed (two thirds ride) | 42 % → 39 % | 9.2 → 2.6 | +1.89R → +0.23R |
| Baseline exits | 43 % → 40 % | 4.1 → 2.4 | +0.72R → +0.19R |
| **Only on 1.5× volume** | **48 % → 46 %** | 4.3 → 1.9 | **+0.96R → +0.20R** |
| Half at +1R, stop to breakeven | 49 % → 48 % | 2.3 → 1.7 | +0.38R → +0.16R |
| Volume + half at +1R | 54 % → 52 % | 2.3 → 1.4 | +0.51R → +0.15R |
| Breakeven stop after +1R | 37 % → 35 % | 5.3 → 3.1 | +0.64R → +0.20R |

The volume filter is the one change that buys more winners without giving up edge, so it is in the pack as
`trend_breakout_vol` for the lab to judge week by week. Selling half at +1R gets past 50 % wins but takes a
third of the edge and half the growth (BTC + ETH since 2020: +8 %/yr at −7 % drawdown instead of +14 % at
−17 %); a breakeven stop *lowers* the win rate once costs are paid. Trend following (EMA 20/50) could be
pushed to 54–57 % wins on the first three periods, but no variant of it — the deployed one included — made
money on the fourth, so none of its changes can be validated. Random entries with the same exits: +0.08R
at 21–24 % wins — the entries carry real information.

The bot's own lab, coins chosen point in time (top 10 of each period's own time, 108 coins ever big,
delisted ones included), walk-forward over ~8 years, the two rules side by side with one position per coin:

| Pair of rules | Held in every period | Breakout rule out of sample | Trend following out of sample |
|---|---|---|---|
| trend_ema + trend_breakout (deployed) | 1 of 2 | +1.03 / +0.19 / +0.78R · 45 % wins · +0.59R · 67 % | failed period 1's training |
| trend_ema + **trend_breakout_vol** | **2 of 2** | **+2.47 / +0.42 / +1.09R · 53 % wins · +1.05R · 83 %** | +1.56 / +0.65 / +0.28R · 32 % · +0.97R · 73 % |

More winners and a bigger edge per trade, in every period. One caution: the volume filter itself was picked
by looking at all of 2018–2026, so the lab's walk-forward here confirms it but cannot fully prove it — the
portfolio test with a 2024–2026 hold-out decides whether it replaces the plain breakout by default.

**More risk per trade: 5–10 %?** (23 Oct 2026, the user's ask; the same verified harness, €1,000, max 5
positions, one per coin, 0.28 % a side, idle cash at 0 %). At the bot's 25 % position cap, more risk changes
almost nothing — the cap binds first; the cap has to go to 50 % for it to matter:

| €1,000, both rules, cap 50 % | 2 % risk | **5 % risk** | 7.5 % | 10 % |
|---|---|---|---|---|
| BTC + ETH, since 2020 | €3,510 · +20 %/yr · −18 % | **€9,893 · +40 % · −37 %** | €11,399 · +43 % · −41 % | €11,610 · +43 % · −41 % |
| … volume breakout + EMA | €4,019 · +23 % · −17 % | **€10,793 · +42 % · −24 %** | €10,932 · +42 % · −31 % | €10,870 · +42 % · −33 % |
| BTC + ETH, last 3 years | €1,393 · +12 % · −18 % | €1,954 · +25 % · −37 % | €1,970 · +25 % · −41 % | €2,006 · +26 % · −41 % |
| 15 coins, last 3 years | €1,391 · +12 % · −35 % | €897 · **−4 %** · −52 % | €728 · −10 % · −62 % | €643 · −14 % · −66 % |
| 15 coins, last 12 months | €1,122 · +12 % · −10 % | €1,022 · +2 % · −13 % | €992 · −1 % · −14 % | €974 · −3 % · −14 % |

On two coins, 5 % risk roughly doubles the yearly return for a deeper drawdown; past 5 % nothing more is
gained. On a broad basket it is the opposite: with five positions open at 5–10 % each, a run of losers takes
25–50 % of the account at once and the last three years end *below* the start — that is betting past the
Kelly fraction, not boldness. Fewer slots (5 % × 2 positions) did not rescue the broad basket either (+4 %/yr,
−40 %). So: more risk only on a concentrated BTC + ETH book, never across many coins.

Mixed in one book — BTC + ETH at 3 % or 5 % (cap 50 %), the other 13 coins at 2 % (cap 25 %), five slots
shared — the gain mostly disappears, because the core coins compete for the same slots: last 3 years
+11 → +15 %/yr (deployed rules, 5 % core) and +16 → +19 %/yr (volume breakout + EMA, 3 % core) at the same
−32…−37 % drawdown; last 12 months slightly worse at the higher core risk (+12 → +6 %, +7 → −1 %).

**Watching more — more coins, stocks, every rule at once?** (23 Oct 2026, the user's "it watches too
little"; €1,000, 2 % risk, coins point in time from Binance's full listing including delisted pairs, the
choice made on 2020-01 → 2024-06 and judged once on 2024-07 → 2026-10; the generator matched the lab's own
trades one by one). No broader set-up beat the deployed one:

| €1,000, 5 slots | Since 2020 | Hold-out 2024-07 → | Last 12 months |
|---|---|---|---|
| **Deployed** (top 10, trend breakout + EMA) | **€11,352 · +43 %/yr · −34 %** | €1,447 · +17 % · −25 % | €1,095 |
| … volume breakout instead (the pick) | €10,760 · +42 % · −35 % | €1,559 · +21 % · −27 % | €1,117 |
| Top 20 / 30 / 50 coins | €10,949 / 11,854 / 6,361 · −46…−55 % | +9 % / +13 % / 0 % | |
| + 164 US stocks in the same account | €5,045 · +27 % · −39 % | €1,806 · +29 % · −24 % | €1,425 |
| + every daily rule at once | €3,779 · +22 % · −39 % | €1,294 · +12 % | €1,369 |
| 1.5× leverage | €11,638 · +43 % · −34 % | €1,477 · +18 % | €1,095 |
| BTC bought and held | €11,252 · +43 % · −77 % | €1,290 · +12 % · −53 % | €748 |

Coins ranked 11–50 had no edge at all (−0.05 to −0.52R a trade on the hold-out against +0.65R for the top
10). Stocks in the same account helped the last two years but took the cash the crypto trades needed (210
crypto trades since 2020 fell to 24). Eight slots instead of five did better in every period (€13,597 since
2020, +22 %/yr on the hold-out) at a −40 % drawdown — read off the grid, not a pre-registered hypothesis, and
the clean-room audit found ten slots worse than five, so slots stay at five until the combined test below.

**New rules, second batch** (23 Oct 2026; 13 variants fixed in advance, top 10 point in time, picked on
2020-01 → 2024-06, judged once on 2024-07 → 2026-10; the engine matched the bot's trades one by one):
pyramiding the breakout (adds at +1R / +2R), the Turtle 55/20 system, a Bollinger squeeze breakout, a weekly
breakout, an alt-season switch on ETH/BTC and a chandelier stop. **None beat the deployed rules on the
hold-out**: the bot €1,706 (+26 %/yr, −25 %), one pyramid add €1,672 (+25 %, −24 %) — a tie, the position
cap blocked two thirds of the adds — the Turtle €1,334 (+13 %, −19 %), the squeeze no edge, the weekly rule
too sparse, the alt-season switch −4 %/yr, the chandelier stop cut the big runs (+0.31R a trade against
+1.11R). Every 55-day high is also a 20-day high, so the Turtle never gets a trade beside the breakout. At
5 % risk with a 50 % cap on the ten coins every rule lost on the hold-out (the bot −5 %/yr, −40 %): two
positions use up the cash and the +30R XRP trade of November 2024 — €500 of the bot's €700 hold-out profit —
was never taken. One trade carries every hold-out total here; differences of a few hundred euros are noise.

**New strategy classes, first batch** (23 Oct 2026; 24 variants fixed in advance, picked on 2020-01 →
2024-06 by return per unit of drawdown, judged once on 2024-07 → 2026-10; the bot simulation came out at
€13,146 / −29.9 % since 2020 against €12,757 / −30 % here):

| €1,000 | Selection 2020-01 → 2024-06 | Hold-out 2024-07 → 2026-10 |
|---|---|---|
| **Bot as deployed** | €7,107 · +55 %/yr · −24 % | **€1,850 · +31 %/yr · −23 %** |
| Momentum rotation, top 5 of 20 by 30-day return | €5,930 · +49 % · −61 % | €539 · **−23 %** · −67 % |
| BTC + ETH trend, full allocation, 40 % vol target | €7,423 · +56 % · −27 % | €1,158 · +7 % · −23 % |
| Dual momentum BTC / ETH / SOL | €33,497 · +118 % · −56 % | €897 · −5 % · −46 % |
| Funding carry BTC + ETH (market neutral) | +11 %/yr · −0.3 % | +4 %/yr (Binance funding +1.6 %, Hyperliquid +5.4 %) |
| BTC bought and held | €8,700 · +62 % · −77 % | €1,293 · +12 % · −53 % |

The dual-momentum figure depends on SOL being on its list with hindsight; chosen point in time it ends at
€2.4k at −77 %. Momentum rotation beat random coin picks from the same list but the whole alt list sank. The
volatility-targeted trend was positive in both windows yet earned less than the bot in each and moves with it
(correlation 0.75). Funding carry is a different return stream (correlation 0.19) but paid ~10 %/yr only in
2020–21 and 0–5 % since — in bull markets, when the bot is already invested; on the bot's idle cash it added
+1.4 points a year before mid-2024 and cost −1.4 after. Nothing here earns more per unit of drawdown than
the deployed rules.

**Third batch — filters against chop, dynamic risk, cross-asset momentum** (23 Oct 2026; 27 variants fixed in
advance, same split). The bot at 2 % on the hold-out: **€1,928, +33 %/yr, −23 %**. Market-chop filters (BTC
ADX > 20 / 25, share of the top 30 above their 50-day average > 50 / 60 %), leaders-only (beats BTC over 30 or
60 days), weekly confirmation, re-entry after a stop, and dynamic risk 2–5 % (by trend strength, after wins,
by the strategy's own equity curve) — none beat it. Every gate's removed trades had a *positive* average R in
both windows: the filters mostly threw winners away. The best hold-out row, breadth > 50 % at 2 % (€2,053,
+37 %/yr, −20 %), trailed the bot on the selection window and leads by one trade's worth. Cross-asset dual
momentum (the better two of BTC, QQQ, gold, long bonds over six months) made +24 %/yr at −17 % on the
hold-out and does not move with the bot — worth paper trading, not yet deploying. And 5 % risk with a 50 % cap
on ten coins again swung from +89 %/yr to −14 %/yr depending on which two or three coins got the cash.

**Everything connected — the combined test** (23 Oct 2026; 21 allocations fixed in advance across six
sleeves with their own capital: the bot, a BTC + ETH book at 5 %, cross-asset dual momentum, funding carry,
US stock trend, 12-ETF trend; picked on 2020-01 → 2024-06 by return per unit of drawdown, judged once on
2024-07 → 2026-10). The pick, a quarter each in the bot, the BTC + ETH book, dual momentum and US stocks:

| €1,000 | Selection | Hold-out | Full 2020 → 2026 | Worst month |
|---|---|---|---|---|
| **Bot alone** | €6,701 · +53 %/yr · −31 % | **€1,928 · +33 % · −23 %** | **€12,922** · +46 % · −31 % | −22 % |
| Four sleeves, 25 % each | €5,195 · +44 % · −22 % | €1,627 · +24 % · **−15 %** | €8,197 · +36 % · −26 % | −15 % |

Combining cuts the drawdown by about a third and made a little more per unit of drawdown on the hold-out —
but **less money in every window**: none of the 21 allocations beat the bot alone in euros. What it buys is
independence from one trade: without the November 2024 XRP trade the bot's hold-out falls to +8 %/yr, the
combination's only to +17 %. The bot's own BTC + ETH book is no diversifier (correlation 0.7–0.8); dual
momentum, US stocks and ETFs are (0.1–0.5). So the bot stays as it is for the most money; the combination is
the steadier option for someone who wants smaller drops and accepts ~9 points a year less.

**The user's plan: BTC + ETH at 5 %, every other coin at 2 %** (one account, the bot's real universe — top
10 point in time — max 5 positions; BTC and ETH positions up to 50 % of the account, the rest up to 25 %):

| €1,000 at the end of | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 23 Oct 2026 |
|---|---|---|---|---|---|---|---|
| **Bot today, everything at 2 %** | €2,111 | €4,688 | €4,677 | €7,112 | €9,633 | €9,919 | **€12,922** |
| BTC + ETH 5 %, the rest 2 % | €2,579 | €6,241 | €6,227 | €10,235 | €11,643 | €9,963 | €10,893 |
| BTC + ETH 3 %, the rest 2 % | €2,404 | €5,737 | €5,724 | €9,308 | €13,579 | €13,080 | €15,470 |

Ahead until 2023, behind since: on the 2024-07 → 2026-10 hold-out the plan made −1 %/yr against the bot's
+33 % (3 % on BTC + ETH: +24 %). The reason is cash, not the coins: in October 2024 a BTC position at 5 % risk
took half the account, so in November there was no cash for the XRP breakout that made the bot's year
(+€527); BTC + ETH themselves earned *less* at 5 % than at 2 % over that stretch (+€118 against +€145),
because their losing trades were bigger too. With idle cash at 4 % the picture is the same (hold-out €1,045
against €2,053).

**Chosen for the paper run (23 Oct 2026): BTC + ETH at 3 %, the rest at 2 %** — the most money since 2020
(€15,470 against €12,922) at the same worst drop (−32 %), less on the hold-out (€1,656 against €1,928). Set it
with `--core-risk`:

```bash
python3 trader-autopilot/autopilot.py profile --risk 2 --core-risk 3 --capital 1000 --fixed-risk --write
```

`--fixed-risk` matters: the trend breakout's profit chance in today's lab is 67 %, under the 70 % tier, so
without it the bot halves every breakout — BTC and ETH would trade at 1.5 %, the rest at 1 %, not the split the
backtest ran. With it the risk is exactly 3 % / 2 % (7 losses in a row still halve it, a −35 % drawdown still
pauses the bot). Re-run on the pack's own lab trades (23 Oct 2026, median of 30 signal orders, 0.28 % a
side, 4 % on idle cash, ETF leg on): coins chosen point in time, 2 % everywhere **€12,758 · −30 %**; the split
**€15,452 · −30 %**; last 3 years €2,221 vs €2,132, last 12 months €1,133 both (three crypto trades).

It writes `risk_by_symbol {"BTC": 3, "ETH": 3}` to config.json and `crypto.symbols.{BTC,ETH}` to limits.json
(3 % per trade, a position up to 50 % of the account, a $ backstop at 4× the account); every other coin keeps
2 % and 25 %. The sizer, the risk check and the replay all read the coin's own entry; a losing streak or a
less sure lab scales BTC's 3 % the same way it scales the 2 %, and `playbook.max_risk_pct` (2) never cuts
BTC below its own 3 %. The daily loss stop becomes 5 × 3 % = 15 %. A DEX token that calls itself BTC never
gets the core risk. `--core-coins` names other coins; a re-run without `--core-risk` removes the split.

**Where all this leaves the bot** (94 variants in five pre-registered studies plus the lab, 23 Oct 2026): the
deployed daily trend rules at 2 % risk on the top 10 coins point in time had the best return per unit of
drawdown of everything tested and the most money of everything without hindsight; nothing else held up on
the 2024–2026 hold-out by more than one trade's worth. Realistic expectation: +20 to +35 % in a year with a
crypto trend, 0 to +8 % without one, drawdowns of −25 to −35 %. The free improvement is the cash: 4 % a year
on idle money turned the €12,922 into €15,490 since 2020 — in the simulator that is `cash_yield_pct`; at a
broker it means holding a T-bill fund (e.g. SGOV) with the idle cash yourself.

Three things these numbers show:
* **The lab gate is strict.** From October 2025 to March 2026 the weekly lab validated no crypto pair at
  all, and the ETF lab validated nothing all year — the bot sat in cash. That is the design (no edge proven
  on unseen data → no trades), and it is why the bot can lag a backtest that trades everything.
* **The dollar backstop.** `profile` writes $ limits at 4× your capital (a guard against a misread equity).
  Once the account has grown past 4×, they cap the risk (€14,851 instead of €44,436 since 2020 in the
  hindsight row). The bot now says so in its notes and once by notification; re-run
  `autopilot.py profile --capital <your equity> --write` when it does.
* **Leverage 1.5× adds nothing here** (€37,661 vs €44,436 since 2020) and Alpaca has no crypto margin anyway.

**€1,000 with the bot's own rules — older estimate, see above** (2 % risk, BTC 200-day switch, 10 biggest
coins incl. DOGE, costs 0.13 % and 10 %/yr borrowing cost included — the past, not a forecast):

| | 1× | 1.5× | 2× | worst drop |
|---|---|---|---|---|
| Since 1 Jan 2020 | €11,689 (+44 %/yr) | €12,332 (+45 %/yr) | €12,585 (+45 %/yr) | −30 % |
| Last 3 years | €1,878 (+23 %/yr) | €1,954 (+25 %/yr) | €1,937 (+25 %/yr) | −30 % |
| Last 12 months | €1,098 | €1,111 | €1,106 | −6 % |

What did *not* make it into the profile: the default learning rules on this strategy (3-loss halving,
pause at −10 %) cut the 2020 result to €8,367 with 12 pauses; 43 coins at 2 % risk and 10 positions
fell −69 % at worst; adding the stock breakout with leverage deepened the worst drop to −38…−48 %, so
stocks stay at 1×; on BTC + ETH alone leverage adds nothing (+15 %/yr, −16 %). Leverage helps a little
here only because a tight stop sometimes wants a bigger position than the cash allows. The 10 biggest
coins are picked with today's knowledge, which flatters the past. Not modelled: the bot also trades
only the coin + setup pairs the lab validated and halves the size where it is less sure.

### Let winners ride — sell a third, keep two thirds while the coin keeps rising

When a trend breakout's exit rule fires (a daily close below the 10-day low) **and the trade is in profit
and the coin is still above its 200-day average**, the bot sells only a third. Two thirds stay in until the
trend itself breaks — a daily close below the 50-day EMA — and their stop moves to the buy price, so that
part can no longer turn into a loss. A loser, or a coin below its 200-day average, is sold in full as
before. The bot says what it holds and what it will do next in plain words (`autopilot.py status`, the
dashboard's position cards, the phone notification), and it books the sold third and the riding two
thirds as two journal trades.

How it was chosen: 10 ways to do it (a third / half / two thirds × until the 20-day EMA / 50-day EMA /
100-day average, or not at all) were compared on the 10 biggest coins **from mid-2018 to the end of 2022
only**, by growth per unit of worst drop. The winner was then checked where nobody looked while choosing:

| Check (median of 30 random signal orders) | Sell everything | Two thirds ride |
|---|---|---|
| 10 biggest coins, 2023 → now | €2,375 · drop −29 % | €2,487 · drop −28 % |
| 33 other coins, mid-2018 → now | €7,728 · drop −58 % | €9,351 · drop −50 % |
| 33 other coins, 2023 → now | €3,372 · drop −55 % | €3,579 · drop −50 % |
| BTC + ETH only, mid-2018 → now | €4,732 · drop −18 % | €4,924 · drop −18 % |
| The lab's own walk-forward (top 10 by volume, 2018–2026) | +0.97R per trade, 93 % profit chance | +1.42R, 92 % — better in all 3 periods |

Every week the lab re-checks it on unseen periods; when riding on stops paying (more R per trade without
costing more than 3 points of profit chance), the bot goes back to selling everything by itself
(`autopilot.runner.require_lab`).

**€1,000, profile + two thirds ride — older estimate, incl. DOGE; see the re-check above** (10 biggest
coins, 2 % risk, median of 30 signal orders — the order of same-day signals alone moves a result by ±20 %):

| | Sell everything 1× | Two thirds ride 1× | Two thirds ride 1.5× | worst drop |
|---|---|---|---|---|
| Since 1 Jan 2020 | €12,092 | €38,444 (+71 %/yr) | €42,567 | −29 % → −47 % |
| Since 1 Jan 2022 | €2,375 | €2,487 (+21 %/yr) | €2,803 | −29 % → −28 % |
| Last 3 years | €1,699 | €1,773 (+21 %/yr) | €1,914 | −29 % → −28 % |
| Last 12 months | €1,079 | €1,126 | €1,165 | −6 % → −7 % |

Year by year (1×, median): 2019 +18 → +20 %, 2020 +95 → +106 %, **2021 +179 → +649 %**, 2022 −1 → −1 %,
2023 +54 → +68 %, 2024 +45 → +33 %, 2025 −6 → 0 %, 2026 so far +4 → +5 %. Most of the extra money came
from one euphoric year; it gives part of such a run back before the 50-day EMA breaks, which is why the
worst drop since 2020 grows to −47 %. In quieter years it adds a little.

**What to expect, start on any week since mid-2018** (two thirds ride, 1×; 382 one-year and 278
three-year windows):

| After | Typical | 1 year in 10 is worse than | 1 in 10 is better than | In profit |
|---|---|---|---|---|
| 1 year | €1,210 | €957 | €4,915 | 80 % of starts |
| 3 years | €3,117 | €1,819 | €17,979 | 100 % of starts |

The typical year is about +20 %; the averages are pulled up by rare years like 2021. On BTC + ETH alone
the typical year is +10 % (3 years: €1,545) with drops under −20 %.

### The checks — six desks, "is it normal?", backtest vs reality

`autopilot.py check` and the dashboard's **Checks** tab:

* **Six desks per decision** — every signal the bot judged, laid out as Research (lab result, sample,
  confidence) · News (filings, hacks, the feed) · Strategy (exit plan, the runner) · Execution (fresh
  signal, leverage, buying power) · Risk (every `limits.json` check, what it learned) · Boss (desk verdict,
  the optional AI veto) — each ✓ / ✗ with what it checked, and the call: BUY, WOULD BUY (dry run) or REJECT
  with the desk that stopped it.
* **Is it normal?** (`shared/health.py`, every cycle) — the bot's closed trades against the lab's
  out-of-sample trades, replayed 2,000 times in blocks of 20 consecutive trades (trades cluster: a crash
  stops several positions out the same week). Three checks — the longest losing streak and the sum of the
  last 30 trades, and the deepest drawdown — each say how often a history was at least that bad. Worse
  than 9 histories in 10 → **alarm**: new entries pause until you resume (exits keep running).
  Calibrated on the bot's own simulated trade sequences 2018–2026 (5 positions, 10 signal orders): a false
  alarm 0.2–0.7 % of the time (about once in 5–8 years); a strategy that loses (20 % winners) caught 10 of
  10 times after ~16 trades; one with no edge left caught only 3 of 10 times within 40 trades. **Results
  alone are slow to prove anything** — with ~40 trades a year, telling "no edge" from "a normal bad
  stretch" takes years, which is why the lab's eight years of walk-forward tests come first and this check
  is a safety net for clear breakage (a bug, a market that changed).
* **Backtest vs reality** (`shared/shadow.py`, once a day) — the daily rules recomputed for the last 30
  days on every validated coin and ETF, matched with what the bot recorded: taken (with the entry's
  slippage against the signal), skipped (with the reason), **missed** (no record — the bot was down or data
  failed) or **extra** (a trade the rules don't explain). Missed, extra, errors or slippage above twice
  the assumed cost → "check" and a phone notification.

### The meme-coin sniper — tested, no edge found

`/trader-sniper`'s own rules replayed on 61 days of pump.fun history (22 Aug – 21 Oct 2026, 3,366 coins
sampled evenly per day from the Solana chain, dead and rugged ones included; €10 a trade, €100 cap, fees and
price impact): **137 trades, 25 % won, −25 % a trade, −€339** (90 % range −€460 … −€223). Best case — every
stop filled exactly at its price — about break-even (−€6). Buying every coin 10 minutes after launch: −€1,594.
One day of new pools forward (Solana, BSC, Base): break-even at best. The real sniper on paper, live data,
the same afternoon: 3 trades, 3 losses (−$17.51), two rugged minutes after a +60 % run.

**The moonbag ladder** — watch a coin after it graduates, buy €10 if it holds up, sell half at every
doubling, keep the last part for free, next coin — on the same coins and their whole life since (up to 60
days): **0 of 128 variants ahead**. The plain version lost €4.51–6.05 a €10 trade; a €100 wallet was down to
€2–10 within days. Only a third of the coins it buys ever double, and what is kept after selling half is
almost always worth nothing later. Details, caveats and how to re-run both: `trader-sniper/research/README.md`.

Also tested on the same history, all behind after costs: a partial at +20 % with the rest kept (0 of 216
variants), buying right after graduation and selling at +30 %, coins still trading days later, ~45
selection features, copying "smart" wallets, being first after the launch as an outsider, and three ChatGPT
playbooks — scalping −0.66R, intraday −0.63R and swing −0.30R a trade on the period they were not chosen on.

So the sniper stays on paper until its **own paper record pays** — at least 30 paper trades in the last 30
days, ahead in total — before live trading can start (`sniper.live_needs_paper_proof`, on by default).

### Bear markets — what was tested, what the bot does

The crypto strategies only buy while Bitcoin is above its 200-day average, so in a bear market they sit in
cash: 2018 and 2022 ended at 0 % and −1 % while Bitcoin fell 73 % and 65 %. Earning *in* those years was
tested on the same data, rules fixed in advance:

| Idea | Result |
|---|---|
| Short crypto (mirror of both trend rules, 10 %/yr carry), Bitcoin below its 200-day average | +0.02R per trade on the 10 biggest coins, −0.03R on 33 others; wins in 2018 and 2026, loses in the corrections of 2021, 2023 and 2024 |
| … only in a "death cross" (50-day below 200-day) | +0.08R up to 2022, −0.10 to −0.23R since 2023 — not adopted |
| … BTC + ETH only | +0.23R, but 57 trades in eight years; through Alpaca only as BITI (−1× Bitcoin, US hours), which lost 18 % on the same 15 signals the futures short gained 9 % on — not adopted |
| Buy the dips in a bear market (RSI(2) < 10 below the lower band) | −0.07R, 58 % wins — loses |
| Inverse ETFs (SH, PSQ, BITI) with the trend rules | −0.25 to −0.35R — bear-market rallies and decay |
| Stocks with the trend rules | +0.13 to +0.27R overall, but negative in 2018 and 2022 |
| **Trend rule on ETFs that move unlike crypto** (gold, dollar, commodities, bonds, energy, indexes) | +0.28R per trade, positive in 2022 (+0.51R); the lab holds it in all 3 walk-forward periods |
| **Idle cash in T-bills** | 2 % (2018, 2022) to 5 % (2023–24) a year on whatever is not invested |

So the bot (trend profile) now does both of the last two: **while Bitcoin is below its 200-day average,
it trades the daily trend rule on the ETFs the ETF lab validated** (`lab.py --etf`; today gold, the dollar,
commodities, tech and semiconductors), held for days with a GTC bracket at the broker and sold at the
first daily close below the 50-day EMA during market hours; and in the simulator idle cash earns
`cash_yield_pct` (T-bills). At Alpaca, idle cash earns what your account pays — holding a T-bill ETF
(SGOV) yourself is the manual equivalent.

**€1,000 started on any week since mid-2018 — older estimate, 0.13 % costs; see the re-check above** (382
one-year, 278 three-year windows; 2 % risk, 1×):

| | Crypto only | + T-bills | + ETF trend in crypto bear markets |
|---|---|---|---|
| After 1 year, typical | €1,210 | €1,229 | **€1,293** |
| … 1 year in 10 is worse than | €957 | €973 | €982 |
| … in profit | 80 % of starts | 84 % | **86 %** |
| After 3 years, typical | €3,117 | **€3,357** | €3,276 |
| … 1 in 10 is worse than | €1,819 | **€1,952** | €1,714 |
| 2022 (crypto −65 %, stocks −20 %) | €1,000 | €1,020 | **€1,125** |
| Crypto winter mid-2018 → spring 2019 | €1,000 | **€1,017** | €999 |
| Last 12 months | €1,126 | **€1,163** | €1,104 |

**The same, with the coins chosen point in time** (each trade only on a coin among the 10 biggest by
30-day dollar volume on the day it was entered, delisted coins included, no meme coins — 46 different
coins took part; 21 Oct 2026):

| | Crypto only | + T-bills | + ETF trend in crypto bear markets |
|---|---|---|---|
| After 1 year, typical | €1,234 | €1,260 | **€1,293** |
| … 1 year in 10 is worse than | €964 | **€984** | €946 |
| … in profit | 81 % of starts | **87 %** | 85 % |
| After 3 years, typical | €3,161 | €3,385 | **€3,460** |
| … 1 in 10 is worse than | €2,179 | **€2,322** | €1,943 |
| 2022 (crypto −65 %) | €1,000 | €1,020 | **€1,125** |
| Last 12 months | €1,292 | **€1,334** | €1,116 |

The earlier tables used a fixed list of today's large coins; chosen point in time, the average trade
falls from +0.95R to +0.86R and the typical results move by a few percent — the portfolio rules (big
coins only, 2 % risk, 5 positions) were already fairly robust. Costs here are 0.13 % per side; at Alpaca's
0.25 % crypto fee every trade costs about 0.25 % more.

Honest reading: T-bills help every year a little. The ETF rotation is the only thing that earned in a
real bear year (2022: +12.5 %) and makes one-year results better, but it did nothing in the 2018 crypto
winter, cost a little in the last 12 months, and makes the worst three-year case worse. `profile` turns it
on; `--no-etf` keeps the bot in cash and T-bills instead.

### Why the last 12 months look weaker — and why it isn't the bots

| Period | BTC | BTC volatility | Days BTC above its 200-day average | Big alts beating BTC | Coins moving together (corr.) |
|---|---|---|---|---|---|
| 2018 (after the Dec 2017 peak) | −73 % | 83 % | 2 % | — | 0.75 |
| 2021 | +60 % | 81 % | 71 % | 8 of 9 | 0.50 |
| 2022 (after the Nov 2021 peak) | −64 % | 64 % | 0 % | 5 of 9 | 0.72 |
| 2024 | +121 % | 53 % | 80 % | 4 of 9 | 0.49 |
| 2025 | +18 % | 42 % | 87 % | 2 of 9 | 0.67 |
| **Last 12 months** (after the Oct 2025 peak) | **−25 %** | **44 %** | **20 %** | **1 of 9** | **0.72** |

* **It is the year after a Bitcoin cycle peak**, like 2018 and 2022 (halvings 2016, 2020, 2024; peaks
  17–18 months later: Dec 2017, Nov 2021, 6 Oct 2025 at $124,659, then a bear year). Bitcoin was above
  its 200-day average on only 20 % of the days, so the bot was in cash most of the year: one trade from
  November to August, then everything after Bitcoin crossed back above the line on 20 Aug 2026 — a profitable
  burst, followed by a choppy September of small losses. In the same 12 months after the previous peak the
  strategy lost 10 % (€905); this time it made 8 % (€1,084, €1,120 with T-bills) while holding Bitcoin
  would have left €686.
* **Altcoins stopped leading:** 1 of the 9 big alts beat Bitcoin (2025: 2 of 9; 2021: 8 of 9) and they
  move together as tightly as in bear markets (0.72), so more coins don't mean more chances.
* **Bitcoin got calmer** since the spot ETFs (2024): 42–53 % yearly volatility against 64–83 % before —
  smaller trends, smaller wins (average winner +1.2R in the last 12 months, +3.8R in 2024).
* **Not the bots:** daily trends did not get weaker — the 20-day variance ratio and the day-to-day
  autocorrelation are in their usual range, and breakouts above the 20-day high followed through *better*
  than usual (54 % higher after 10 days, +12 % after 20, the fewest false breakouts: 43 %). Automation does
  show where you would expect it: in seconds-to-hours patterns — every one-day setup on 5-minute bars
  lost after costs. Multi-week trends come from money moving (ETFs, the cycle, macro), which bots don't
  remove.
* Tested against it, not adopted: at most 1–3 new crypto entries a day (the coins move together) — better
  before 2023, worse since and −4 % in the last 12 months; a slower switch (50-day above 200-day average)
  — worse in every period.

In short: a high *win chance* is easy and loses money; the edge that survives is the oldest one in
crypto — follow Bitcoin's trend and let the few big winners run. 40 % of its trades win, but the
average win is about 4× the average loss, so the chance of being up after 20 trades is ~80 % (~94 % on
BTC + ETH alone, 2019–2026). History, not a promise: the coins tested are today's survivors, and the
strategy sits out whenever Bitcoin is below its 200-day average (all of 2022, for example).

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
keep failing, and stops cleanly on SIGTERM. A cycle stuck for 20 minutes restarts the process (systemd /
Docker bring it back); an order sent just before a crash is found again by its client id, never sent twice.
It also keeps its folder small for years: old downloads are deleted, finished records move to
`trader/archive/` after 45 days, big logs are gzipped, and under 1 GB of free disk it tells you (under 200 MB
it opens nothing new, but keeps managing exits).

**Phone notifications:** set `notify.enabled: true` and either an [ntfy](https://ntfy.sh) topic (free
app, no account — use a long random topic name) or your own Telegram bot. You get trade opened/closed,
kill switch, drawdown pause, what it learned, repeated errors and a daily summary after the US close.
`autopilot.py notify-test` checks the setup.

## Dashboard

A local web app over the `trader/` folder (stdlib server, no CDN, dark/light, built for phones):
Overview (**Is everything OK?** — is the bot running, is it normal, did it follow its rules, how much
risk is in use — then equity curve, P&L today/total, win rate, expectancy, open positions with a
stop → entry → target bar, latest decisions, top news, desk verdicts) · Trades (every trade with a candle chart, entry/exit, stop/target, R, fees) · Bot
(status, pause / resume / run once / KILL, mode and what live would need, gates, decision timeline,
the universe with reasons, what it learned, notifications, AI desk spend) · Checks (where the bot's
results sit among the backtest's histories, every daily signal matched with what the bot did, each
idea through the six desks) · Brain · News (X, StockTwits, news, SEC with importance and sentiment) ·
Setups · Reports · Help (quick answers, your data & privacy, terms of use & risk). On a phone: a tab bar
with Overview, Trades, Bot, Checks and More; "Add to Home Screen" installs it like an app (web manifest
and icons). Every tab has its own title, text meets WCAG AA contrast (checked with axe on every tab, phone
and desktop), unknown addresses get a real 404 page, and search engines are told to stay out
(`robots.txt`, `noindex`). No analytics, no trackers, nothing loaded from other sites; the only cookie is
the sign-in session, so there is no cookie banner. The app's files are gzipped and cached until they change.
The design lives in Figma ("Trader — dashboard redesign": tokens, components, desktop and phone
screens); `app/static/app.css` uses the same tokens.

Security: binds to 127.0.0.1 unless you give a password; without one it answers only to `localhost` /
`127.0.0.1` (a web page can't reach it through DNS rebinding — add other names with
`TRADER_DASHBOARD_HOSTS`); every button needs a per-session CSRF token; password guesses are checked one
at a time; no response ever contains a key; reports are served sandboxed; live trading cannot be switched
on from the dashboard. KILL reaches a running daemon within seconds. `python3 app/devdata.py --home /tmp/trader-sample` writes clearly-marked SAMPLE data.

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
autopilot (24/7):          own universe → crypto only from the lab's playbook → the same chain + just-in-time news & filings + its own record → DESK (+ AI veto) → size by certainty → orders only on GO + risk PASS
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
* **Leverage magnifies a gap too.** A stop is a promise, not a guarantee: a crash through it at 1.5×
  loses 1.5× as much of the account as the same gap without leverage. The simulator charges interest
  but no margin calls.
* **The backtest lab tests many ideas;** every extra idea raises the odds that one passes by luck.
  Walk-forward over three periods and pooling all coins make that much harder, not impossible — trade
  anything it validates on paper first. Costs and fills are modelled, not measured.
* **The lab is more optimistic than the bot can be — know by how much.** Since v3.10 it scores the trend
  setups together, one position per coin (a coin held by one setup, until its two thirds stop riding, is
  skipped by the other) — before, `trend_ema` and `trend_breakout` counted trades the bot never makes and
  the combined edge was about +0.9R per trade, not the +1.4R / +0.55R shown one by one. What it still does
  not model: the 5-position and 100 % exposure caps (the portfolio re-check above does — it skips about a
  third of the signals, the better ones, because they cluster in strong runs). The trend rules were designed
  on the same 2018–2026 history; the runner was chosen on 2018–2022, so since v3.10 the lab judges it only
  on trades after 2022 (+0.09R per trade there, not the +0.37R the whole history suggests). The profit
  chance draws runs of trades (losses cluster), never longer than a quarter of the sample — a coin with
  16 trades no longer reads "100 %". ETFs are priced at the next open (the bot sees the daily bar only
  then), daily crypto entries may pay up to a quarter ATR above the close and keep working for an hour.
* **Your own coins at the same broker:** the daily-loss limit takes out what your own holdings moved today,
  so your BTC falling doesn't trip it. Cash can't be told apart: a deposit or a withdrawal still moves it, and
  the drawdown pause (equity against its peak) still sees your own holdings — keep them in another account if
  they are large next to the bot's.
* **Small accounts can't hold most ETFs.** Alpaca brackets need whole shares and the stock cap is 25 % of
  the account: with €1,000, SPY, QQQ, IWM, DIA, GLD and SMH round to 0 shares and are skipped, and the rest
  risk 0.1–1.5 % instead of 2 %. The ETF projections above assume the full 2 %.
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
  trader-desk/ trader-arb/ trader-autopilot/ trader-sniper/
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
