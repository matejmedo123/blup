---
name: trader-autopilot
description: Let Trader trade for the user — an autopilot that watches the stock and crypto watchlist, and for every fresh setup runs the exit plan, backtest, 10,000-path Time Machine and the rule-based desk, then sizes, risk-checks and places the order itself (local simulator or Alpaca paper by default, live only after an explicit opt-in), manages exits and journals every fill. Use when the user says "trade for me", "run the bot", "start / stop / pause the autopilot", "kill switch", "what did the bot do today", "replay today with the autopilot", or "go live".
---

# Trader · Autopilot (trades for you — within every gate)

The user asked for a bot that trades on their behalf. This is it — with the same discipline as the
manual workflow, applied mechanically on every cycle (default every 60 s):

1. **Controls** — `trader/autopilot/control.json` (dashboard or CLI): *pause* stops new entries
   (exits and time stops keep running), *kill* cancels every order and closes every position,
   *run once* forces a cycle.
2. **Sync** the broker → `broker/positions.json`, `broker/orders.json`, `broker/equity.jsonl`;
   fills become journal entries (`source: "autopilot"`, real fill prices); exits close them.
3. **Exits** — stocks flat by 3:55 p.m. ET; crypto: protective stop after the fill, target and
   4h horizon managed by the bot (Alpaca has no crypto brackets); stocks use bracket orders.
4. **Kill switch** — realized + unrealized loss today ≥ `limits.global.max_daily_loss_usd` → flatten and stop.
5. **Fresh triggers** on the watchlist (stocks during the session until 3:30 p.m. ET, crypto 24/7;
   **never meme coins**) → entry → exit plan → backtest of that rule on that symbol → Time Machine →
   rule-based desk (`desk.py auto`) → sizer → risk check → order. One look per setup per day; every
   look is written to `trader/autopilot/decisions.jsonl` with the reasons.

**A trade happens only if** the backtest shows an edge after costs (expectancy ≥ +0.05R over
≥ 10 triggers), the Time Machine does not reject the geometry (EV ≥ −0.05R), the desk says GO,
the risk manager says PASS, the daily caps allow it and there is buying power.

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
python3 "${CLAUDE_SKILL_DIR}/autopilot.py" status
python3 "${CLAUDE_SKILL_DIR}/autopilot.py" run --once            # one cycle (dry run unless enabled/--approve)
python3 "${CLAUDE_SKILL_DIR}/autopilot.py" loop --approve        # keep trading every autopilot.interval_sec
python3 "${CLAUDE_SKILL_DIR}/autopilot.py" pause | resume
python3 "${CLAUDE_SKILL_DIR}/autopilot.py" kill --confirm KILL   # cancel everything, close everything
python3 "${CLAUDE_SKILL_DIR}/autopilot.py" check-live
# offline: replay the fixture day in the simulator (NVDA taken, TSLA/BTC skipped with reasons)
python3 "${CLAUDE_SKILL_DIR}/autopilot.py" replay --from 2026-10-20T13:35:00Z --to 2026-10-20T20:00:00Z --approve --offline
```

Or let the dashboard run it: `python3 app/server.py --autopilot` (calls `run_cycle(approved=True)`).

| Option | Meaning |
|---|---|
| `--approve` | standing approval for this run (else `autopilot.enabled` decides; else dry run) |
| `--interval SEC` | loop period (default `autopilot.interval_sec`, 60) |
| `--max-cycles N` | loop: stop after N cycles |
| `--from/--to/--step` | replay window and clock step (default 5m) |
| common | `--offline --now --home --json` |

Config (`trader/config.json → autopilot`): `watchlist` (default: your stock + crypto watchlists),
`setups` per asset, `gates` (`min_backtest_triggers`, `min_backtest_expectancy_r`, `min_tm_ev_r`,
`tm_paths`, `max_trigger_age_bars`), `max_new_trades_per_day`, `flatten_on_kill`, `sim_starting_cash`.

## Keep it running

It only trades while it runs — during the US session for stocks, around the clock for crypto.
Use a computer that does not sleep, or a small VPS. A systemd unit:

```ini
# /etc/systemd/system/trader.service
[Unit]
Description=Trader dashboard + autopilot
After=network-online.target

[Service]
WorkingDirectory=/home/trader/myproject
Environment=TRADER_HOME=/home/trader/myproject/trader
ExecStart=/usr/bin/python3 /home/trader/trader-skill/app/server.py --autopilot
Restart=on-failure
User=trader

[Install]
WantedBy=multi-user.target
```

(`sudo systemctl enable --now trader`; keys go in `trader/secrets.env` with `chmod 600`.)

## Reads / writes

* reads `config.json`, `limits.json`, `autopilot/control.json`, `secrets.env` (keys only, never echoed)
* writes `autopilot/state.json`, `autopilot/decisions.jsonl`, `autopilot/book.json`,
  `broker/positions.json`, `broker/orders.json`, `broker/equity.jsonl`, `broker/log.jsonl`,
  `broker/sim.json` (simulator), `entries.json`, `plan.json`, `backtests/`, `timemachine/`, `desk/`,
  `orders.json`, `approvals.jsonl`, `journal.json`

## How to present results

Lead with the mode (SIMULATOR / PAPER / **LIVE**) and status, then today: trades opened, realized P&L,
open positions; then the latest decisions — taken ones with entry/stop/target, skipped ones with their
first reason. Point to the dashboard for the full picture. Always include the disclaimer.

## Never

* Never auto-trade meme coins, never touch wallets, keys or seed phrases.
* Never switch to live by itself, never edit the live opt-in fields for the user, never print a key.
* Never retry an order blindly — after a timeout it looks the order up by client id first.
* Never exceed the limits in `limits.json` or the autopilot caps; never trade a setup whose backtest
  shows no edge.
* Never claim the bot will make money.
