# Trader — file tree, `trader/` state schemas and build conventions

This is the contract between the 12 skills. Every skill reads what the previous
one wrote in the project's `trader/` folder (override with `TRADER_HOME`).
All timestamps are ISO-8601 UTC strings ending in `Z`. Prices are floats in the
quote currency (USD/USDT). Candle `t` is the bar's **open** time; a bar "closes"
at `t + interval`.

## File tree

```
trader-skill/
  README.md  LICENSE  .gitignore
  .claude-plugin/plugin.json  .claude-plugin/marketplace.json
  docs/SCHEMAS.md                 (this file)
  scripts/demo.sh                 runs the three walkthroughs offline
  trader-scanner/     SKILL.md  scan.py
  trader-news/        SKILL.md  news.py
  trader-entry/       SKILL.md  entry.py
  trader-exit/        SKILL.md  exit.py
  trader-timemachine/ SKILL.md  replay.py  report.py
  trader-risk/        SKILL.md  risk.py
  trader-sizer/       SKILL.md  size.py
  trader-alerts/      SKILL.md  alerts.py  nyse_calendar.py
  trader-broker/      SKILL.md  ticket.py
  trader-journal/     SKILL.md  journal.py
  trader-backtest/    SKILL.md  backtest.py
  trader-rugcheck/    SKILL.md  rugcheck.py
  trader-desk/        SKILL.md  desk.py        (add-on: four-role AI desk)
  trader-arb/         SKILL.md  arb.py         (add-on: read-only arbitrage gap monitor)
  agents/             trader-researcher.md  trader-skeptic.md  trader-lead.md
  shared/
    __init__.py
    config.py         TRADER_HOME, config.json / limits.json defaults, offline flag
    state.py          atomic JSON / JSONL read-write inside trader/
    cache.py          file cache for HTTP responses (trader/cache/)
    http.py           polite GET: per-host rate limit, 429 back-off, geo-block circuit breaker, offline routing
    offline.py        maps URLs to tests/fixtures/http/* (TRADER_OFFLINE=1)
    symbols.py        asset-class detection + per-source symbol normalisation
    market_clock.py   NYSE calendar 2026–2027 (+ rule-based fallback), ET/UTC, 24/7 windows, buckets
    data.py           get_candles() / get_quote() / universes — routes to sources with fallbacks
    indicators.py     VWAP, ATR, relative volume, log returns, percentiles, session split
    setups.py         setup rules (ORB, VWAP reclaim, gap-and-go, bull flag, crypto ranges, momentum)
    trade_sim.py      bar-by-bar stop/target/time-stop walk, trailing, scale-outs, costs, slippage
    fmt.py            money / price / pct formatting
    html.py           self-contained HTML + inline SVG charts (candles, minis, histogram, fan chart)
    cli.py            common argparse flags, disclaimers, JSON/text output, @entrypoint
    disclaimer.py     the disclaimer text (stronger one for meme coins)
    skills.py         load a sibling skill's module (e.g. scanner → rugcheck)
    sources/
      yahoo.py stooq.py binance.py coinbase.py kraken.py coingecko.py
      dexscreener.py geckoterminal.py okx.py rugcheck_api.py honeypot.py
      rss.py sec.py nasdaq.py
  tests/
    __init__.py  helpers.py  test_*.py
    fixtures/  make_fixtures.py  manifest.json  http/...
```

## Common CLI contract (every tool)

`--help`, `--asset stock|crypto|meme` (default: detected from the symbol),
`--offline` (serve every HTTP call from `tests/fixtures/http`), `--fixtures DIR`,
`--now ISO` (pin the clock; also `TRADER_NOW`), `--home DIR` (also `TRADER_HOME`),
`--json` (machine-readable stdout), `--no-html`, `--open` (open the HTML report),
`--seed N` where randomness is involved. Every run prints the disclaimer
(stronger one for meme coins). Exit code 0 = ran fine (even if the verdict is
BLOCK), 2 = bad input, 3 = data unavailable.

## `trader/` state files

### `config.json` (created with defaults on first run)
```json
{
  "sec_user_agent": "Your Name your.email@example.com",
  "account_size": 25000, "account_currency": "USD",
  "risk_per_trade_pct": 0.5,
  "fractional_shares": false,
  "watchlists": {"stocks": ["TSLA","NVDA","AAPL","AMD","META"],
                 "crypto": ["BTCUSDT","ETHUSDT","SOLUSDT"], "meme": []},
  "meme_chains": ["solana", "base"],
  "quote_currency": "USDT",
  "crypto_horizon": "4h", "meme_horizon": "4h",
  "paper": true,
  "connector": "alpaca",
  "costs": {"stock":  {"fee_bps": 0,  "slippage_bps": 2},
            "crypto": {"fee_bps": 10, "slippage_bps": 3},
            "meme":   {"fee_bps": 30, "slippage_bps": 100}},
  "scanner": {"interval": "5m", "max_symbols": 300, "time_budget_sec": 240,
              "min_price": 2.0, "min_avg_volume": 300000, "top_n_crypto": 30,
              "gap_min_pct": 3.0, "relvol_min": 2.0}
}
```

### `limits.json` (created with defaults on first run)
```json
{
  "global": {"max_daily_loss_usd": 750, "max_daily_trades": 10, "max_open_positions": 10},
  "stock":  {"max_risk_per_trade_usd": 250, "max_daily_loss_usd": 500, "max_open_positions": 5,
             "max_position_pct": 25, "max_daily_trades": 6,
             "allow_shorts": false, "allow_margin": false, "allow_options": false},
  "crypto": {"max_risk_per_trade_usd": 200, "max_daily_loss_usd": 400, "max_open_positions": 5,
             "max_position_pct": 15, "max_total_exposure_pct": 50, "max_daily_trades": 6,
             "allow_shorts": false, "allow_leverage": false},
  "meme":   {"max_risk_per_trade_usd": 50, "max_daily_loss_usd": 100, "max_open_positions": 2,
             "max_position_pct": 2, "max_total_exposure_pct": 5, "max_daily_trades": 4,
             "min_liquidity_usd": 50000, "max_slippage_pct": 3.0, "max_pct_of_pool": 1.0,
             "required_rugcheck_verdicts": ["SAFE"], "rugcheck_max_age_minutes": 60},
  "blocked_symbols": []
}
```

### `setups.json` — written by scanner
```json
{
  "generated_at": "2026-10-20T14:15:00Z", "asset": "stock", "interval": "5m",
  "universe": {"name": "us-all", "total": 30, "scanned": 6, "skipped": 24, "hidden": 0},
  "setups": [{
    "id": "TSLA-20261020-orb15", "symbol": "TSLA", "asset": "stock",
    "setup": "orb15", "label": "Opening-range breakout (15 min)", "direction": "long",
    "status": "triggered", "score": 87.5, "last_price": 364.18, "as_of": "2026-10-20T14:15:00Z",
    "rule": "5-min close above opening range high $362.18 (9:30–9:45 ET)",
    "levels": {"range_high": 362.18, "range_low": 358.32, "trigger_level": 362.18,
               "stop_ref": 358.32, "vwap": 361.2},
    "trigger": {"time": "2026-10-20T14:10:00Z", "close_time": "2026-10-20T14:15:00Z", "price": 364.18},
    "metrics": {"relvol": 2.6, "gap_pct": 0.8, "change_pct": 1.9, "liquidity_usd": null,
                "funding_rate": null, "oi_change_pct": null},
    "flags": ["high_relvol"], "notes": ["..."],
    "rugcheck": null,
    "chart": "reports/scan-stock-20261020.html"
  }],
  "hidden": [{"symbol": "solana:<addr>", "reason": "rugcheck DANGER: LP not locked; top holder 40%"}],
  "warnings": []
}
```
Flag-only scanner hits (no candle rule of their own) use `"status": "flag"` with
`setup` ∈ `high_relvol | volume_spike | funding_extreme | rising_oi | buy_pressure | new_launch`
and `"entry_setup"` naming the watchable rule the entry timer should use (e.g. `momentum`).
Every hit carries `"entry_setup"` (equal to `setup` for real rules).

Setup ids are `{symbol_key}-{YYYYMMDD}-{setup}`; `symbol_key` is `Symbol.key`
(`TSLA`, `BTCUSDT`, `solana-<address>`), the date is the session date (ET for
stocks, UTC for crypto/meme).

### `entries.json` — written by entry
```json
{"entries": {"TSLA-20261020-orb15": {
   "id": "TSLA-20261020-orb15", "symbol": "TSLA", "asset": "stock", "setup": "orb15", "direction": "long",
   "status": "triggered", "previous_status": "watching",
   "rule": "5-min close above opening range high $362.18 (9:30–9:45 ET)",
   "levels": {"range_high": 362.18, "range_low": 358.32, "trigger_level": 362.18, "stop_ref": 358.32},
   "range": {"start": "2026-10-20T13:30:00Z", "end": "2026-10-20T13:45:00Z"},
   "trigger": {"time": "2026-10-20T14:10:00Z", "close_time": "2026-10-20T14:15:00Z", "price": 364.18,
               "candle": {"o": 361.9, "h": 364.6, "l": 361.7, "c": 364.18, "v": 812000}},
   "entry_price": 364.18, "checked_at": "2026-10-20T14:15:00Z",
   "liquidity_check": null,
   "history": [{"at": "2026-10-20T14:05:00Z", "status": "watching"}, {"at": "...", "status": "triggered"}],
   "chart": "reports/entry-TSLA-20261020-orb15.html"}},
 "latest": "TSLA-20261020-orb15"}
```
`status` ∈ `forming | watching | triggered | invalidated | expired | blocked`
(`blocked` = meme trigger seen but liquidity/slippage check failed).
`liquidity_check` for meme: `{"liquidity_usd": 412000, "size_usd": 500, "est_slippage_pct": 0.24, "max_slippage_pct": 3.0, "min_liquidity_usd": 50000, "ok": true}`.

### `plan.json` — written by exit, read by timemachine/sizer/alerts/journal
```json
{"plans": {"TSLA-20261020-orb15": {
   "id": "TSLA-20261020-orb15", "symbol": "TSLA", "asset": "stock", "setup": "orb15", "direction": "long",
   "entry": {"price": 364.18, "time": "2026-10-20T14:15:00Z"},
   "stop": {"price": 358.32, "method": "range_low", "note": "below the opening-range low"},
   "target": {"price": 375.90, "r_multiple": 2.0},
   "risk_per_unit": 5.86,
   "time_stop": {"at": "2026-10-20T19:55:00Z", "rule": "flat by 3:55 p.m. ET"},
   "horizon": {"end": "2026-10-20T20:00:00Z", "label": "rest of the session (4:00 p.m. ET close)"},
   "trailing": null,
   "scale_out": [],
   "liquidity_exit": null,
   "atr": 1.92, "interval": "5m",
   "created_at": "2026-10-20T14:15:00Z", "chart": "reports/plan-TSLA-20261020-orb15.html"}},
 "latest": "TSLA-20261020-orb15"}
```
`trailing`: `null | {"type": "breakeven_at_r"|"atr"|"pct", "value": 1.0}`.
`scale_out` (meme default): `[{"fraction": 0.5, "at_multiple": 2.0, "price": 0.0084, "note": "sell half at 2x — recovers the initial stake"}]`.
`liquidity_exit` (meme): `{"drop_pct": 30, "liquidity_at_entry_usd": 412000, "exit_below_usd": 288400}`.

### `timemachine/{symbol_key}-{YYYYMMDD}.json` — written by timemachine
```json
{"id": "TSLA-20261020-orb15", "symbol": "TSLA", "asset": "stock", "generated_at": "...",
 "seed": 7, "n_paths": 10000, "interval": "5m",
 "entry": 364.18, "stop": 358.32, "target": 375.90,
 "entry_time": "2026-10-20T14:15:00Z", "horizon_end": "2026-10-20T20:00:00Z", "steps": 69,
 "history": {"sessions": 60, "bars": 4680, "first": "...", "last": "...", "thin_sample": false},
 "method": {"kind": "block bootstrap", "block_len": 6, "buckets": {"morning": 1440, "midday": 2160, "power_hour": 720},
            "vol_scale": 1.08, "rug_share": 0.0, "exit_slippage_pct": 0.0},
 "probabilities": {"target": 0.41, "stop": 0.47, "neither": 0.12, "rug": 0.0},
 "expected_value": {"r": 0.13, "usd": 16.1, "qty": 17, "risk_usd": 99.62},
 "close": {"median": 364.9, "mean": 365.0, "p5": 355.54, "p95": 373.54},
 "histogram": {"edges": [...], "counts": [...]},
 "sample_paths": [{"outcome": "target", "prices": [364.18, ...]}],
 "backtest": null,
 "summary": "Entry $364.18, stop $358.32, target $375.90. I replayed the rest of today 10,000 times ...",
 "warnings": [], "report": "reports/timemachine-TSLA-20261020.html"}
```
`backtest` when available: `{"file": "backtests/TSLA-orb15.json", "windows": 59, "triggers": 33, "p_target": 0.39, "p_stop": 0.45, "p_neither": 0.15, "avg_r": 0.12}`.

### `backtests/{symbol_key}-{setup}.json` — written by backtest
```json
{"symbol": "TSLA", "asset": "stock", "setup": "orb15", "generated_at": "...",
 "params": {"sessions": 60, "target_r": 2.0, "stop": "range", "fee_bps": 0, "slippage_bps": 2,
            "time_stop": "15:55 ET", "horizon": null},
 "windows": 59, "triggers": 33, "target": 13, "stop": 15, "neither": 5,
 "p_target": 0.394, "p_stop": 0.455, "p_neither": 0.152,
 "win_rate": 0.45, "avg_r": 0.12, "expectancy_r": 0.12, "total_r": 3.9, "max_drawdown_r": -4.1,
 "trades": [{"window": "2026-07-23", "entry_time": "...", "entry": 1.0, "stop": 1.0, "target": 1.0,
             "exit_time": "...", "exit": 1.0, "outcome": "target|stop|time", "r_gross": 2.0, "r_net": 1.98}],
 "summary": "Last 59 sessions: 33 triggers, 13 hit target, 15 hit stop, 5 neither.",
 "report": "reports/backtest-TSLA-orb15.html"}
```

### `orders.json` — written by sizer, updated by risk and broker
```json
{"orders": [{
  "id": "ord-TSLA-20261020-141500", "plan_id": "TSLA-20261020-orb15",
  "symbol": "TSLA", "asset": "stock", "side": "buy", "direction": "long",
  "qty": 17, "qty_unit": "shares", "notional_usd": 6191.06,
  "entry_price": 364.18, "limit_price": 364.20, "stop_price": 358.32, "target_price": 375.90,
  "risk_usd": 99.62, "risk_pct": 0.40, "position_pct": 24.8,
  "sizing": {"account_size": 25000, "risk_pct": 0.5, "risk_budget_usd": 125.0, "raw_qty": 21.33,
             "caps": ["max_position_pct 25% → 17 shares"], "rounding": "whole shares"},
  "liquidity_usd": null, "est_slippage_pct": null, "pool_pct": null,
  "status": "proposed", "risk": null, "paper": true,
  "created_at": "2026-10-20T14:15:00Z"}]}
```
`status` flow: `proposed → risk_pass | risk_block → ticketed → approved | declined`.
`risk` written by risk:
`{"result": "PASS"|"BLOCK", "checked_at": "...", "order_hash": "<sha256 of the sized fields>", "reasons": ["..."], "checks": [{"name": "max_risk_per_trade", "ok": true, "detail": "$99.62 ≤ $250"}]}`.
Meme orders: `qty_unit: "usd"`, `qty` = USD amount, plus `liquidity_usd`, `est_slippage_pct`, `pool_pct`, `rugcheck: {"verdict": "SAFE", "score": 86, "checked_at": "...", "file": "rugcheck/solana-<addr>.json"}`.

### `tickets.json` and `approvals.jsonl` — written by broker
```json
{"tickets": [{"id": "tkt-ord-TSLA-20261020-141500", "order_id": "ord-...", "mode": "paper",
   "text": "BUY 17 TSLA, limit $364.20, stop $358.32, day — PAPER",
   "hash": "<sha256 of text + payload>", "payload": {"connector": "alpaca", "tool": "place_stock_order", "arguments": {...}},
   "status": "awaiting_approval|approved|declined|manual_checklist", "created_at": "...", "expires_at": "..."}]}
```
`approvals.jsonl` (append-only, one JSON per line):
`{"ts": "...", "ticket_id": "...", "order_id": "...", "ticket_hash": "...", "ticket_text": "...", "mode": "paper", "user_reply": "yes", "approved": true}`.

### `journal.json` — written by journal
```json
{"trades": [{"id": "trd-TSLA-20261020-orb15", "plan_id": "...", "order_id": "...",
   "symbol": "TSLA", "asset": "stock", "setup": "orb15", "direction": "long", "status": "open|closed",
   "qty": 17, "entry": {"time": "...", "price": 364.18}, "exit": {"time": "...", "price": 375.9, "reason": "target|stop|time|manual|liquidity|rug"},
   "stop": 358.32, "target": 375.9, "risk_per_unit": 5.86,
   "fees_usd": 0.0, "slippage_usd": 1.2, "pnl_usd": 198.04, "r_multiple": 1.99,
   "paper": true, "notes": "", "chart": "reports/trade-TSLA-20261020-orb15.html", "logged_at": "..."}]}
```

### `alerts.json` and `alerts_log.jsonl` — written by alerts
```json
{"alerts": [{"id": "al-0001", "symbol": "TSLA", "asset": "stock",
   "type": "above|below|cross|pct_move|stop|target|opening_bell|liquidity_drop|dev_selling|holder_jump",
   "level": 365.0, "pct": null, "baseline": {}, "plan_id": null,
   "status": "active|fired", "created_at": "...", "fired_at": null, "fired_value": null,
   "last_value": null, "last_checked": null, "note": ""}]}
```

### `news.json` and `news_seen.json` — written by news
```json
{"checked_at": "...", "asset": "stock", "scope": "stock:TSLA,NVDA",
 "items": [{"id": "sha1", "symbol": "TSLA", "source": "Yahoo Finance", "title": "...", "url": "https://...",
            "published": "...", "tags": ["merger", "earnings"], "why": "Merger talk + earnings ahead — expect a volatile open", "importance": 3}]}
```
`news_seen.json`: `{"scopes": {"stock:TSLA": {"ids": ["..."], "last_check": "..."}}, "meme_snapshots": {"solana-<addr>": {"liquidity_usd": 1, "links": ["..."], "boosts": 0, "at": "..."}}}`.

### `rugcheck/{chain}-{address}.json` — written by rugcheck
```json
{"chain": "solana", "address": "<mint>", "symbol": "PUPKIN", "name": "Pumpkin Pup",
 "pair_address": "<pool>", "dex": "raydium", "checked_at": "...",
 "score": 86, "verdict": "SAFE|RISKY|DANGER",
 "headline": "No red flags found in these checks (not a guarantee)",
 "checks": [{"name": "lp_locked", "label": "LP locked or burned", "ok": true, "severity": "critical",
             "value": "100% locked/burned", "penalty": 0, "detail": "..."}],
 "reasons": ["..."],
 "metrics": {"liquidity_usd": 412000, "lp_locked_pct": 100, "top10_pct": 18.2, "top_holder_pct": 4.1,
             "creator_pct": 0.0, "mint_authority": null, "freeze_authority": null,
             "buy_tax": null, "sell_tax": null, "is_honeypot": null, "pair_age_hours": 60.0,
             "buys_h1": 1300, "sells_h1": 700, "volume_h24": 3100000, "vol_liq_ratio": 7.5},
 "sources": {"dexscreener": "ok", "rugcheck": "ok", "honeypot": "n/a"}, "warnings": [],
 "report": "reports/rugcheck-solana-<addr8>.html"}
```

### `desk/{id}/` — written by trader-desk
`case.json` (everything the roles work from: plan, entry, setup, news, rugcheck, backtest, timemachine,
order, `missing` steps with the exact command to run), `research.md`, `skeptic.md` (objections as
`O1 [critical|major|minor] … — evidence: …`), `lead.md` (`O1: rebutted|mitigated|accepted — …` and
`DECISION: GO|NO-GO|WAIT`), `log.jsonl`, and `desk.json`:
```json
{"id": "TSLA-20261020-orb15", "status": "GO|NO-GO|WAIT|BLOCKED|INCOMPLETE", "decision": "NO-GO",
 "headline": "...", "objections": [{"id": "O1", "severity": "critical", "text": "...", "response": "mitigated"}],
 "issues": [], "blockers": [], "gates": [{"name": "exit plan", "ok": true, "hard": true, "detail": "..."}],
 "trader_next": [], "verified_at": "..."}
```

### `arb/{symbol_key}.json` and `arb_log.jsonl` — written by trader-arb
```json
{"symbol": "PUPKIN (solana)", "key": "solana-<mint>", "asset": "meme", "size_usd": 500,
 "venues": [{"venue": "raydium cx4G…7Qar", "price": 0.004712, "fee_pct": 0.25, "slippage_pct": 0.24,
             "network_pct": 0.0, "liquidity_usd": 412350, "stale": false, "too_thin": false, "note": "..."}],
 "routes": [{"buy": "...", "sell": "...", "gross_pct": 0.15, "costs_pct": 6.27, "net_pct": -6.12, "stale_leg": false}],
 "best": {}, "verdict": "no edge after costs", "summary": "...", "reality_check": "...", "assumptions": []}
```

### Other folders
`reports/*.html` (self-contained reports), `cache/` (HTTP cache, safe to delete),
`risk_log.jsonl` (every risk verdict).

## Python module contracts (shared/)

* `symbols.parse(raw, asset=None, quote=None) -> Symbol` — `Symbol.key/display/asset/base/quote/chain/address`
  plus per-source names (`yahoo`, `binance`, `coinbase`, `kraken`, `alpaca`, `okx_swap`, `gt_network`).
* `data.get_candles(symbol, interval="5m", days=None, asset=None, end=None) -> Series`
  (`Series.candles: list[Candle(t,o,h,l,c,v)]`, `.source`, `.warnings`, `.meta`, `.symbol`).
  Only **closed** candles (close time ≤ `end`, default now). Raises `data.DataUnavailable`.
* `data.get_quote(symbol, asset=None) -> dict` · `data.get_pair(symbol) -> dict` (meme, normalised DexScreener pair).
* `data.stock_universe() / crypto_universe(n) / meme_universe(chains) / derivatives(sym) / lot_info(sym)`.
* `setups.windows(candles, asset, interval)`, `setups.evaluate(setup, window, now_ts=None, params=None, history=None)`.
* `trade_sim.walk(bars, entry, stop, target, end_ts, ...)`, `trade_sim.estimate_slippage_pct(size_usd, liquidity_usd)`,
  `trade_sim.net_r(...)`.
* `html.page(...)`, `html.candle_chart(...)`, `html.mini_chart(...)`, `html.histogram(...)`, `html.fan_chart(...)`,
  `html.write_report(name, html) -> Path`.
* `cli.parser(...)`, `cli.init(args) -> Context`, `cli.disclaimer(asset)`, `cli.emit(...)`.

## v2 — autopilot, brokers, dashboard, social news

### Secrets (never in git, never printed, never returned by the dashboard)
Read by `shared/secrets.py` from environment variables first, then from `trader/secrets.env`
(`KEY=value` lines; `trader/` is git-ignored; the file should be chmod 600):
`ALPACA_PAPER_KEY_ID`, `ALPACA_PAPER_SECRET_KEY`, `ALPACA_LIVE_KEY_ID`, `ALPACA_LIVE_SECRET_KEY`,
`X_BEARER_TOKEN`, `TRADER_DASHBOARD_PASSWORD`.

### `config.json` additions (defaults merged in by shared/config.py)
```json
"autopilot": {
  "enabled": false,
  "broker": "simulator",            // "simulator" (local paper, no account) | "alpaca"
  "mode": "paper",                  // "paper" | "live" — live needs everything listed under "Live mode"
  "interval_sec": 60,
  "assets": ["stock", "crypto"],    // meme coins are never auto-traded
  "watchlist": null,                // null = config watchlists
  "setups": {"stock": ["orb15", "orb30", "gap_and_go", "vwap_reclaim", "bull_flag"],
             "crypto": ["asia_range", "us_open_range", "vwap_reclaim", "momentum"]},
  "gates": {"min_backtest_triggers": 10, "min_backtest_expectancy_r": 0.05, "min_tm_ev_r": -0.05,
            "tm_paths": 2000, "max_trigger_age_bars": 1},
  "max_new_trades_per_day": 5,
  "flatten_on_kill": true,
  "sim_starting_cash": 25000,
  "live_confirmation": ""           // must equal "I ACCEPT REAL MONEY RISK" for live
},
"news": {
  "x": {"enabled": true, "max_reads_per_day": 300, "poll_minutes": 15,
        "accounts": {"stock": ["DeItaone", "FirstSquawk", "LiveSquawk", "unusual_whales", "WSJmarkets", "Reuters"],
                     "crypto": ["tier10k", "WatcherGuru", "WuBlockchain", "lookonchain", "whale_alert", "CoinDesk"]}},
  "stocktwits": {"enabled": true},
  "feed_max_items": 500
}
```
**Live mode** = `autopilot.broker "alpaca"` AND `autopilot.mode "live"` AND top-level `paper: false`
AND live keys present AND `autopilot.live_confirmation == "I ACCEPT REAL MONEY RISK"`. Anything missing →
the autopilot refuses to start in live mode and says exactly what is missing (it never silently falls back
to live, and never silently "upgrades" paper to live).

### `autopilot/state.json` — written by the autopilot every cycle
```json
{"status": "running|paused|stopped|killed|error", "mode": "simulator|paper|live", "broker": "simulator|alpaca",
 "started_at": "...", "last_cycle": "...", "next_cycle": "...", "cycles": 42, "interval_sec": 60,
 "today": {"date": "2026-10-20", "trades_opened": 1, "realized_pnl": 0.0, "skipped": 7, "kill_reason": null},
 "last_errors": [{"at": "...", "error": "..."}], "message": "watching 8 symbols · 1 open position"}
```
### `autopilot/control.json` — written by the dashboard / CLI, read by the autopilot each cycle
`{"paused": false, "kill": false, "run_once": false, "updated_at": "...", "by": "dashboard|cli"}`
(`kill` = cancel all open orders and, if `flatten_on_kill`, close all positions; then status `killed`
until someone resumes.)
### `autopilot/decisions.jsonl` — one line per trigger the autopilot looked at
`{"at": "...", "id": "NVDA-20261020-orb15", "symbol": "NVDA", "asset": "stock", "setup": "orb15",
  "action": "taken|skipped|error", "reasons": ["backtest expectancy -0.12R over 33 triggers"],
  "desk": {"status": "GO|NO-GO|...", "objections": 2}, "gates": [{"name": "...", "ok": true, "detail": "..."}],
  "order_id": "ord-…|null", "broker_order_id": "…|null", "entry": 194.49, "stop": 190.9, "target": 201.67, "qty": 32}`
### `broker/equity.jsonl` — one snapshot per cycle
`{"at": "...", "equity": 25123.4, "cash": 18000.0, "unrealized": 23.4, "realized_today": 100.0, "mode": "simulator"}`
### `broker/positions.json` and `broker/orders.json` — latest sync from the broker
positions: `[{"symbol": "NVDA", "asset": "stock", "qty": 32, "avg_entry": 194.49, "last": 195.1,
"market_value": 6243.2, "unrealized_pl": 19.5, "opened_at": "...", "plan_id": "..."}]`;
orders: `[{"id": "...", "client_order_id": "...", "symbol": "...", "side": "buy|sell", "type": "limit|stop|...",
"qty": 32, "limit_price": 194.5, "stop_price": null, "status": "new|filled|canceled|...", "filled_avg_price": 194.49,
"submitted_at": "...", "filled_at": "...", "leg": "entry|stop|target"}]`
### `broker/sim.json` — the local simulator's book (cash, positions, orders, fills)
### Journal entries written by the autopilot add `"source": "autopilot"`, `"broker": "simulator|alpaca"`,
`"broker_order_id"` and use real fill prices.

### `news_feed.json` — rolling aggregated feed (newest first, max `feed_max_items`)
`{"updated_at": "...", "items": [{"id": "...", "symbol": "TSLA|BTC|market|...", "asset": "stock|crypto|meme",
  "source": "X|StockTwits|Yahoo Finance|SEC EDGAR|CoinDesk|DexScreener|...", "kind": "news|filing|social",
  "author": "@DeItaone|null", "title": "...", "url": "https://...", "published": "...", "tags": ["merger"],
  "why": "...", "importance": 1, "sentiment": "bullish|bearish|null", "metrics": {"likes": 0, "reposts": 0}}],
  "sources": {"X": "ok|no token|budget exhausted|error: …", "StockTwits": "ok"}}`
`news_feed.json` also keeps `seen_ids` (rolling 5,000 ids, so stories that fell off the end don't come back
as "new") and `meme_snapshots`; items may carry `score`, `credibility`, `also`, `x_id`, `wire`, `followers`,
`verified` and `crowd_summary` (one StockTwits mood line per symbol).
### `x_usage.json` — `{"date": "2026-10-20", "reads": 120, "requests": 12, "max_reads_per_day": 300}`

## v3 — 24/7 daemon, self-picked universe, news/filings gate, learning from its own record, notifications, optional AI desk

Principles that do not change: the database of record is the `trader/` folder; meme coins are never
auto-traded; nothing touches wallets, keys or seed phrases; live money still needs the five-step opt-in;
every new layer can only make the autopilot **more** careful (a veto), never wave through a trade that a
hard gate rejected.

### Trading hours (no config — this is the design)
* **Crypto: 24/7.** New entries any time, every day.
* **US stocks: regular session only** — new entries 9:30–15:30 ET on NYSE trading days, flat by 15:55 ET.
  Pre-market, after-hours and Alpaca's overnight session are deliberately not traded: every stock setup
  and every backtest in this pack is built on regular-session bars, extended-hours liquidity is thin and
  the broker only takes plain limit orders there (no brackets). Outside the session the daemon keeps
  trading crypto, refreshing news and filings, and rebuilding the stock universe for the next open.

### `config.json` additions
```json
"autopilot": {
  "universe": {
    "mode": "auto",                 // "auto" = the autopilot picks its own symbols; "watchlist" = v2 behaviour
    "stocks": {"top_n": 40, "refresh_minutes": 60, "base": null,       // null = built-in list of ~150 liquid US names
               "include_movers": true, "max_movers": 10,              // Yahoo "most actives" + "day gainers"
               "min_market_cap_usd": 2000000000},                     // movers below this are ignored
    "crypto": {"top_n": 20, "refresh_minutes": 240, "min_volume_usd": 50000000},
    "always": [],                   // always watched (on top of watchlists.stocks / watchlists.crypto)
    "exclude": []                   // never watched
  },
  "scan_time_budget_sec": 40,       // per cycle; symbols not reached roll over to the next cycle of the same bar
  "news_gate": {
    "enabled": true,
    "refresh_before_trade": true,   // fetch the latest headlines + SEC filings for the symbol right before judging
    "refresh_max_age_minutes": 10,  // …unless they were fetched less than this long ago
    "lookback_hours": {"stock": 24, "crypto": 12},
    "market_hours": 6,              // market-wide crypto items (hack, delisting, macro) this recent count too
    "min_credibility": 2,           // StockTwits / small X accounts (credibility 1) never block a trade
    "critical_tags": {"stock": ["offering", "dilution", "bankruptcy", "delisting", "restatement"],
                      "crypto": ["hack", "delisting"]},
    "major_tags": {"stock": ["merger", "fda", "control"], "crypto": ["token_unlock"]},
    "trend_block_tags": ["delisting", "bankruptcy"],  // a daily trend trade (exit rule) stops only for these
    "market_blocks": false          // market-wide items are shown as notes; true restores the old blocking
  },
  "adapt": {
    "enabled": true,
    "min_trades": 8,                // per setup and asset class, before the record counts
    "disable_below_r": -0.25,       // net expectancy at or below this → the setup is paused for that asset
    "cooldown_days": 7,             // …for this long; afterwards it starts with a clean slate
    "symbol_loss_streak": 3,        // this many losses in a row on one symbol → that symbol sits out
    "symbol_cooldown_days": 5,
    "loss_streak": 3,               // this many losses in a row overall → risk per trade × loss_streak_risk_mult
    "loss_streak_risk_mult": 0.5,   // …until the next winning trade
    "max_drawdown_pct": 10          // equity this far below its peak → the autopilot pauses itself; resume resets the peak
  }
},
"notify": {
  "enabled": false,
  "ntfy_topic": "",                 // https://ntfy.sh/<topic> — pick a long random topic, anyone who knows it can read it
  "ntfy_server": "https://ntfy.sh",
  "telegram": false,                // needs TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID secrets
  "events": ["started", "stopped", "trade_opened", "trade_closed", "kill", "paused", "learned", "error",
             "daily_summary"],
  "daily_summary_et": "16:10",
  "max_per_hour": 30
},
"ai_desk": {
  "enabled": false,                 // optional: Claude reviews every trade the rule-based desk already passed
  "model": "claude-opus-5-5",
  "max_calls_per_day": 40,          // two calls (Skeptic + Lead) per reviewed trade
  "max_usd_per_day": 3.0,
  "timeout_sec": 120,
  "on_unavailable": "rule_based"    // "rule_based" = fall back to the rule-based decision · "skip" = no trade
}
```

### Secrets added
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `NTFY_TOKEN` (optional, for a protected ntfy server),
`ANTHROPIC_API_KEY` (only for the optional AI desk). Same rules as v2: environment first, then
`trader/secrets.env`; never printed, logged, returned by the dashboard or put in a URL that gets logged.

### `autopilot/universe.json` — written by `shared/universe.py`
```json
{"generated_at": "...", "mode": "auto|watchlist",
 "stock":  {"symbols": ["NVDA", "TSLA"], "refreshed_at": "...", "source": "built-in liquid list ranked by Yahoo spark",
            "candidates": 150, "reasons": {"NVDA": "watchlist", "AMD": "top mover: gap +3.1% · move +2.4%",
                                           "SOFI": "most active today: 81M shares", "XYZ": "day gainer: +6.2%"}},
 "crypto": {"symbols": ["BTCUSDT", "ETHUSDT"], "refreshed_at": "...", "source": "CoinGecko top by volume",
            "candidates": 40, "reasons": {"BTCUSDT": "watchlist", "XRPUSDT": "top 20 by 24h volume ($2.1B)"}},
 "excluded": {"USDCUSDT": "stablecoin", "WBTCUSDT": "wrapped token", "DOGEUSDT": "not tradable on alpaca"},
 "warnings": ["Yahoo spark failed for 1 of 8 batches"]}
```
Symbols are data symbols (stock tickers, Binance-style `BASEUSDT` pairs). Watchlists and `always` are always
included; `exclude` and `blocked_symbols` (limits.json) are always removed. If a refresh fails the previous
list stays (with a warning); with no previous list it falls back to the watchlists.

### `autopilot/scan.json` — scan progress per asset class (one full pass per closed 5-minute bar)
`{"stock": {"bar": 1792000000, "done": ["NVDA", "TSLA"], "total": 40, "finished_at": "..."}, "crypto": {...}}`

### `autopilot/adapt.json` — what the autopilot learned from its own closed trades
```json
{"updated_at": "...", "enabled": true,
 "setups": {"stock:orb15": {"trades": 9, "wins": 3, "expectancy_r": -0.31, "status": "active|paused",
                            "until": "...|null", "since": "...|null", "reason": "..."}},
 "symbols": {"TSLA": {"loss_streak": 3, "status": "active|cooldown", "until": "...|null", "reason": "..."}},
 "loss_streak": 3, "risk_mult": 0.5, "risk_reason": "3 losing trades in a row — half size until the next win",
 "equity_peak": 25480.0, "equity": 24900.0, "drawdown_pct": 2.3, "drawdown_pause": false,
 "events": [{"at": "...", "kind": "setup_paused|setup_resumed|symbol_cooldown|risk_reduced|risk_restored|drawdown_pause",
             "text": "..."}]}
```
Only closed journal trades with `"source": "autopilot"` count, scored by `r_net` (falls back to `r_multiple`).
A paused setup or cooling symbol is skipped with the reason in `decisions.jsonl`; after the cooldown only
trades closed after `until` count toward the next decision. `events` keeps the last 100.

### `autopilot/heartbeat.json` — written when a cycle starts (`"cycling"`), at its end, and while the daemon backs off
`{"at": "...", "pid": 1234, "host": "vps-1", "runner": "daemon|dashboard|cli|replay", "started_at": "...",
  "cycle": 812, "status": "cycling|running|paused|killed|error|stopped", "interval_sec": 60, "next_cycle": "...",
  "universe": {"stock": 40, "crypto": 20}, "scan": {"stock": "32/40", "crypto": "20/20"},
  "sessions": {"crypto": "open 24/7", "stock": "open|closed|pre-market|after-hours|holiday|weekend"}}`
The dashboard calls the bot **alive** when `at` is younger than 3 × `interval_sec` (minimum 3 minutes; 15 minutes
while `"cycling"`). During an error back-off the daemon beats with the real wait as `interval_sec`.

### `autopilot/day.json` — `{"day": "2026-10-20", "start_equity", "last_equity"}`; the daily-loss kill measures
how far equity fell since the UTC day began (never less than today's realized losses), capped by
`global.max_daily_loss_usd` and `global.max_daily_loss_pct` of the start equity.

### `autopilot/control_log.jsonl` — a line each time the bot is paused, killed or resumed
`{"at", "paused", "kill", "by"}` — backtest vs reality does not count signals from those spans as missed.

### `backtests/playbook-history.jsonl` — every playbook the lab wrote
`{"generated_at", "path", "entries": {"ETHUSDT:trend_breakout@1d": {"symbol", "setup", "interval"}}}` — backtest vs
reality judges each signal by the playbook in force that day.

### `autopilot/daemon.lock` — `{"pid": 1234, "host": "vps-1", "started_at": "...", "flock": true}`; one daemon per `trader/` folder
The live daemon also holds an OS lock (`flock`) on `autopilot/daemon.flock` for its whole life — that, not the
heartbeat, says whether it runs (`"flock": true`), so a long back-off never makes it look dead and a crashed one
(or a new Docker container with another hostname) can take over at once. Without `flock` (Windows, older lock
files) a lock whose pid is gone, or whose heartbeat is older than 10 minutes, is stale and gets taken over.

### `autopilot/control.json` gains `"dd_reset_at": "..."` — written on resume; the drawdown peak only counts
equity snapshots from that moment on.

### `notifications.jsonl` — every notification, sent or not
`{"at": "...", "event": "trade_closed", "title": "NVDA closed +0.80R", "text": "...", "priority": "default|high",
  "channels": {"ntfy": "sent|error: …|off", "telegram": "sent|error: …|off"}, "suppressed": null}`
Offline mode never sends anything (`"channels": {"ntfy": "offline — not sent", ...}`).

### `news_feed.json` gains `"refreshed": {"stock:NVDA": "...", "crypto:BTC": "..."}` — when each symbol's
sources were last fetched (the autopilot's just-in-time refresh reads it).

### `desk/{id}/case.json` gains `"feed"` — the symbol's news-feed items inside the lookback (plus recent
market-wide crypto items), newest first, max 15, each `{"id","title","source","kind","published","tags",
"importance","credibility","sentiment","url","symbol"}`; `desk.json` gates gain a non-hard
`"news & filings"` gate. Critical/major tags from `news_gate` about the symbol itself become critical/major Skeptic
objections; market-wide items, and anything but `trend_block_tags` on a daily trend trade, become minor notes.

### `desk/{id}/ai.json`, `ai_skeptic.md`, `ai_lead.md` — written by the optional AI desk
```json
{"at": "...", "model": "claude-opus-5-5", "status": "GO|NO-GO|WAIT|unavailable|error",
 "reason": "…why unavailable / error…", "objections": [{"n": 1, "severity": "critical|major|minor", "text": "..."}],
 "decision_text": "...", "usage": {"calls": 2, "input_tokens": 5200, "output_tokens": 900, "usd": 0.039}}
```
### `ai_usage.json` — `{"days": {"2026-10-21": {"calls": 6, "input_tokens": 15000, "output_tokens": 2800, "usd": 0.12}}}`

### Python module contracts added in v3
* `universe.current(cfg, now=None, broker=None, force=False) -> {"stock": [...], "crypto": [...]}` —
  refreshes stale sections and writes `autopilot/universe.json`; `universe.build(...)` same, always refreshes.
* `adapt.evaluate(cfg, now=None) -> dict` (writes `adapt.json`, returns it plus `"new_events"` for this call) ·
  `adapt.check(doc, asset, setup, symbol_key) -> (ok, reason)` · `adapt.risk_mult(doc) -> float`.
* `notify.send(event, title, text, cfg=None, priority="default") -> dict` (never raises) · `notify.test(cfg)`.
* `ai_desk.review(case, rule_result, cfg, client=None) -> dict` (trader-desk/ai_desk.py; never raises;
  `client` lets tests pass a fake) · `ai_desk.available(cfg) -> (bool, reason)`.
* `Broker.tradable(asset) -> set | None` — base symbols the broker can trade (`None` = no restriction).

### v3 implementation notes
* `decisions.jsonl` lines gain `"ai": {"status", "model", "usd"} | null`; gates may include
  `news refresh`, `news & filings`, `learned · risk multiplier` and `AI desk`; a skip because of the
  autopilot's own record starts with `learned from its record:`.
* `universe.current()` returns only the asset classes in `autopilot.assets`. Sections in
  `universe.json` also carry internal bookkeeping (`picks`, `attempted_at`, `failed`, `fingerprint`,
  `pick_excluded`, `warnings`); a section rebuilds early when its settings or the broker change, and a
  failed refresh is retried after at most 15 minutes.
* `adapt.json` keeps an internal `_equity` read offset; event kinds also include `symbol_resumed`;
  `adapt.check()` refuses everything while `drawdown_pause` is true.
* `ai_desk.review()` statuses: `GO | NO-GO | WAIT` (decided), `unavailable` (off, no SDK, no key, offline,
  over budget), `error` (API error, refusal, truncated or malformed reply), or the rule-based status when
  that was not GO (no API call). A review needs two calls, so the budget refuses when fewer than two remain.
* `autopilot/state.json` gains `universe` (counts), `notes` (last 20 scan notes) and `summary_sent`
  (New York date of the last daily summary). `autopilot/housekeeping.jsonl` logs background failures.

## v3.1 — backtest lab, crypto playbook, sizing by certainty

### `config.json` additions
```json
"autopilot": {"playbook": {
  "required_for_crypto": true,   // crypto is traded only from a fresh lab playbook
  "max_age_days": 14,            // older playbooks are ignored (no crypto trades)
  "auto_refresh_days": 7,        // the daemon re-runs the lab in the background this often (0 = never)
  "top": 25,                     // coins the weekly lab run covers
  "min_target_r": 0,             // e.g. 2 = the weekly run keeps only exits that aim for 2R or more
  "confidence_sizing": true,     // risk per trade × the tier of the lab's profit chance on unseen trades
  "risk_tiers": [[0.9, 2.0], [0.8, 1.5], [0.7, 1.0], [0.0, 0.5]],
  "max_risk_mult": 2.0,
  "boost_min_test_trades": 30    // no boost above × 1 with fewer unseen trades than this
}}
```
A boost raises `risk_per_trade_pct` only; `limits.json` (`max_risk_per_trade_usd`, `max_position_pct`,
exposure, daily loss) still caps every order. A cut (× 0.5) also lowers the per-trade cap.

### `backtests/lab-crypto.json` — written by `trader-backtest/lab.py`
`{"generated_at", "universe", "coins", "timeframes": ["5m","1h","4h"], "days": {"5m": 180, "1h": 365, "4h": 730},
  "objective": "profit|win", "folds": 3, "costs": {"fee_bps", "slippage_bps", "round_trip_pct"},
  "grid": {...}, "rules": {"min_target_r", "min_pooled", "min_fold_test", "min_pooled_test", "min_test", "min_edge_r",
                           "profit_chance_trades"},
  "summary": {"families", "families_validated", "coins_validated", "per_coin_picks", "per_coin_survived",
              "per_coin_survival_rate", "seconds"},
  "families": [{"setup", "label", "timeframe", "train_until", "coins", "signals", "exit": {"stop", "atr_mult",
                "target_r", "horizon", "text"} | null (the exit chosen last), "train": {stats, latest training data},
                "test": {stats, every out-of-sample trade}, "folds": [{"train_until", "test_until", "exit", "train",
                "test"}], "validated": bool,
                "validated_coins": [...], "verdict", "highest_win": {"exit", "train", "test"} | null}],
  "validated": [{"symbol", "display", "setup", "timeframe", "exit", "train", "test" (out of sample), "recent" (latest
                 period), "validated": true, "why"}],
  "coins_detail": [... the same per coin, validated or not ...], "notes": [...]}`
stats = `{"n", "win_rate", "expectancy_r", "total_r", "profit_factor", "avg_win_r", "avg_loss_r", "max_drawdown_r",
"profit_chance"}` (net of costs; profit chance = share of 4,000 bootstrap runs of 20 trades that ended > 0).
Walk-forward: the history is cut into `folds + 1` equal periods; in fold k the exit is chosen on everything before
period k + 1 and traded in it. A family holds only if every fold made money (`min_fold_test` trades each) and the
pooled out-of-sample edge is ≥ `min_edge_r`; a coin is validated only if its out-of-sample edge is ≥ `min_edge_r`
over ≥ `min_test` trades and it did not lose in the latest period.

### `backtests/playbook.json` — what the autopilot may trade in crypto
`{"generated_at", "valid_until", "objective", "costs", "days", "families_validated",
  "entries": {"BTCUSDT:trend_breakout@1d": {"symbol", "display", "setup", "interval": "5m|1h|4h|1d", "stop": "auto|atr",
              "atr_mult", "target_r": 2.0 | null (rule exit), "horizon": "24h|60d",
              "exit_rule": null | {"type": "close_above_sma|close_below_low", "n", "max_bars", "text", "short"},
              "exit_text", "test": {"n", "win_rate", "expectancy_r",
              "profit_chance", "profit_factor"}, "train": {"n", "win_rate", "expectancy_r"}}}}`
Plans traded from it carry `"playbook": "<key>"` and `"interval"`; their `backtests/<key>-<setup>.json` is the
lab's test-period result (`"source": "backtest lab"`). Swing-setup ids use the bar time:
`BTCUSDT-20261021T1300-oversold_bounce`.

### `cache/lab/<symbol>-<interval>.json` — the lab's candle store (only the new tail is downloaded on re-runs)
`{"symbol", "interval", "source", "from" (how far back it was asked for), "updated_at", "candles": [[t,o,h,l,c,v]]}`

### `cache/funding/<BASE>.json` — perpetual funding by day (`shared/funding.py`)
`{"months": {"2024-07": {"<UTC day index>": <mean funding that day, fraction a year>}}, "updated_at"}` — complete
months from Binance's public archive (data.binance.vision), kept for good; the current month is fetched each hour
from Binance's futures API, or from Kraken's perpetuals (`PF_<BASE>USD`, hourly rate × 8760) where Binance refuses
the address. A month Binance has no file for is stored as `{}` (the coin had no perpetual then).
`funding.daily(base, days)` → `{day: rate}`; `funding.source_of(base)` → `binance | kraken | archive | None`.
The lab starts a funding rule's walk-forward where the data starts (earliest day + 50 days of warm-up).

### Rule-exit plans (daily setups)
Plans from `trend_ema` / `trend_breakout` / `trend_breakout_vol` / `breakout_volume` / `dip_in_uptrend` / `funding_squeeze` carry `"exit_rule": {"type", "n", "max_bars", "text", "interval": "1d"}`,
the setup's protective stop (`stop_rule`: 3×ATR, below the 10-day swing low, or 1 ATR under the broken
high), a target out of reach (1000R — the lab's rule trades have no target either) and a time stop of `max_bars` days. The autopilot checks the rule after
every daily close that happened after the fill and closes with `"reason": "rule"` (journal exit reason `rule`). The
Time Machine is skipped for them (it models stop / target / time only); the desk shows its gate as "not applicable"
and relies on the lab's walk-forward record. They need Bitcoin above its 200-day average
(`setups.regime_map(btc_daily)`) — except `funding_squeeze`, which has no regime and reads the coin's perpetual
funding instead (`levels.funding3`, the 3-day mean, annualised) — and their ids use the bar date:
`ETHUSDT-20261019T0000-trend_breakout`.

## v3.2 — 2 % risk, small leverage (opt-in, at most 2×), the trend profile

### `config.json` additions
```json
"leverage": {"stock": 1.0, "crypto": 1.0},  // wanted multiple of equity; only used when limits.json allows it
"borrow_rate_pct": 10.0,                    // simulator: yearly interest on borrowed (negative) cash
"autopilot": {"playbook": {
  "max_risk_pct": null,                     // e.g. 2 = confidence sizing never goes past 2 % per trade
  "setups": null,                           // e.g. ["trend_ema", "trend_breakout"] = trade only these from the playbook
  "timeframes": null                        // e.g. ["1d"]; both also narrow the weekly lab run
}}
```
`shared.config.leverage(cfg, limits, asset, broker)` → `(multiple, why)`: 1.0 unless `leverage.<asset>` > 1 **and**
`limits.json` has `allow_margin` (stocks) / `allow_leverage` (crypto); then `min(wanted, max_leverage, 2.0)`.
Never for meme coins, never for crypto at Alpaca (no crypto margin there). `LEVERAGE_HARD_CAP = 2.0` is code, not
config. Leverage lifts `max_position_pct` and `max_total_exposure_pct` by the multiple and lets the autopilot use
up to `cash + (leverage − 1) × equity` — never more than the broker's own buying power, and never borrowed money
at 1× even when the broker would lend it. Risk per trade is unchanged: the stop decides it.

### `limits.json` additions
```json
"stock":  {"max_leverage": 1.0, "max_risk_per_trade_pct": 2, "max_daily_loss_pct": 10},
"crypto": {"max_leverage": 1.0, "max_risk_per_trade_pct": 2, "max_daily_loss_pct": 10},
"global": {"max_daily_loss_pct": 10}
```
`max_leverage` is in the defaults (1.0); the `_pct` limits are optional and measured against the equity the order
was sized on, so they grow with the account (the sizer caps the risk budget at `max_risk_per_trade_pct`; the risk
check adds `max_risk_per_trade_pct`, `max_daily_loss_pct` and `max_daily_loss_global_pct`). Orders carry
`"leverage"` (and `sizing.leverage`); `no_leverage` blocks anything over the allowed multiple. The risk check now
measures % limits against `order.sizing.account_size` (the broker's equity for the autopilot), falling back to
`account_size`.

### Simulator and broker files
`broker/sim.json` gains `"interest_at"` (unix time interest was last charged) and `"interest_paid"`;
`account()` returns `"buying_power": cash + (leverage − 1) × equity`, `"borrowed"` and `"interest_paid"`.
`broker/equity.jsonl` lines gain `"borrowed"` / `"interest_paid"` when they are not zero. `autopilot/book.json`
items and the decision's `gates` (`"leverage"`) record the multiple used.

### `autopilot.py profile --risk 2 --leverage 1.5 [--stock-leverage 1] [--capital 1000] [--write]`
Dry run unless `--write`; then merges into your own `config.json` / `limits.json`:
config — `risk_per_trade_pct`, `account_size`, `leverage`, `autopilot.sim_starting_cash`,
`autopilot.playbook.{top: 10, setups: ["trend_ema", "trend_breakout", "funding_squeeze"], timeframes: ["1d"], max_risk_pct}`,
`autopilot.universe.crypto.top_n: 10`, `autopilot.adapt.{loss_streak: 7, symbol_loss_streak: 5, min_trades: 20,
max_drawdown_pct: 35}`; limits — crypto `max_open_positions 5`, `max_position_pct 25`, `max_total_exposure_pct 100`,
`allow_leverage`/`max_leverage`, stock `allow_margin`/`max_leverage`, `max_risk_per_trade_pct = risk`,
`max_daily_loss_pct = 5 × risk` (crypto, stock, global) and dollar backstops at 4× the account. Risk is 0–5 %,
leverage 1–2. Never touches `broker`, `mode`, `paper`, `live_confirmation`, keys or `autopilot.enabled`.

### Per-coin risk — `profile --core-risk 3 [--core-coins BTC,ETH]`
```json
// config.json
"risk_by_symbol": {"BTC": 3.0, "ETH": 3.0},          // % risk per trade for these bases; others: risk_per_trade_pct
// limits.json
"crypto": {"symbols": {"BTC": {"max_risk_per_trade_pct": 3.0, "max_risk_per_trade_usd": 120, "max_position_pct": 50}}}
```
Keys are the symbol's base, upper case. A `risk_by_symbol` value is a number above 0 and at most 5
(`SYMBOL_RISK_HARD_CAP`); a `<stock|crypto>.symbols.<BASE>` entry may set only `max_risk_per_trade_pct` (≤ 5),
`max_risk_per_trade_usd` and `max_position_pct` — anything else is a config error. `config.risk_pct_for(cfg,
symbol)` and `config.limits_for(limits, asset, symbol)` resolve them; the sizer, the risk check, the autopilot
(`_scaled`, `confidence_mult`, `usd_limits_binding`) and the replay use those. Meme tokens never read
`risk_by_symbol`. The profile writes both mappings whole (`config.update_file(..., replace=...)`), so a re-run
with other coins or without `--core-risk` removes the old entries; with a split the daily loss limits are
5 × the larger risk. The decision's gates gain `"risk for BTC"` when a coin has its own risk.
Keys are upper-cased when read (`"btc"` is BTC); `--core-coins BTCUSDT,eth/usd` is reduced to the bases. A `null`
inside a `symbols` entry is a config error (it would replace the asset class's limit with "no limit"); leave the
key out instead. `risk_by_symbol` applies to crypto only — a stock ticker BTC or ETH (Grayscale's mini trusts)
gets `risk_per_trade_pct`. `config.leverage(..., symbol)` keeps exchange-listed meme coins (`symbols.is_meme_base`)
at 1×; the sizer does too and the risk check blocks a leveraged one (`no_leverage`).
### Bybit EU broker (`shared/brokers/bybit.py`)
`autopilot.broker: "bybit"` — paper = Bybit EU's Demo Trading `https://api-demo.bybit.eu` (`BYBIT_DEMO_KEY` /
`_SECRET`), or with `autopilot.bybit.paper_venue: "testnet"` Bybit's global testnet `https://api-testnet.bybit.com`
(`BYBIT_TESTNET_KEY` / `_SECRET`; unset, the testnet is picked only when testnet keys and no demo keys are set) —
both hosts are fixed, no setting points paper at a live API; live =
`autopilot.bybit.host` or `https://api.bybit.eu` (`BYBIT_LIVE_KEY` / `_SECRET`, plus the same five-step opt-in as
Alpaca). `autopilot.bybit.quote` (default `"USDC"`) is the quote coin of the pairs (`BTC/USD` → `BTCUSDC`).
Spot only (category `spot`, Unified account): entries are GTC limit buys, `isLeverage` 1 only when
`config.leverage(..., "bybit", coin)` allows more than 1× (then spot margin is switched on, account leverage
set to 2, the quote coin made collateral and auto-repay switched on); stops are `orderFilter: tpslOrder` market
sells (with `limit_price`: limit sells); sales and stops are always `isLeverage` 0. `account()`: `equity` =
the bot's own sum — `cash` (Σ stable coins walletBalance − spotBorrow, negative while a loan is open) plus every
coin's net balance × its last spot price from `/v5/market/tickers` (never the wallet's `usdValue`: 0 for a coin
that is not collateral), `borrowed`; `positions()`: every non-stable coin with a positive net balance, `BTC/USD`
style, priced from the tickers. Order replies that do not say no (retCode 10000, 10016, 170007, 170032, 170035,
170146, a duplicate id) are looked up by client id; an order is never sent twice. A stop at or above the last
price is refused (spot TP/SL orders have no direction) and the bot's own stop check sells. 170359 (no spot margin
on the site) names `--leverage 1`. A filled buy's `filled_qty`
is net of the fee Bybit takes in the coin (`cumFeeDetail`). Client ids longer than 36 characters travel as a
hash and map back through `broker/bybit_ids.json`. Statuses map to the Alpaca names (Untriggered → new, Triggered
→ accepted, PartiallyFilledCanceled → canceled). `autopilot.py broker-test`: read-only calls (account,
positions, open orders, coins) with their latency. `profile --venue bybit` writes `costs.crypto` 15 + 3 bps,
`borrow_rate_pct` 20, `cash_yield_pct` 0, `autopilot.etf_trend.enabled` false and `autopilot.venue: "bybit"`;
it never sets the broker. The daemon wakes 5 s after 00:00 UTC (`next_daily_close`) instead of waiting out
its interval, so a daily signal is traded within seconds of the close.

`--fixed-risk` writes `autopilot.playbook.confidence_sizing: false` (a run without it writes `true`): with
`max_risk_pct` = the risk the tiers can only cut, so this keeps every trade at the risk as set.

## v3.3 — let winners ride (sell a third, keep two thirds while the trend lasts)

### Setup rule (`shared/setups.py`)
`trend_breakout` carries `"runner": {"keep": 0.67, "min_sma": 200, "exit_rule": {"type": "close_below_ema", "n": 50,
"max_bars": 250, "text", "short"}}`; `setups.runner(setup)` returns it, `setups.keep_text(0.67)` → "two thirds".

### `config.json` additions
```json
"autopilot": {"runner": {
  "enabled": false,      // let part of a winner ride (the trend profile turns it on; --no-runner keeps it off)
  "require_lab": true,   // only while the latest lab run found that riding on paid on unseen periods
  "keep": null           // share that stays in (default: the setup's 0.67)
}}
```

### Lab (`trader-backtest/lab.py`)
`rule_trades` adds `RUNNER_KEY` next to `RULE_KEY` for setups with a runner rule: the net R of the whole trade when,
after the exit rule fired in profit above the `min_sma`-day average, `keep` of it stayed in until the runner's rule,
its stop at the buy price (a stop-out or a losing trade is unchanged). `choose()` never picks it. Each family gains
`"runner": {"keep", "min_sma", "exit_rule", "test" (stats with riding, the same out-of-sample periods),
"test_without", "gain_r", "helps", "why", "folds": [{"without_r", "with_r"}]}` — `helps` = more R per trade and at
most 3 points less profit chance. Per-coin rows gain `"runner"` stats; playbook entries gain
`"runner": {"keep", "min_sma", "exit_rule", "helps", "why", "gain_r", "test"}`.

### Plans, book items, journal
Plans gain `"runner"` (`null` or `{"keep", "min_sma", "exit_rule" (+ "interval": "1d"), "status": "planned", "lab"}`)
and `"runner_note"`; the decision gets a gate `"let winners ride"` saying why it will or will not. Book items carry
`"runner"`, `"setup"` and `"entry_plan"`. When the exit rule fires: `ride_check` (in profit after round-trip costs,
coin above its `min_sma`-day average, the position splits into lot-sized parts) → `sell_part` (cancel the
protective stop, market-sell `1 − keep`) → `start_ride` on the fill: the journal trade is closed for the sold
quantity (`"runner": {"part": "sold", "of_qty"}`) and a new open trade `<id>-ride` holds the rest
(`"runner": {"part": "ride", "from"}`, stop at the buy price); the book item switches to the runner's exit rule,
stop = buy price, target = entry + 100R, time stop = now + `max_bars` days, and a new protective stop for the rest.
`runner.status`: `planned` → `selling` → `riding` (or `skipped` with the reason in the exit note, or `failed` →
everything is sold next cycle). A sale that a real broker fills later is picked up by `reconcile`; one not seen
within 30 minutes counts as failed. The ride's rule only looks at bars that closed after the ride started.
`adapt` judges a ride together with the trade it came from (`part: "ride"` trades are not counted on their own).
`broker/positions.json` rows gain `"story"` (plain words: what is held, what happens next) and `"riding"`.

## v3.4 — bear markets: ETF trend while crypto is in a bear market, interest on idle cash

### Setup `etf_trend` (`shared/setups.py`, asset `stock`, daily)
The trend-following rule (20 EMA above the 50 EMA, close above the 20 EMA, higher highs and higher lows, the day it is
confirmed) with the instrument's **own** close above its 200-day average instead of Bitcoin's; stop below the 10-day
swing low (≥ 1 ATR); exit at the first daily close below the 50-day EMA (≤ 250 days).

### `config.json` additions
```json
"cash_yield_pct": 0.0,        // simulator: yearly interest on idle (positive) cash — T-bills; profile sets 4
"autopilot": {"etf_trend": {
  "enabled": false,           // the trend profile turns it on (--no-etf keeps it off)
  "when": "crypto_bear",      // only while Bitcoin's last daily close is below its 200-day average; "always" = any time
  "required_lab": true,       // only ETFs in backtests/playbook-etf.json
  "symbols": ["SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "DBC", "UUP", "XLE", "XLF", "XLK", "SMH"]
}}
```

### Lab: `trader-backtest/lab.py --etf`
Same walk-forward on daily ETF bars (Yahoo, ~8 years, stock costs) for the stock series setups; writes
`backtests/lab-etf.json`, `backtests/playbook-etf.json` and `reports/lab-etf.html` (the crypto files are untouched);
`lab.history(..., asset)`, `lab.load_playbook(now, max_age, path)`, `lab.write_playbook(doc, now, path)`. The weekly
refresh runs it too when `etf_trend.enabled`.

### Autopilot
`etf_candidates(cfg, book, memo, now)` runs once per cycle between 9:45 a.m. and 3:30 p.m. ET while the US market is
open: `crypto_bull(memo)` checks Bitcoin's daily close against its 200-day average; each validated ETF fires when the
rule is met on its newest closed daily bar (weekends and holidays don't age it; the desk keeps a daily stock idea
fresh for 96 h). Plans for daily stock bars are **swing** plans: `"swing": true`, time stop = entry + `max_bars`
days (`exit.plan_levels(..., swing=True)`), the order goes out as a GTC bracket at Alpaca (`order["swing"]`), the
book item carries `"swing": true`, and the rule exit is only checked while the US market is open.
`_series_candidates(..., asset)` serves both crypto and ETFs.

### Simulator
`_charge_interest` also credits idle cash at `cash_yield_pct` (`book.interest_earned`, `account()["interest_earned"]`,
`broker/equity.jsonl` `interest_earned` when not zero).

## v3.5 — the checks: six desks per decision, "is it normal?", backtest vs reality

### Lab families gain `test_trades`
`[[exit time, R], …]` of every out-of-sample trade in time order (and `runner.test_trades` with the part that rode
on); `rule_trades(..., exits={})` records when each trade (and its ride) ended.

### `config.json` → `autopilot.health`
`{"enabled": true, "min_trades": 10, "window": 30, "alarm_pct": 10, "watch_pct": 25, "pause_on_alarm": true,
"paths": 2000, "block": 20, "cap_r": 3, "alarm_checks": ["losing streak", "recent result", "drawdown"]}`

### `autopilot/health.json` — written every cycle by `shared/health.update`
`{"updated_at", "enabled", "status": "early|normal|watch|alarm|unknown|off", "trades", "window", "text",
"checks": [{"name": "losing streak|recent result|drawdown", "value", "p" (share of histories at least this bad),
"verdict", "text"}], "since" (control.dd_reset_at — resume starts the record over), "alarm_since", "history"}`.
Live trades come from the journal (autopilot, closed); a runner split (`sold` + `<id>-ride`) counts once, as the
summed P&L over the original risk. Wins count up to `cap_r`. Only setups with lab trades are judged; the others
are counted in `"not_judged": {setup: n}`. A new alarm pauses new entries (`autopilot.check_health`) and notifies.

### `autopilot/shadow.json` — once a UTC day (housekeeping thread) and on `autopilot.py check`
`{"updated_at", "days": 30, "since", "verdict": "ok|check", "counts", "avg_slippage_bps", "problems": [...], "text",
"rows": [{"id", "symbol", "asset", "setup", "signal_at", "signal_price", "outcome":
"taken|ordered|skipped|error|missed|extra|pending|not expected", "fill", "slippage_bps", "status", "reason"}]}`.
Signals are recomputed with `setups.series_signals` on every daily playbook entry (crypto + ETF) and matched to
decisions/book items by id (the first decision on an id, unless a later one placed the order); ETF signals while
crypto is in a bull market (or with the ETF trend off) are "not expected". Signals whose bar closed before the
bot's first cycle (`autopilot/state.json` `started_at`, an hour of slack) are left out — `since` says from when.

### Dashboard
`GET /api/checks` → `{"health", "shadow", "board": [board_view(decision)]}` for the last 12 decisions that went
through the desks; `board_view` sorts each gate into research / news / strategy / execution / risk / boss
(`pass|fail|none`), adds the desk verdict, marks the desk that stopped a rejected trade, and sets
`call`: BUY / WOULD BUY / REJECT / ERROR. The **Checks** tab renders it.

## v3.6 — hardening: crashes, races, two traders, honest backtests

### State files (`shared/state.py`)
Every write goes through a temp file of its own (`.<name>.<random>.tmp`), flushed and fsynced, then renamed; the
same text is then written to `<name>.bak` (not for `cache/`). A read of a broken file (a typo, an empty file)
falls back to its `.bak` and notes it in `state.recovered` (the autopilot reports those as errors and takes no new
entries that cycle); with no good copy it raises `state.StateError` (a `ValueError`, never `SystemExit`).
`state.locked(name)` serialises a read-modify-write across threads and processes (`trader/.locks/`), and
`state.update_json(name, fn, default)` does read → change → write under it — used for `orders.json`, `plan.json`,
`journal.json`, `tickets.json`, `x_usage.json` and `autopilot/control.json`. `config.json` / `limits.json` that
can't be read raise `config.ConfigError` (a `ValueError`): CLI tools print it and exit 2; the daemon keeps the last
good settings, manages exits and takes no new entries until the file is fixed.

### Autopilot
* One cycle at a time per folder (`state.locked("autopilot/cycle")`) — daemon, dashboard loop and CLI runs queue.
* `reconcile` / `manage_exits` handle each book item on its own; one that fails gets `"error"` and the others still
  get their stops, targets and time stops. Bookkeeping (broker files, learning, health, daily loss) that fails
  stops new entries for that cycle, never the exits.
* Book items: an entry that fills partly (a cancelled order with `filled_qty > 0`) becomes a trade of that size with
  its own stop; a crypto stop is sized from the position the broker reports (fees taken in the coin). Exits and the
  kill switch sell only the bot's own quantity and cancel only its own orders (`_mine`: its bracket legs, stop and
  exits) — shares or coins you hold yourself on the same symbol are never touched. A position whose stop order is
  gone (Alpaca cancels GTC orders after 90 days) gets it back, at most once an hour (`stop_retry_at`); a crypto
  stop-limit the price fell through (more than 0.5 % below the stop) is closed by the bot.
  `"rule_check"` says when a rule exit could not be judged (too few bars from the data source); the rule is checked
  on every daily close since the fill, so a bot that was down still exits.
* The book item is saved right after the broker accepts the order; the client order id is `ord-<signal id>`, so
  an order sent twice is refused as a duplicate and found again (Alpaca, and the simulator) instead of doubled.
* A daily signal is judged once: only on the newest closed bar, and `book.handled` is read across the last 7 days
  (older days are pruned); a signal id already in the book is never traded again.
* Meme coins listed on exchanges (`symbols.MEME_BASES`: DOGE, SHIB, PEPE, BONK, WIF, …) are left out of the
  universe, the playbook coins and refused by `judge` — unless `autopilot.memes.enabled` (v3.11).
* Waiting entries count for `risk.open_book` (open positions, exposure) and hold their cash in the simulator.
* While positions or entries are open, failing cycles back off for at most `HOLDING_BACKOFF_SEC` (120 s).
* `replay` runs only on the simulator and never next to a running daemon; it writes no heartbeat.

### Dashboard
Without a password only `localhost`, `127.0.0.1` and `::1` (plus `TRADER_DASHBOARD_HOSTS`, comma-separated) are
answered as `Host` — DNS rebinding is refused. KILL also sets `run_once` (the daemon acts within seconds). The
dashboard's own loop defers to a daemon holding the OS lock, even before its first heartbeat. Logins are checked one
at a time (≤ 2 guesses a second); a request socket times out after 30 s.

### Alpaca
Stock symbols are never rewritten (`GBTC` is not `G/BTC`); `orders()` reads 500 and merges every open order;
`lookup(id)` fetches an order (and its legs) by id for orders older than that; a 422 "client_order_id must be
unique" after a lost response finds the order that landed; lookups retry; redirects are refused (the key headers
never travel elsewhere). Fractional stock quantities are floored to whole shares for bracket orders (Alpaca has no
fractional brackets). Crypto uses Alpaca's own `price_increment`, `min_trade_increment` and `min_order_size`
(from `/v2/assets`). `OPEN_STATUSES` adds `done_for_day` and `pending_cancel` and drops the final `replaced`.

### Lab: point-in-time universe (`--universe point-in-time`, the default without `--symbols`)
Today's top coins are partly there because they rose — a backtest on them alone flatters every trend setup. The lab
now loads every coin that was ever among the biggest on Binance (`PAST_MAJORS`, delisted ones included, Binance
history only), splits a coin delisted and relisted under one ticker into listings (`LUNAUSDT~2020-08` vs
`LUNAUSDT`), and counts a trade for the setup only if its coin was among the `--top` coins by 30-day dollar volume
when its period began. Families gain `"universe": "point-in-time|fixed"` and `"members": [[keys], …]` (one list per
period). Per-coin rows are made for today's coins only and use each coin's whole history; a coin is validated only
if it also traded in the latest period and its history reaches today. Playbook entries: `"test"` is now the
setup's (point-in-time) result — confidence sizing uses it — and `"coin_test"` the coin's own. With
`autopilot.broker: "alpaca"` crypto fees default to Alpaca's 25 bps per side. `--universe today` keeps the old way.

### Dashboard — launch checklist (v3.6)
`GET /robots.txt` → `Disallow: /` (public); every response carries `X-Robots-Tag: noindex, nofollow`. Unknown
non-API paths get an HTML 404 page (`/api/*` keeps JSON errors). `index.html` links `app.js` / `app.css` with
`?v=<asset_version()>` — cached `immutable` until they change; other static files an hour; API responses stay
`no-store`. Text responses ≥ 1 kB are gzipped when the client accepts it. `static/manifest.webmanifest`,
`icon-192.png`, `icon-512.png` (maskable) and `apple-touch-icon.png` make it installable on a phone.
`Referrer-Policy: same-origin` (with `no-referrer` a browser posts the login form with `Origin: null`);
`_same_origin` honours `Sec-Fetch-Site` and accepts `Origin: null` only when the browser says `same-origin`.
The **Help** tab (`renderHelp`) holds the FAQ, the privacy note and the terms of use; `document.title` follows the tab.

## v3.7 — round three: wrong settings, orders lost in a crash, hangs, months of running

### Settings (`shared/config.py`)
`config.json` and `limits.json` are checked against the defaults' types: a number written as text (`"5%"`), a
switch written as `"false"`, an object replaced by `null` or a list by a string is a `ConfigError` listing every
problem — never a quiet "yes" or "no limit". An explicit `null` for a number that has a default keeps the default
and is listed in `config.warnings`. `max_daily_loss_*`, `max_risk_per_trade_*`, `max_position_pct`,
`max_total_exposure_pct`, `max_leverage`, `risk_per_trade_pct`, `account_size`, `max_risk_mult` and
`interval_sec` must be above 0 (0 would not switch them off); `interval_sec` is at least 5. Switches
(`enabled`, `allow_*`, `*_enabled`) count only when literally `true`; `paper` means real money only when
literally `false`. The daemon keeps the last good settings of its own folder while a file is broken.

### State files
`state.locked(name, timeout=None, stop=None)` waits at most `timeout` seconds (then `state.LockTimeout`), gives
up when `stop()` turns true, and writes `pid@host` into the lock file (shown when it times out). A broken file
restored from its `.bak` is kept as `<name>.broken`, and the good copy is written back in its place.

### Downloads (`shared/http.py`, Alpaca)
The whole body must arrive within twice the socket timeout (a server trickling a byte a second can't hold a
cycle), a body shorter than its `Content-Length` is a failed request, and one URL gets at most
`timeout × 3 + 30` s including retries and back-off. Cut-off, garbled or gzip-broken answers are failed requests
(the stale cache answers when it can). An Alpaca order whose answer is lost says "may or may not have been
placed" and is looked up; `broker.find_client(client_order_id)` finds it later.

### Autopilot
* Book status `"submitting"`: the item is saved before the order is sent. The next cycles look for it by client
  order id (`ord-<signal id>`), at the broker itself after 10 minutes; found → `"pending"`, never found after 30
  minutes → `"canceled"`. A refused order (4xx) removes the item; an unclear failure keeps it with `submit_error`.
  It counts as open for every cap, the kill switch and `risk.open_book`.
* KILL stays on until nothing is left (`kill_tries` counts the cycles); the daily-loss kill fires once a day and
  later cycles that day take no new entries.
* `run_once` is used up after the cycle that saw it (one set during the cycle is kept for the next).
* Exits, stops and the kill switch count and cancel only the bot's own orders (its bracket legs — remembered as
  `leg_ids` at the fill — its stop and exits, and client ids starting with `ord-<plan id>`). A stop
  re-placement the broker refuses keeps the old `stop_order_id`.
* Splits: a held stock whose broker quantity and average price moved by a split ratio gets
  its quantity, stop, target and fill scaled in the book (2-for-1 up to 50-for-1, and the reverse), the journal
  trade with it, and a notification.
* PDT: with Alpaca, under $25,000 equity and 3 day trades in 5 days, no same-day stock trade is sent.
* No new stock entries in the last 30 minutes of the session (early closes included).
* Alpaca crypto fills are booked net of the 0.25 % fee taken in the coin; sells keep that room.
* The AI desk times out after `ai_desk.timeout_sec` (45 s, one retry); an AI review that fails is a NO-GO for that
  trade (it can only veto, so failing closed costs nothing but the trade).
* Time limits: a cycle waits at most 600 s for another process's cycle; after 240 s it judges no more ideas and
  checks the exits again; the news refresh before a trade gets 45 s; on SIGTERM / SIGINT / SIGHUP it judges no
  more ideas. A cycle running for 20 minutes makes the daemon exit with code 70 (`heartbeat.status: "hung"`).
* `heartbeat.json` gains `last_ok_at` (the last cycle that worked); `deploy/healthcheck.py` fails once that is an
  hour old while the status is `error` or `hung`.
* Housekeeping runs each job on its own; a failure goes to `autopilot/housekeeping.jsonl`. The lab runs as a
  `nice` subprocess (`python3 trader-backtest/lab.py …`, time limit), its last attempt is kept in
  `autopilot/housekeeping_state.json` so a restart does not start it again.

### Sizer
Entry and stop must be finite numbers above 0, and the stop at least 0.1 % below the entry; the broker's equity is
used even when it is 0 (then nothing is sized), never the configured size instead.

### News
The feed is fetched outside the lock and merged under it — a slow X / StockTwits request no longer blocks the
dashboard or the autopilot's news gate.

### Dashboard
10 wrong passwords from one client within 10 minutes → `429` for the rest of those 10 minutes.

### Months of running (v3.7)
* **Download cache.** Kline URLs (Binance, Coinbase, GeckoTerminal) end on a bar boundary, so one bar is one URL
  and repeats hit the cache; `cache/http/` entries older than 24 h (the stale-copy limit) and temp files older
  than an hour are deleted every 6 hours (`FileCache.prune`). A geo-block (HTTP 451) is retried after 6 hours.
* **Simulator.** `sim.json` gains `"walked": {symbol: bar time}` — each sync walks only the bars after the last
  one it walked — and `"archived_until"`: finished orders and fills older than 30 days move (once a day) to
  `broker/sim-archive.jsonl` (`"kind": "order" | "fill"`); a bracket stays whole while a leg still works. A book
  that cannot be saved (full disk) sets `save_error`: the cycle goes on in memory and opens nothing new.
* **Pruning (`autopilot.prune_state`, housekeeping every 6 h, also in `autopilot.py loop` and the dashboard's own
  loop).** Closed or cancelled book items, and plans, entries and orders, older than 45 days move to `archive/book.jsonl`,
  `archive/plan.jsonl`, `archive/entries.jsonl`, `archive/orders.jsonl` (anything a live book item or
  `alerts.json` points to stays). `desk/<id>/`, `timemachine/*.json` and `backtests/<sym>-<setup>.json`
  untouched for 45 days are deleted (`lab-*` and `playbook*` never). Logs past a size are rotated into
  `archive/<name>-<YYYYMMDD>.jsonl.gz` (decisions past 64 MB keep their newest 24 MB; the archive files
  themselves are gzipped past 8 MB). `journal.json`, `approvals.jsonl` and `broker/equity.jsonl` are never cut.
* **Equity compaction** keeps, before the last 7 days, each hour's highest line and its last — the drawdown
  limit's peak survives it (`adapt` re-reads a compacted file without forgetting the peak; a replaced file, e.g.
  a fresh simulator, starts over).
* **Writes.** `state.write_json` skips a write when the bytes are unchanged; `desk/` and `timemachine/` get no
  `.bak`; `cache/` files are written without indentation. `state.append_jsonl` cuts off a half-written line
  when the disk is full; `state.append_jsonl_rows` appends many records in one write.
* **Reads.** `state.tail_jsonl(name, n, stop)` reads a JSONL file backwards: the cycle's daily counts, the daily
  summary, the shadow check, the dashboard's decisions and checks, and the risk check's trade count read only
  what they need. `/api/desk` returns the newest 60 reviews. The health check's simulated histories are
  computed once per record, not every cycle; the risk check reads `orders.json` once per call.
* **Disk.** Under 200 MB free, the cycle opens nothing new (exits go on); under 1 GB, housekeeping empties the
  download cache and notifies you (every 6 hours at most).
* **Lab store.** 5-min bars older than the run's window plus 30 days are dropped from `cache/lab/`.

## v3.8 — round four: a real broker between two requests, a KILL that ends, the lab and the bot alike

### Exits at a real broker (`trader-autopilot/autopilot.py`)
* Before selling, the bot cancels its own sell orders (stop, legs, exits) and **waits up to 6 s for the broker
  to confirm** (`broker.lookup`): a cancel still pending holds the quantity (Alpaca refuses the sale), and a
  stop that filled in between already sold — the sale waits for the next cycle instead of coming out of shares
  you hold yourself. The runner's partial sale does the same.
* A sale the broker **refuses** (Alpaca's wash-trade guard against your own open buy order, the day-trade rule,
  an asset no longer tradable) puts the protective stop back at once, also for intraday stocks; the sale is
  retried after `EXIT_RETRY_SEC` (15 min) and you are notified once. Book item: `exit_refused_at`,
  `exit_refused`. A sale whose outcome is unclear places no stop (it may have gone through).
* An exit order still open (`exit_order_id`, e.g. queued after hours) is not sent again — by exits or the KILL.
* A stop id the broker does not list counts as working only for 10 minutes after it was placed.
* Splits: `broker_qty` / `broker_avg` remember last cycle's broker position; a split is a quantity and an
  average that moved by the same ratio since then (your own shares blended into the average are no split).
* One position per **broker symbol** too (BTCUSDT and BTC-USD are one BTC/USD at Alpaca).
* An open order under the bot's client id (`ord-…`) that no book item owns is reported once (`orphans_told`
  in `state.json`); a blocked or suspended account (`account().blocked`) and an account without crypto stop
  new entries; the PDT check uses `last_equity`.
* A 422 "client_order_id must be unique" whose order can't be read yet is "may or may not have been placed"
  (the entry stays `submitting`), never "refused". `cancel_all` / `close_all` are gone.

### KILL
The first `cancel_asked_at` is kept (a never-answered entry is cancelled 30 min after the first ask). With
`flatten_on_kill: false` the kill cycle still runs the exits. A refused KILL sale puts the stop back.

### State and files
* `state.append_jsonl_rows` holds the log file's own `flock` while it appends; `state.rotate_jsonl` holds it while
  it streams the old part into gzip and swaps the file — appends wait and go to the new file (no line lost,
  no 2× memory). A failed append never cuts off another writer's line.
* A broken file is repaired under its lock, only if it still holds the same broken bytes; the broken bytes are
  copied to `<name>.broken` and the file is never missing in between.
* `trader/` and its folders are created `0700`, new logs `0600`; a `secrets.env` other users can read is
  reported at start (dashboard and daemon). Errors on stderr are redacted.
* The simulator refuses an order it cannot save (`BrokerError`) — a sync goes on in memory.
* `state.read_jsonl` splits on `\n` only (U+2028 in a headline is no line end).

### Time and data
* A bar that closed after its data was downloaded (or cached) is never counted as closed (`http.track` /
  `http.oldest_fetch`, `data._asof`).
* `replay` refuses a folder whose simulator or cycles already ran past `--from`; the simulator never charges
  interest backwards.
* The global daily limits (loss, trade count) count the UTC day; per-asset limits keep the asset's day.
* The 23:55 UTC crypto bar is judged after midnight; the daily summary covers the New York day it is named
  after; a playbook made after "now" is refused; Stooq daily bars are stamped at the session open; the ETF
  time stop is 12:55 on early-close days; the drawdown reads equity lines dated after a clock step.

### Lab and live alike
* Daily signals (`interval: "1d"`): `plan.entry_slack_pct` = a quarter ATR above the close (0.5–2 %); the sizer
  sizes the risk at that worst price and sets the limit there; the entry keeps working `DAILY_ENTRY_WAIT_SEC`
  (1 h).
* The runner also starts after a time stop (the lab rode after both); the sold part's journal reason is `time`.
* `bootstrap_profit_chance` draws circular runs of `BOOTSTRAP_BLOCK` (10) trades from pools in time order.
* `lab.py --etf` tests the ETF trend only on crypto-bear days (`--etf-when crypto_bear|always`, default from
  `autopilot.etf_trend.when`); families carry `"when"`.
* Live 1h / 4h series fetch ~1,000 bars (`SERIES_HISTORY_DAYS`).

### Dashboard login
The throttle keys on the last `X-Forwarded-For` entry (the one the proxy appended) when the peer is loopback or
a private address (Docker's bridge); besides 10 wrong passwords per client, 50 per 10 minutes from everyone
refuse logins for a while — logged-in browsers and the CLI keep working.

### Other
`config.update_file` validates before writing; `"leverage": 1.5` (one multiple for all) is accepted; `profile`
dollar limits never round to 0; `nohup … daemon` survives a closed terminal; the watchdog times the cycle, not
the wait for another process's lock; the lab runs under `nice -n 10`; the download cache is pruned in a
background thread (and to its last hour when the disk is low).

## v3.9 — round five: another account's trades, lost answers, your own orders and coins next to the bot's

### Whose trade it is (`trader-autopilot/autopilot.py`)
* Every book item carries `broker` and `mode`; exits, stops, the reconcile and the KILL act only on items of the
  broker and account the bot talks to now (`_here`). A simulator or paper trade left in the book when you move
  to Alpaca is never sold, given a stop or "killed" out of the new account: the cycle reports it, opens nothing
  new, and `brokers.live_readiness` refuses the live switch until it is closed there and forgotten
  (`autopilot.py forget --confirm FORGET` sets such items to `"left"`).
* **Your own holdings and the daily-loss limit** (`yours_today`, `day.json` → `yours`, `yours_day`): the daily
  loss is how far equity fell since the UTC day began **plus what your own coins and shares at the broker made
  today** — so your BTC falling is not the bot's loss. Only price moves count (quantity × change between cycles);
  buying or selling them yourself moves nothing, and what they moved before you sold stays counted for the day.
  The bot's share of a symbol is its open trades plus what of a pending entry already filled (`filled_qty`).
  Equity, sizing, `equity.jsonl` and the drawdown pause keep the broker's figure.
* A live bot is no longer stopped by a simulator or paper trade left in the book: `brokers.get` checks the five
  opt-in steps only (`live_readiness(cfg, book=False)`); the cycle keeps exits and the KILL of the live trades
  and opens nothing new until the old trade is forgotten. `check-live` and `status` still list it.

### Exits next to your own orders
* Alpaca refuses a market sale and a plain stop while you have your own buy order open on the symbol (the
  wash-trade guard). The sale is sent again once as a **limit 1 % under the last price** (`WASH_LIMIT`), the
  stop goes back as a **stop-limit 3 % under the stop** (`WASH_STOP_LIMIT`, client id `…l`); the KILL does the
  same. `broker.place_stop(..., limit_price=None)` is new in all adapters.
* A limit sale like that which the price fell below, or that waited `EXIT_RETRY_SEC`, is cancelled and sent again
  at the new price — by the exits and by the KILL (`exit_limit`, `exit_limit_at` in the book item). A queued
  market sale (a stock after hours) still waits for the open.
* A sell order of the trade that filled in part and then was cancelled or expired is booked (`parts_booked`):
  the part becomes its own closed journal trade, the rest stays open under `<trade id>-<n>` with the smaller
  quantity — the next sale never comes out of your own coins.
* The exit reason (`exit_reason`) is on disk before the sale goes out: a crash right after it still journals
  the trade as time / stop / rule, not "manual".
* A closed position whose answer was lost (timeout, 5xx) is "may or may not have been placed", never "refused" —
  no stop is put back over a sale that may have gone through. An entry like that is `unsure` in `orders.json`
  and looked up by its client id next cycle.
* A cancel pending since the last cycle is still waited for; a stop that partly filled and was cancelled counts
  as sold; a price through the stop sells even while a refused sale backs off; the back-off is forgotten after
  the sale. A closed trade cancels its own leftover sell orders.
* Exit client ids carry milliseconds (`ord-…-x<ms>`).

### Simulator (`shared/brokers/simulator.py`)
* One symbol without prices (`sync_errors`) no longer stops every other symbol's fills; the cycle says which
  symbol waits and opens nothing new.
* An order sent twice under one client id is one order (the first is the answer); an id whose order was
  cancelled is refused, like Alpaca.
* `close_position` sells the position and nothing else — like Alpaca's `DELETE /v2/positions/{symbol}`, other
  open orders on the symbol stay (the autopilot cancels its own first).

### State and files
* `state.append_jsonl_rows` writes unbuffered (`os.write`) and on failure truncates back to where it began: a
  full disk loses only the record that did not fit, and the next one lands on a clean line.
* `state.rotate_jsonl`: a part the archive could not take (a full disk) is kept as `.<archive>.<id>.pending`
  next to it and added to its own archive on a later rotation.
* `state.write_json` writes files that keep a `.bak` under their lock (10 s), so two writers never leave the
  copy and the file from different moments.
* `keep`, `min_sma`, `max_bars`, `top_n`, `top` must be numbers in `config.json`, even without a default.

### Judge and lab
* A coin with too little history for the Time Machine is a skip ("Time Machine: …"), not a cycle error.
* `lab.rule_trades`: a signal while the previous trade's two thirds still ride is counted only for "sell
  everything" — with the runner on, the bot holds that coin and never takes it (one position per coin, as
  live). On real data: 476 trades, 394 of them with the runner.

### Manual tickets, symbols, deploy
* A "yes" needs `--ticket <id>` when several tickets wait; a live ticket needs the full five-step live opt-in;
  expiry runs on the real clock; the approval is checked and saved under `state.locked("tickets.json")`.
  Manual crypto at Alpaca gets no leverage (sizer and risk check).
* Meme coins in lot spellings (`1000PEPE`, `KPEPE`, `1MBABYDOGE`) are meme coins (`symbols.is_meme_base`); the
  block list matches any spelling (`SOL/USD` blocks `SOLUSDT`) in risk, universe and the playbook step.
* The block list strips only dollar and euro quotes: `ETH/BTC` blocks that pair, not all of ETH; `WBTC` is not
  the coin `W`. A manual ticket's leverage check assumes Alpaca unless `connector` says otherwise.
* Deploy never ships a nested `trader/` folder or `.env`; a request carrying a credential (the X token, the
  ntfy token) follows no redirect;
  an infinite limit in `limits.json` is refused; the risk of a daily entry is measured at its slack limit.

## v3.10 — round six: a €1,000 account, the runner's part sale, the simulator's coarse bars

### Limits and the daily loss
* `autopilot.daily_loss_action`: `"kill"` (default — cancel entries, sell what the bot holds if
  `flatten_on_kill`, stay killed until resumed) or `"stop_entries"` (no new entries until tomorrow UTC;
  positions keep their stops and exits). `profile` writes `"stop_entries"`: a trend trade held for weeks is
  not sold because one day was bad.
* `usd_limits_binding`: a `*_usd` limit that now cuts below its `%` twin (the profile's 4× backstop after
  the account grew) is listed in the cycle notes and notified once (`usd_limits_told` in `state.json`), with
  the `profile --capital <equity> --write` command to re-derive it. The bot never raises a limit itself.
* `profile` refuses `--capital` ≤ 0, inf or nan, and `--cash-yield` outside 0–20.

### One account at a time
* `account()` carries `account_id` (simulator: `sim-<created_at>`; Alpaca: the account number);
  `account_key()` = `broker/mode/account_id`. Equity lines carry `account`; `day.json` carries `account`.
  A switch (paper → live, a deleted `sim.json`) starts the day's equity and the drawdown peak again — another
  account's equity is no loss. `_realized_today` counts only trades of the same broker and live/paper.

### Quantities and partial fills
* `broker.qty_step(symbol, asset)` (Alpaca crypto: `min_trade_increment`; else 0). At the fill the bot's
  crypto quantity is floored to it, so the stop covers the whole trade; a sale whose remainder is under one
  step closes the position (fee dust goes with it). The minimum-order error shows the quantity asked.
* A runner's part sale that times out is cancelled and confirmed before the whole is sold; the KILL cancels
  it too and marks the ride `failed`. An order `done_for_day` is booked only when it ends.

### Your own holdings (`yours_today`)
* Each symbol keeps `whole` (the whole position) besides your `qty`: a split is judged on the whole position.
  On a new UTC day the baseline is yesterday's last quantity and price (the day's start equity is yesterday's
  last equity too).

### Simulator
* `_walk_series`: the 5-minute bars, or — only when they start after the first bar the walk needs (stocks:
  the next session's open) — hourly, then daily bars, cached apart (`_coarse`). Marks, `_last_close` and
  market sales stay on 5-minute prices; a failed download waits a cycle. `walked_step` remembers a coarse
  walk; a bar is walked when its end lies past the end of the last bar walked.

### State
* A rotation part claimed by a process that died (`.<archive>.<id>.<pid>.claimed`, older than an hour) goes
  back to `.pending` and is archived.

### Lab (v3.10)
* `lab.together(rule_setups, coins, …)`: the rule-exit setups of one timeframe are scored side by side, one
  position per coin — a coin held by one setup (until its ride ends) is skipped by the others; on the same
  day the earlier setup in `--setups` goes first. Each family carries `shared_with`; its trades, validation
  and per-coin rows count only what it gets.
* `runner_verdict(..., pairs)`: the ride is judged on the same trades with and without it, and — once there
  are `RUNNER_MIN_AFTER` (30) of them — only on trades after the runner's `designed_until` (2022-12-31);
  `judged_on` says which.
* `bootstrap_profit_chance`: runs are at most a quarter of the sample long.
* ETFs (`etf_context`: `fill: "next_open"`): bought and sold on a rule exit at the next open; a day the bot
  would not trade (`entry_ok`) is skipped before the one-at-a-time walk, so it never blocks a later signal.
* Coins and pooled rows are ordered by (time, coin) — the same profit chance on every run.

### Verification of round six (v3.10)
* `_queued_exit`: an exit sent earlier in the same cycle (the reconcile's sale after a runner's failed part
  sale) is looked up at the broker when the cycle's order list doesn't hold it — working or filled, the exits
  and the KILL don't sell again.
* `daily_loss_action: "stop_entries"` holds for the rest of the UTC day once reached — a bounce doesn't lift
  it. A value other than `"kill"` / `"stop_entries"` is a config error (`config._CHOICES`).
* On an account switch the day starts again without your old holdings' move (`yours` = 0 that cycle) and
  without trades closed before the switch (`day.json` → `account_since`); adapt keeps each account's peak
  (`peaks`), so going back to an account restores its own drawdown.
* The dollar-limit notice names limits.json first and is sent once per set of binding limits.
* Lab: setups are scored alone first; only those that validate are scored again side by side, and a coin is
  held until the ride ends only where `autopilot.runner.enabled` and the lab says the ride pays.
* A coin traded only on daily (or 1h/4h) rules is not scanned on 5-minute bars every cycle.
* Sub-step dust: when what is left after the bot's sale is under one broker increment, the whole position is
  closed — that may include a sub-increment amount of your own coins (it can't be sold on its own anyway).

## v3.11 — established meme coins, only when you switch them on

`autopilot.memes` (default `{"enabled": false, "max_rank": 40, "min_listed_days": 365, "risk_mult": 0.5}`;
`autopilot.py profile --memes` switches it on). A meme coin listed on the exchanges (`symbols.MEME_BASES`, any lot
spelling) may then be traded like any coin, but only:
* while it is among the top `max_rank` coins by market cap (CoinGecko `market_cap_rank`; unknown rank = no) — the
  universe checks it every refresh, and playbook coins never bring a meme coin in by themselves;
* when the backtest lab validated it — in the point-in-time lab a meme coin is a member of a period only after
  `min_listed_days` of history before that period (`lab.pit_members(min_days=…)`, `lab.PAST_MEMES`);
* when its daily history on the exchange is at least `min_listed_days` long (`autopilot.meme_refusal`);
* at `risk_mult` × the normal risk (a "meme coin" gate in the decision).
DEX tokens (asset `meme`: pump.fun, Raydium, …) are never auto-traded and never sent to a broker.

## v3.12 — the meme-coin sniper (`trader-sniper`)

A separate skill, separate from the autopilot (its own loop, book and budget). Config `sniper` (see
`shared/config.py` defaults): `enabled`, `mode` (`paper` | `live`), `chains`, `trade_usd`, `max_open_usd`,
`max_positions`, `max_trades_per_day`, `daily_loss_usd`, `wallet_cap_usd`, `slippage_bps`, `priority_lamports`,
`min_liquidity_usd`, `min_age_min`, `max_age_hours`, `max_roundtrip_loss_pct`, `min_safety_score`,
`max_vol_liq_ratio`, `max_tx_per_wallet`, `strategies` {momentum, breakout, pullback, graduation}, `exits`
{stop_pct, take_profit_pct, take_profit_part, trail_pct, time_stop_hours, liquidity_drop_pct, recheck_min},
`x_mentions`, `candidates_per_cycle`, `interval_sec`, `live_confirmation` (`"I ACCEPT MEME COIN RISK"`).

Files under `trader/sniper/`: `book.json` (positions, days, recently traded), `candidates.jsonl` (every judged
candidate with its checks and decision), `outcomes.json` (each candidate's change 15 min / 1 h / 4 h / 24 h later;
gone = −100 %), `trades.jsonl` (closed positions), `season.json`, `safety.json` (15-minute cache).

The one exception to "nothing touches wallets or keys": the sniper's own bot wallet, created by
`sniper.py wallet new` (`SNIPER_SOL_SECRET` in `trader/secrets.env`, 0600, never printed). Live trading needs
`mode: "live"`, the exact confirmation phrase and that wallet; every buy first checks the wallet holds no more
than `wallet_cap_usd`. Signing (ed25519) and the Jupiter swap flow are in `shared/solana.py` (pure Python).

A position in `book.json` may carry `status`: `"sending"` (signed and written down, being sent), `"unconfirmed"`
(sent, outcome not yet seen in the wallet; `buy_tx`, `sent_at`, `pre_raw` = the wallet's balance of the token
before the buy, `note`), `"open"` (settled; absent on paper). `tokens_raw` is what arrived on top of `pre_raw`.
`stop_pct` is measured on the sell value (the strategy's distance plus the round trip's loss). Counters
`no_data` (cycles without market data) and `no_route` (consecutive Jupiter "no route" answers). A live fill has
`sold_raw`. `shared.solana.swap(..., before_send=fn)` calls `fn(signature, quote)` after signing, before sending;
`Rpc.signature_status(sig)` is one look through the ledger history. `jupiter.quote` raises `jupiter.NoRoute` for
an answer without a route and plain `SourceError` for no answer; neither the quotes nor the sniper's safety
reports (`rugcheck.check(..., fresh=True)`) are ever served from an older cached copy.

Live also needs a paper record that pays: `live_needs_paper_proof` (default true), `paper_proof_min_trades`
(30), `paper_proof_days` (30) — that many closed paper trades in `trades.jsonl` within that many days, with a
positive total `pnl_usd`. `sniper.py report --json` carries it as `paper_proof` {ok, trades, pnl_usd, need, text}.
The study that motivated it lives in `trader-sniper/research/` (stdlib; `reproduce.sh history|backtest|collect`,
downloads in `research/data/`, not in git).
