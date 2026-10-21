#!/usr/bin/env python3
"""SAMPLE data for developing and testing the dashboard — every record is marked "sample": true.

Writes autopilot/state.json, autopilot/control.json, autopilot/decisions.jsonl, broker/equity.jsonl,
broker/positions.json, broker/orders.json, news_feed.json and x_usage.json into a trader/ folder
(and a few journal trades if there is no journal yet). Nothing here is real market data.

    python3 app/devdata.py --home /tmp/trader-sample
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

UTC = timezone.utc


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _write(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(str(tmp), str(path))


def _write_jsonl(path: Path, rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


def _gate(name, ok, detail):
    return {"name": name, "ok": ok, "detail": detail}


def generate(home, now_iso: str = "2026-10-20T19:30:00Z", seed: int = 3) -> Path:
    home = Path(home)
    home.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    now = datetime.strptime(now_iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    today = now.date()
    open_utc = datetime(today.year, today.month, today.day, 13, 30, tzinfo=UTC)

    _write(home / "autopilot" / "state.json", {
        "sample": True, "status": "running", "mode": "simulator", "broker": "simulator",
        "started_at": _iso(open_utc - timedelta(minutes=5)), "last_cycle": _iso(now),
        "next_cycle": _iso(now + timedelta(seconds=60)), "cycles": 72, "interval_sec": 60,
        "today": {"date": today.isoformat(), "trades_opened": 2, "realized_pnl": 128.4, "skipped": 9,
                  "kill_reason": None},
        "last_errors": [{"at": _iso(now - timedelta(hours=3, minutes=12)),
                         "error": "Yahoo Finance request failed: HTTP 429 — retried on the next cycle"}],
        "message": "watching 8 symbols · 2 open positions"})
    _write(home / "autopilot" / "control.json", {"paused": False, "kill": False, "run_once": False,
                                                  "updated_at": _iso(open_utc), "by": "cli"})

    def at(h, m):
        return _iso(datetime(today.year, today.month, today.day, h, m, tzinfo=UTC))
    gates_ok = [_gate("fresh trigger", True, "triggered on the last closed bar"),
                _gate("backtest edge", True, "+0.31R over 41 triggers (min +0.05R, ≥ 10)"),
                _gate("Time Machine EV", True, "+0.08R (min +0.00R)"),
                _gate("risk check", True, "PASS — 12 checks")]
    decisions = [
        {"at": at(13, 50), "id": "NVDA-%s-orb15" % today.strftime("%Y%m%d"), "symbol": "NVDA", "asset": "stock",
         "setup": "orb15", "action": "taken", "reasons": ["all gates passed"], "desk": {"status": "GO", "objections": 1},
         "gates": gates_ok, "order_id": "ord-NVDA-sample-1", "broker_order_id": "sim-0001", "entry": 194.49,
         "stop": 192.10, "target": 199.27, "qty": 32},
        {"at": at(14, 15), "id": "TSLA-%s-orb15" % today.strftime("%Y%m%d"), "symbol": "TSLA", "asset": "stock",
         "setup": "orb15", "action": "skipped",
         "reasons": ["backtest expectancy -0.12R over 33 triggers (min +0.05R)"], "desk": {"status": "NO-GO", "objections": 3},
         "gates": [_gate("fresh trigger", True, "triggered on the last closed bar"),
                   _gate("backtest edge", False, "-0.12R over 33 triggers (min +0.05R)"),
                   _gate("Time Machine EV", True, "+0.02R (min +0.00R)")],
         "order_id": None, "broker_order_id": None, "entry": 364.18, "stop": 358.32, "target": 375.90, "qty": None},
        {"at": at(14, 20), "id": "AMD-%s-vwap_reclaim" % today.strftime("%Y%m%d"), "symbol": "AMD", "asset": "stock",
         "setup": "vwap_reclaim", "action": "skipped", "reasons": ["backtest sample too thin: 6 triggers (need 10)"],
         "desk": {"status": "NO-GO", "objections": 2},
         "gates": [_gate("backtest edge", False, "6 triggers (need ≥ 10)")], "order_id": None},
        {"at": at(14, 40), "id": "BTCUSD-%s-asia_range" % today.strftime("%Y%m%d"), "symbol": "BTC/USD",
         "asset": "crypto", "setup": "asia_range", "action": "skipped",
         "reasons": ["backtest expectancy -1.31R over 15 triggers", "Time Machine EV -0.00R (min +0.00R)"],
         "desk": {"status": "NO-GO", "objections": 2},
         "gates": [_gate("backtest edge", False, "-1.31R over 15 triggers"), _gate("Time Machine EV", False, "-0.00R")],
         "order_id": None, "entry": 67448.60, "stop": 67320.53, "target": 67704.74},
        {"at": at(15, 5), "id": "ETHUSD-%s-momentum" % today.strftime("%Y%m%d"), "symbol": "ETH/USD", "asset": "crypto",
         "setup": "momentum", "action": "taken", "reasons": ["all gates passed"], "desk": {"status": "GO", "objections": 1},
         "gates": gates_ok, "order_id": "ord-ETHUSD-sample-2", "broker_order_id": "sim-0003", "entry": 2412.55,
         "stop": 2398.10, "target": 2441.45, "qty": 1.0362},
        {"at": at(15, 30), "id": "PLTR-%s-bull_flag" % today.strftime("%Y%m%d"), "symbol": "PLTR", "asset": "stock",
         "setup": "bull_flag", "action": "error", "reasons": ["no stock data for PLTR (Yahoo Finance: HTTP 429; Stooq: no data)"],
         "gates": [], "order_id": None},
        {"at": at(16, 10), "id": "solana-PUPKIN-%s-momentum" % today.strftime("%Y%m%d"), "symbol": "PUPKIN (solana)",
         "asset": "meme", "setup": "momentum", "action": "skipped",
         "reasons": ["meme coins are never auto-traded — manual checklist only"], "gates": [], "order_id": None},
        {"at": at(17, 45), "id": "NVDA-%s-orb15" % today.strftime("%Y%m%d"), "symbol": "NVDA", "asset": "stock",
         "setup": "orb15", "action": "skipped", "reasons": ["already in a position from this setup today"],
         "gates": [], "order_id": None},
    ]
    for d in decisions:
        d["sample"] = True
    _write_jsonl(home / "autopilot" / "decisions.jsonl", decisions)

    rows = []
    eq = 25000.0
    for k in range(9, 0, -1):
        day = now - timedelta(days=k)
        if day.weekday() >= 5:
            continue
        eq += rng.gauss(25, 140)
        rows.append({"at": _iso(day.replace(hour=20, minute=0, second=0)), "equity": round(eq, 2),
                     "cash": round(eq, 2), "unrealized": 0.0, "realized_today": 0.0, "mode": "simulator",
                     "sample": True})
    start_today = eq
    t = open_utc
    realized = 0.0
    while t <= now:
        drift = 0.9 if t < open_utc + timedelta(hours=3) else 0.2
        eq += rng.gauss(drift, 9.0)
        if t == open_utc + timedelta(hours=2, minutes=30):
            realized = 128.4
        rows.append({"at": _iso(t), "equity": round(eq, 2), "cash": round(start_today - 6200 + realized, 2),
                     "unrealized": round(eq - start_today - realized, 2), "realized_today": realized,
                     "mode": "simulator", "sample": True})
        t += timedelta(minutes=5)
    _write_jsonl(home / "broker" / "equity.jsonl", rows)

    _write(home / "broker" / "positions.json", [
        {"symbol": "NVDA", "asset": "stock", "qty": 32, "avg_entry": 194.49, "last": 196.84,
         "market_value": 6298.88, "unrealized_pl": 75.2, "opened_at": at(13, 55), "plan_id": decisions[0]["id"],
         "stop": 192.10, "target": 199.27, "sample": True},
        {"symbol": "ETH/USD", "asset": "crypto", "qty": 1.0362, "avg_entry": 2412.55, "last": 2405.10,
         "market_value": 2492.17, "unrealized_pl": -7.72, "opened_at": at(15, 10), "plan_id": decisions[4]["id"],
         "stop": 2398.10, "target": 2441.45, "sample": True}])
    _write(home / "broker" / "orders.json", [
        {"id": "sim-0001", "client_order_id": "ord-NVDA-sample-1", "symbol": "NVDA", "side": "buy", "type": "limit",
         "qty": 32, "limit_price": 194.51, "stop_price": None, "status": "filled", "filled_avg_price": 194.49,
         "submitted_at": at(13, 50), "filled_at": at(13, 55), "leg": "entry", "sample": True},
        {"id": "sim-0002", "client_order_id": "ord-NVDA-sample-1-sl", "symbol": "NVDA", "side": "sell", "type": "stop",
         "qty": 32, "limit_price": None, "stop_price": 192.10, "status": "new", "filled_avg_price": None,
         "submitted_at": at(13, 55), "filled_at": None, "leg": "stop", "sample": True},
        {"id": "sim-0002b", "client_order_id": "ord-NVDA-sample-1-tp", "symbol": "NVDA", "side": "sell",
         "type": "limit", "qty": 32, "limit_price": 199.27, "stop_price": None, "status": "new",
         "filled_avg_price": None, "submitted_at": at(13, 55), "filled_at": None, "leg": "target", "sample": True},
        {"id": "sim-0003", "client_order_id": "ord-ETHUSD-sample-2", "symbol": "ETH/USD", "side": "buy",
         "type": "limit", "qty": 1.0362, "limit_price": 2413.03, "stop_price": None, "status": "filled",
         "filled_avg_price": 2412.55, "submitted_at": at(15, 5), "filled_at": at(15, 10), "leg": "entry",
         "sample": True}])

    def item(i, minutes_ago, source, kind, symbol, asset, title, url, why="", tags=(), importance=1, author=None,
             sentiment=None, metrics=None):
        return {"id": "sample-%02d" % i, "symbol": symbol, "asset": asset, "source": source, "kind": kind,
                "author": author, "title": title, "url": url, "published": _iso(now - timedelta(minutes=minutes_ago)),
                "tags": list(tags), "why": why, "importance": importance, "sentiment": sentiment,
                "metrics": metrics or {}, "sample": True}
    feed = [
        item(1, 4, "X", "social", "TSLA", "stock", "SAMPLE: Tesla holds the morning breakout into the afternoon; "
             "options volume running 2x normal", "https://x.com/DeItaone", "options flow chatter", ["options"], 2,
             "@DeItaone", None, {"likes": 412, "reposts": 96}),
        item(2, 9, "StockTwits", "social", "TSLA", "stock", "SAMPLE: $TSLA reclaiming the range high, looks strong",
             "https://stocktwits.com/symbol/TSLA", "retail sentiment", [], 1, "@sample_trader", "bullish",
             {"likes": 12}),
        item(3, 11, "StockTwits", "social", "TSLA", "stock", "SAMPLE: $TSLA earnings tomorrow — not holding overnight",
             "https://stocktwits.com/symbol/TSLA", "retail sentiment", ["earnings"], 1, "@sample_bear", "bearish"),
        item(4, 26, "Yahoo Finance", "news", "TSLA", "stock", "SAMPLE: Tesla–SpaceX merger mania strikes Wall Street "
             "ahead of earnings", "https://finance.yahoo.com/", "merger + earnings: expect a volatile open",
             ["merger", "earnings"], 3),
        item(5, 40, "SEC EDGAR", "filing", "TSLA", "stock", "SAMPLE: 8-K filed: Regulation FD disclosure",
             "https://www.sec.gov/", "guidance: official filing — read it before trading", ["guidance"], 2),
        item(6, 18, "X", "social", "BTC", "crypto", "SAMPLE: Spot bitcoin ETFs on track for the biggest inflow day "
             "this month", "https://x.com/tier10k", "ETF flows drive spot demand", ["etf_flows"], 2, "@tier10k",
             None, {"likes": 230, "reposts": 41}),
        item(7, 21, "StockTwits", "social", "BTC", "crypto", "SAMPLE: $BTC.X Asia high finally broken",
             "https://stocktwits.com/symbol/BTC.X", "retail sentiment", [], 1, "@sample_crypto", "bullish"),
        item(8, 52, "CoinDesk", "news", "BTC", "crypto", "SAMPLE: Bitcoin ETFs pull in $1.2B as BTC presses "
             "against $67K", "https://www.coindesk.com/", "etf_flows: ETF flows drive spot demand", ["etf_flows"], 2),
        item(9, 75, "The Block", "news", "market", "crypto", "SAMPLE: Fed minutes show officials split on a December "
             "cut", "https://www.theblock.co/", "macro headlines move all risk assets", ["macro"], 1),
        item(10, 33, "DexScreener", "news", "PUPKIN", "meme", "SAMPLE: PUPKIN is boosted on DexScreener (500 active "
             "boosts)", "https://dexscreener.com/", "paid promotion — expect hype-driven volume, not a quality signal",
             ["boost"], 1),
        item(11, 3, "X", "social", "NVDA", "stock", "SAMPLE: NVDA extends gap-and-go, new session high",
             "https://x.com/FirstSquawk", "price action", [], 1, "@FirstSquawk", None, {"likes": 88, "reposts": 12}),
        item(12, 15, "StockTwits", "social", "NVDA", "stock", "SAMPLE: $NVDA trailing my stop to breakeven",
             "https://stocktwits.com/symbol/NVDA", "retail sentiment", [], 1, "@sample_trader2", "bullish"),
    ]
    _write(home / "news_feed.json", {"updated_at": _iso(now), "sample": True, "items": feed,
                                     "sources": {"X": "ok", "StockTwits": "ok", "Yahoo Finance": "ok",
                                                 "SEC EDGAR": "ok", "CoinDesk": "ok", "DexScreener": "ok"}})
    _write(home / "x_usage.json", {"date": today.isoformat(), "reads": 124, "requests": 13, "max_reads_per_day": 300,
                                   "sample": True})

    journal = home / "journal.json"
    if not journal.exists():
        def tr(i, sym, asset, setup, e_t, e_p, x_t, x_p, reason, qty, stop, target, unit="shares"):
            risk = abs(e_p - stop)
            pnl = qty * (x_p - e_p) if unit != "usd" else qty * (x_p / e_p - 1)
            return {"id": "trd-sample-%d" % i, "plan_id": "sample-%d" % i, "symbol": sym, "display": sym,
                    "asset": asset, "setup": setup, "direction": "long", "status": "closed" if x_t else "open",
                    "qty": qty, "qty_unit": unit, "entry": {"time": e_t, "price": e_p},
                    "exit": {"time": x_t, "price": x_p, "reason": reason} if x_t else None,
                    "stop": stop, "target": target, "risk_per_unit": risk, "fees_usd": 0.0, "slippage_usd": 0.0,
                    "pnl_usd": round(pnl, 2) if x_t else None, "r_multiple": round((x_p - e_p) / risk, 2) if x_t else None,
                    "paper": True, "source": "autopilot", "broker": "simulator", "sample": True}
        d1 = now - timedelta(days=1)
        _write(journal, {"trades": [
            tr(1, "AAPL", "stock", "orb15", _iso(d1.replace(hour=14, minute=5)), 249.10,
               _iso(d1.replace(hour=15, minute=20)), 247.30, "stop", 40, 247.30, 252.70),
            tr(2, "TSLA", "stock", "vwap_reclaim", _iso(d1.replace(hour=15, minute=0)), 352.40,
               _iso(d1.replace(hour=18, minute=40)), 361.20, "target", 18, 348.00, 361.20),
            tr(3, "BTC/USD", "crypto", "asia_range", _iso((now - timedelta(days=2)).replace(hour=14, minute=40)), 66810.0,
               _iso((now - timedelta(days=2)).replace(hour=18, minute=40)), 66905.0, "time", 0.05, 66650.0, 67130.0,
               "coins"),
            tr(4, "NVDA", "stock", "orb15", at(13, 55), 194.49, at(17, 0), 196.80, "target", 32, 192.10, 196.80),
        ]})
    return home


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--home", required=True, help="trader/ folder to write the SAMPLE files into")
    p.add_argument("--now", default="2026-10-20T19:30:00Z", help="sample 'now' (ISO, Z)")
    args = p.parse_args(argv)
    out = generate(args.home, args.now)
    print("SAMPLE dashboard data written to %s" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
