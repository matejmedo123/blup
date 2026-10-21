---
name: trader-autopilot
description: Let Trader trade for the user around the clock — a 24/7 autopilot that picks its own universe (liquid US stocks ranked by today's movement plus the most active names; the most traded coins), and for every fresh setup runs the exit plan, backtest, Time Machine, the latest news and SEC filings, the rule-based desk and optionally a Claude AI desk (veto only), then sizes, risk-checks and places the order itself (local simulator or Alpaca paper by default, live only after an explicit opt-in), manages exits, journals every fill, learns from its own record and sends phone notifications. Use when the user says "trade for me", "run the bot 24/7", "start / stop / pause the autopilot", "kill switch", "what did the bot do today", "what is it watching", "what did it learn", "replay today with the autopilot", "deploy it on a server", or "go live".
---

# Trader · Autopilot (trades for you — within every gate, around the clock)

The user asked for a bot that trades on their behalf, 24/7, watches many stocks and coins, decides by
itself and keeps an eye on news, filings and its own record. This is it — with the same discipline as
the manual workflow, applied mechanically on every cycle (default every 60 s):

**When it trades:** crypto **24/7**; US stocks in the **regular session** only (new entries
9:30–15:30 ET = 15:30–21:30 in Bratislava, flat by 15:55 ET). Pre-market, after-hours and overnight
stock sessions are deliberately not traded: every stock setup and backtest here is built on
regular-session bars, extended-hours liquidity is thin and brokers only take plain limit orders there.
Outside the session the daemon keeps trading crypto, refreshing news and filings and rebuilding the
stock universe for the next open.

1. **Controls** — `trader/autopilot/control.json` (dashboard or CLI): *pause* stops new entries
   (exits and time stops keep running), *kill* cancels every order and closes every position,
   *run once* forces a cycle.
2. **Sync** the broker → `broker/positions.json`, `broker/orders.json`, `broker/equity.jsonl`;
   fills become journal entries (`source: "autopilot"`, real fill prices); exits close them.
3. **Exits** — stocks flat by 3:55 p.m. ET; crypto: protective stop after the fill, target and
   4h horizon managed by the bot (Alpaca has no crypto brackets); stocks use bracket orders.
4. **Kill switch** — realized + unrealized loss today ≥ `limits.global.max_daily_loss_usd` → flatten and stop.
5. **Learning from its own record** (`autopilot/adapt.json`): a setup whose autopilot trades lost
   (≥ 8 trades, net expectancy ≤ −0.25R) is paused for that asset class for 7 days; a symbol with 3
   losses in a row sits out 5 days; 3 losing trades in a row overall → half the risk per trade until
   the next win; equity 10 % below its peak → the bot pauses itself (resume resets the peak).
6. **Its own universe** (`autopilot/universe.json`, `autopilot.universe.mode: "auto"`): ~150 liquid US
   stocks ranked by today's gap + move (top 40) plus Yahoo's most active / day gainers above $2B market
   cap, and the 20 most traded coins (no stablecoins or wrapped tokens; only what the broker can trade) —
   always including your watchlists, never anything in `exclude` or `blocked_symbols`, **never meme
   coins**. Each symbol is scanned once per closed 5-minute bar within a per-cycle time budget.
7. **Crypto only from the backtest lab** (`autopilot.playbook`): a coin is traded only with a setup,
   timeframe (5m, the 1h / 4h swing setups, or the daily trend breakout / dip-in-uptrend, which only
   trade while Bitcoin is above its 200-day average) and exit the lab validated on data it never saw
   (`trader-backtest/lab.py` → `backtests/playbook.json`, re-run weekly by the daemon). No fresh
   playbook, or nothing validated → no crypto trades. Size follows certainty: the lab's profit chance on
   unseen trades ≥ 90 % → risk × 2, ≥ 80 % → × 1.5, ≥ 70 % → × 1, lower → × 0.5 (a boost needs ≥ 30
   unseen trades; `limits.json` caps always win). Daily setups close on their rule (e.g. the first daily
   close below the 10-day low), checked after every daily close, with a 3×ATR protective stop; when
   several signals fire together, the most certain are taken first. Positions can last weeks, so the
   defaults allow 5 crypto and 5 stock positions (10 in all, crypto exposure up to 50 %).
8. **Fresh triggers** → entry → exit plan → backtest of that rule on that symbol → Time Machine →
   **latest news and SEC filings for that symbol, fetched right before judging** → rule-based desk
   (`desk.py auto`; a fresh dilution/offering, bankruptcy, delisting or restatement filing, or a hack /
   delisting headline for a coin, is a critical objection; merger, FDA or change-of-control news is
   major) → optional **AI desk** (Claude reads the case, headlines and filings; it can only veto) →
   sizer → risk check → order. One look per setup per day; every look is written to
   `trader/autopilot/decisions.jsonl` with the reasons.

**A trade happens only if** (crypto) the backtest lab validated that coin + setup, the backtest shows an edge after costs (expectancy ≥ +0.05R over
≥ 10 triggers), the Time Machine does not reject the geometry (EV ≥ −0.05R), no fresh news or filing
blocks it, its own record does not argue against it, the desk says GO (and the AI desk, if enabled,
does not say no), the risk manager says PASS, the daily caps allow it and there is buying power.

## Turning it on is a standing approval

* **Dry run (default):** without approval the bot does all the analysis and logs "would have placed …"
  — no orders.
* **Approval:** `config.json → autopilot.enabled: true`, or `--approve` on the command line, or the
  dashboard started with `--autopilot`. That is the user's standing "yes" for orders that clear every
  gate; each one is recorded in `trader/approvals.jsonl`.
* **Broker:** `autopilot.broker: "simulator"` (default — local paper money, no account) or `"alpaca"`
  (paper by default; needs `ALPACA_PAPER_KEY_ID` / `ALPACA_PAPER_SECRET_KEY` in the environment or
  `trader/secrets.env` — free keys at alpaca.markets → Paper Trading → API Keys).
* **Live money** needs **all** of: `autopilot.broker: "alpaca"`, `autopilot.mode: "live"`,
  top-level `paper: false`, `ALPACA_LIVE_KEY_ID` + `ALPACA_LIVE_SECRET_KEY`, and
  `autopilot.live_confirmation: "I ACCEPT REAL MONEY RISK"`. Missing any → the bot refuses to start and
  lists what is missing (`autopilot.py check-live`). It never switches to live on its own.

> **Be honest with the user:** most setups in this pack show **no edge** in their backtests (TSLA
> opening-range breakout −0.12R per trade, BTC Asia-range breakout negative). Trading a strategy with
> no edge loses money, automated or not. Run the simulator or Alpaca paper for weeks first, and only
> consider live if the journal shows a positive edge **net of costs** over a meaningful sample
> (dozens of trades, not a lucky week).

## Run

```bash
python3 "${CLAUDE_SKILL_DIR}/autopilot.py" daemon --approve      # 24/7: one per trader/ folder, stops cleanly on SIGTERM
python3 "${CLAUDE_SKILL_DIR}/autopilot.py" status                # incl. heartbeat (alive?), sessions, universe, learned
python3 "${CLAUDE_SKILL_DIR}/autopilot.py" universe [--refresh]  # what it watches and why
python3 "${CLAUDE_SKILL_DIR}/autopilot.py" learned               # what its own trades taught it
python3 "${CLAUDE_SKILL_DIR}/autopilot.py" notify-test           # send a test notification
python3 "${CLAUDE_SKILL_DIR}/autopilot.py" run --once            # one cycle (dry run unless enabled/--approve)
python3 "${CLAUDE_SKILL_DIR}/autopilot.py" loop --approve        # keep trading every autopilot.interval_sec
python3 "${CLAUDE_SKILL_DIR}/autopilot.py" pause | resume
python3 "${CLAUDE_SKILL_DIR}/autopilot.py" kill --confirm KILL   # cancel everything, close everything
python3 "${CLAUDE_SKILL_DIR}/autopilot.py" check-live
# offline: replay the fixture day in the simulator (NVDA taken, TSLA/BTC skipped with reasons)
python3 "${CLAUDE_SKILL_DIR}/autopilot.py" replay --from 2026-10-20T13:35:00Z --to 2026-10-20T20:00:00Z --approve --offline
```

Or let the dashboard run it: `python3 app/server.py --autopilot` (calls `run_cycle(approved=True, runner="dashboard")`).
For a server, run the daemon and the dashboard as two services — see `deploy/` (Docker Compose or
systemd, plus a step-by-step guide in Slovak, `deploy/NAVOD.sk.md`).

| Option | Meaning |
|---|---|
| `--approve` | standing approval for this run (else `autopilot.enabled` decides; else dry run) |
| `--interval SEC` | loop period (default `autopilot.interval_sec`, 60) |
| `--max-cycles N` | loop/daemon: stop after N cycles |
| `--refresh` | universe: rebuild it now |
| `--from/--to/--step` | replay window and clock step (default 5m) |
| common | `--offline --now --home --json` |

Config (`trader/config.json → autopilot`): `universe` (`mode` auto|watchlist, `stocks.top_n`,
`stocks.include_movers`, `crypto.top_n`, `crypto.min_volume_usd`, `always`, `exclude`), `watchlist`
(watchlist mode), `setups` per asset, `gates` (`min_backtest_triggers`, `min_backtest_expectancy_r`,
`min_tm_ev_r`, `tm_paths`, `max_trigger_age_bars`), `scan_time_budget_sec`, `playbook`
(`required_for_crypto`, `max_age_days`, `auto_refresh_days`, `top`, `min_target_r`, `confidence_sizing`,
`risk_tiers`, `max_risk_mult`, `boost_min_test_trades`), `news_gate`
(`lookback_hours`, `critical_tags`, `major_tags`, `min_credibility`, `refresh_before_trade`), `adapt`
(`min_trades`, `disable_below_r`, `cooldown_days`, `symbol_loss_streak`, `loss_streak`,
`loss_streak_risk_mult`, `max_drawdown_pct`), `max_new_trades_per_day`, `flatten_on_kill`,
`sim_starting_cash`. Top level: `notify` (ntfy topic / Telegram, events, `daily_summary_et`) and
`ai_desk` (`enabled`, `model`, daily call and USD budget, `on_unavailable`).

## Notifications on the phone

`notify.enabled: true` plus either `notify.ntfy_topic` (install the free **ntfy** app and subscribe to
the same long random topic — anyone who knows the topic can read it) or `notify.telegram: true` with
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `trader/secrets.env`. Events: started / stopped, trade
opened / closed, kill switch, paused (drawdown), learned (setup paused, risk reduced …), repeated errors
and a daily summary at 16:10 ET. Everything is also logged to `trader/notifications.jsonl`; offline runs
never send anything.

## Optional AI desk (Claude)

`ai_desk.enabled: true`, `pip install anthropic` and `ANTHROPIC_API_KEY` in `trader/secrets.env`. For each
trade the rule-based desk already passed, Claude plays Skeptic and Lead over the full case (plan,
backtest, Time Machine, headlines and filings) and can veto it. It never approves a trade the rules
rejected, headlines are treated as untrusted data, and it stops at `max_calls_per_day` /
`max_usd_per_day` (then `on_unavailable` decides: fall back to the rule-based call, or skip). Costs
are logged in `trader/ai_usage.json`.

## Keep it running

It only trades while it runs — during the US session for stocks, around the clock for crypto.
Use a computer that does not sleep, or a small VPS (`deploy/install-vps.sh` sets up two systemd
services; `deploy/docker-compose.yml` does the same with Docker). The daemon writes
`autopilot/heartbeat.json` every cycle — the dashboard shows **alive** / **stale** from it — holds
`autopilot/daemon.lock` so two copies never trade the same account, backs off when cycles keep failing
(and notifies after 5), refreshes the watchlist news feed in the background and compacts
`broker/equity.jsonl` once a day. Minimal systemd unit if you don't use `deploy/`:

```ini
# /etc/systemd/system/trader.service
[Unit]
Description=Trader autopilot (24/7)
After=network-online.target

[Service]
WorkingDirectory=/home/trader/myproject
Environment=TRADER_HOME=/home/trader/myproject/trader
ExecStart=/usr/bin/python3 /home/trader/trader-skill/trader-autopilot/autopilot.py daemon --approve
Restart=always
TimeoutStopSec=120
User=trader

[Install]
WantedBy=multi-user.target
```

(`sudo systemctl enable --now trader`; keys go in `trader/secrets.env` with `chmod 600`.)

## Reads / writes

* reads `config.json`, `limits.json`, `autopilot/control.json`, `secrets.env` (keys only, never echoed),
  `news_feed.json`, `journal.json`
* reads `backtests/playbook.json` (the lab's validated crypto combinations)
* writes `autopilot/state.json`, `autopilot/decisions.jsonl`, `autopilot/book.json`,
  `autopilot/heartbeat.json`, `autopilot/daemon.lock`, `autopilot/universe.json`, `autopilot/scan.json`,
  `autopilot/adapt.json`, `notifications.jsonl`, `news_feed.json` (just-in-time refresh), `ai_usage.json`,
  `broker/positions.json`, `broker/orders.json`, `broker/equity.jsonl`, `broker/log.jsonl`,
  `broker/sim.json` (simulator), `entries.json`, `plan.json`, `backtests/`, `timemachine/`, `desk/`,
  `orders.json`, `approvals.jsonl`, `journal.json`

## How to present results

Lead with the mode (SIMULATOR / PAPER / **LIVE**), status and heartbeat (alive?), then today: trades
opened, realized P&L, open positions; then the latest decisions — taken ones with entry/stop/target,
skipped ones with their first reason; then what it learned (paused setups, risk multiplier, drawdown).
Point to the dashboard for the full picture. Always include the disclaimer.

## Never

* Never auto-trade meme coins, never touch wallets, keys or seed phrases.
* Never switch to live by itself, never edit the live opt-in fields for the user, never print a key.
* Never retry an order blindly — after a timeout it looks the order up by client id first.
* Never exceed the limits in `limits.json` or the autopilot caps; never trade a setup whose backtest
  shows no edge.
* Never let the AI desk or anything learned loosen a gate — they can only make it more careful.
* Never trade US stocks outside the regular session, never auto-trade anything in `exclude` / `blocked_symbols`.
* Never claim the bot will make money.
