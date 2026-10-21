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
  "global": {"max_daily_loss_usd": 750, "max_daily_trades": 8, "max_open_positions": 4},
  "stock":  {"max_risk_per_trade_usd": 250, "max_daily_loss_usd": 500, "max_open_positions": 3,
             "max_position_pct": 25, "max_daily_trades": 6,
             "allow_shorts": false, "allow_margin": false, "allow_options": false},
  "crypto": {"max_risk_per_trade_usd": 200, "max_daily_loss_usd": 400, "max_open_positions": 2,
             "max_position_pct": 15, "max_total_exposure_pct": 30, "max_daily_trades": 6,
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
  "gates": {"min_backtest_triggers": 10, "min_backtest_expectancy_r": 0.05, "min_tm_ev_r": 0.0,
            "tm_paths": 2000, "max_trigger_age_bars": 1},
  "max_new_trades_per_day": 3,
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
