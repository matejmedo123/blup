#!/usr/bin/env python3
"""Trader dashboard — a local web app over the trader/ state folder.

Shows equity and P&L, positions and orders, every journal trade with a chart, what the
autopilot did and why, whether the bot is alive, trading hours, the symbols it picked, what it
learned from its own record, notifications, the optional AI desk, the aggregated news & social
feed, scanner setups and every HTML report — plus bot controls (pause / resume / run once / KILL).
Stdlib only.

    python3 app/server.py                          # http://127.0.0.1:8765
    python3 app/server.py --autopilot              # … and run the autopilot loop in the background
    python3 app/server.py --no-autopilot           # never run a loop here (a separate daemon trades)
    python3 app/server.py --home demo/trader --offline   # browse the offline demo
    python3 app/server.py --host 0.0.0.0           # reachable from your phone — needs a password

Binds to 127.0.0.1 by default. Any other host requires a password (TRADER_DASHBOARD_PASSWORD in the
environment or trader/secrets.env, or --password), and so does any request that arrives through a
reverse proxy. No API response ever contains a secret.
"""
from __future__ import annotations

import argparse
import hmac
import importlib.util
import inspect
import ipaddress
import json
import os
import re
import secrets as _pysecrets
import socket
import sys
import threading
import time
import traceback
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

_HERE = Path(__file__).resolve().parent
_ROOT = os.environ.get("TRADER_PACK_ROOT") or str(_HERE.parent)
if not os.path.isdir(os.path.join(_ROOT, "shared")):
    sys.exit("trader: shared/ not found next to app/ — run the dashboard from the trader-skill folder")
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from shared import config, disclaimer, market_clock, secrets, skills, state  # noqa: E402

STATIC = _HERE / "static"
MAX_BODY = 16 * 1024
SESSION_COOKIE = "trader_session"
REPORT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,200}\.html$")
STATIC_TYPES = {".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon"}
APP_CSP = ("default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; "
           "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
# generated reports carry inline SVG/CSS and a tiny inline script — sandbox them into an opaque origin
REPORT_CSP = ("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; "
              "frame-ancestors 'none'; base-uri 'none'; form-action 'none'; "
              "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox")
LIVE_PHRASE = "I ACCEPT REAL MONEY RISK"
HEARTBEAT_MIN_STALE_SEC = 180  # alive = a heartbeat younger than 3 × interval, never less than this
NO_NEW_STOCK_ENTRIES_ET = (15, 30)  # mirrors the autopilot: too little session left after 3:30 p.m. ET
PROXY_HEADERS = ("X-Forwarded-For", "Forwarded", "X-Real-IP")
REDACTED = "[redacted]"


# --- defensive readers ------------------------------------------------------------------------

def home() -> Path:
    return config.trader_home()


def read_json(rel: str, default=None):
    try:
        return json.loads((home() / rel).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def read_jsonl(rel: str, tail: int = None) -> list:
    try:
        lines = (home() / rel).read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    if tail:
        lines = lines[-tail:]
    out = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            out.append(row)
    return out


def _list(obj, key: str) -> list:
    if isinstance(obj, dict):
        v = obj.get(key)
        return v if isinstance(v, list) else []
    return obj if isinstance(obj, list) else []


def _num(x, default=None):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return v if v == v else default  # NaN guard


def _now_iso() -> str:
    return market_clock.iso(market_clock.now_utc())


def _today() -> str:
    return market_clock.now_utc().strftime("%Y-%m-%d")


def _log_error(where: str, exc: Exception) -> None:
    """One line on stderr; the full traceback only with TRADER_DEBUG=1."""
    if os.environ.get("TRADER_DEBUG"):
        traceback.print_exc()
    else:
        sys.stderr.write("dashboard: %s failed: %s: %s\n" % (where, type(exc).__name__, exc))


def safe_url(u) -> str:
    u = str(u or "").strip()
    return u if u.lower().startswith(("http://", "https://")) else ""


# --- data views -------------------------------------------------------------------------------

def journal_trades() -> list:
    trades = [t for t in _list(read_json("journal.json", {}), "trades") if isinstance(t, dict)]
    return trades


def _r_of(t):
    v = _num(t.get("r_net"))
    return v if v is not None else _num(t.get("r_multiple"))


def trade_stats(trades: list) -> dict:
    closed = [t for t in trades if t.get("status") == "closed" and _num(t.get("pnl_usd")) is not None]
    pnls = [_num(t.get("pnl_usd"), 0.0) for t in closed]
    rs = [r for r in (_r_of(t) for t in closed) if r is not None]
    today = _today()
    today_pnl = sum(_num(t.get("pnl_usd"), 0.0) for t in closed
                    if str(((t.get("exit") or {}).get("time") or ""))[:10] == today)
    wins = sum(1 for p in pnls if p > 0)
    gp = sum(p for p in pnls if p > 0)
    gl = -sum(p for p in pnls if p < 0)
    return {"closed": len(closed), "open": sum(1 for t in trades if t.get("status") == "open"),
            "wins": wins, "losses": sum(1 for p in pnls if p < 0),
            "win_rate": (wins / float(len(closed))) if closed else None,
            "expectancy_r": (sum(rs) / len(rs)) if rs else None,
            "avg_pnl": (sum(pnls) / len(pnls)) if pnls else None,
            "profit_factor": (gp / gl) if gl > 0 else None,
            "pnl_total": round(sum(pnls), 2), "pnl_today_realized": round(today_pnl, 2)}


def _starting_cash(cfg: dict) -> float:
    ap = cfg.get("autopilot") or {}
    return _num(ap.get("sim_starting_cash"), None) or _num(cfg.get("account_size"), 25000.0) or 25000.0


def live_requirements(cfg: dict) -> list:
    ap = cfg.get("autopilot") or {}
    return [
        {"name": "autopilot.broker is \"alpaca\"", "ok": ap.get("broker") == "alpaca"},
        {"name": "autopilot.mode is \"live\"", "ok": ap.get("mode") == "live"},
        {"name": "top-level \"paper\": false", "ok": cfg.get("paper") is False},
        {"name": "ALPACA_LIVE_KEY_ID and ALPACA_LIVE_SECRET_KEY set",
         "ok": secrets.has("ALPACA_LIVE_KEY_ID") and secrets.has("ALPACA_LIVE_SECRET_KEY")},
        {"name": "autopilot.live_confirmation is \"%s\"" % LIVE_PHRASE, "ok": ap.get("live_confirmation") == LIVE_PHRASE},
    ]


def mode_info(cfg: dict, bot: dict) -> dict:
    ap = cfg.get("autopilot") or {}
    broker = bot.get("broker") or ap.get("broker") or "simulator"
    mode = bot.get("mode")
    if mode not in ("simulator", "paper", "live"):
        mode = "simulator" if broker == "simulator" else ("live" if ap.get("mode") == "live" else "paper")
    reqs = live_requirements(cfg)
    return {"mode": mode, "broker": broker, "live": mode == "live",
            "live_ready": all(r["ok"] for r in reqs), "live_requirements": reqs}


def autopilot_installed() -> bool:
    return (Path(_ROOT) / "trader-autopilot" / "autopilot.py").exists()


def equity_rows() -> list:
    return [r for r in read_jsonl("broker/equity.jsonl") if _num(r.get("equity")) is not None and r.get("at")]


def account_view(cfg: dict, stats: dict, positions: list) -> dict:
    rows = equity_rows()
    unreal = sum(_num(p.get("unrealized_pl"), 0.0) for p in positions)
    if rows:
        last = rows[-1]
        today = _today()
        today_rows = [r for r in rows if str(r["at"])[:10] == today]
        before = [r for r in rows if str(r["at"])[:10] < today]
        base = _num(before[-1]["equity"]) if before else (_num(today_rows[0]["equity"]) if today_rows else None)
        eq = _num(last.get("equity"))
        return {"source": "broker", "equity": eq, "cash": _num(last.get("cash")),
                "unrealized": _num(last.get("unrealized"), unreal), "realized_today": _num(last.get("realized_today")),
                "pnl_today": (eq - base) if (eq is not None and base is not None) else None,
                "pnl_total": eq - _starting_cash(cfg) if eq is not None else None,
                "as_of": last.get("at"), "starting_cash": _starting_cash(cfg)}
    start = _starting_cash(cfg)
    eq = start + stats["pnl_total"] + unreal
    return {"source": "journal", "equity": eq, "cash": None, "unrealized": unreal,
            "realized_today": stats["pnl_today_realized"], "pnl_today": stats["pnl_today_realized"] + unreal,
            "pnl_total": stats["pnl_total"] + unreal, "as_of": None, "starting_cash": start}


def positions_view() -> list:
    rows = [p for p in _list(read_json("broker/positions.json", []), "positions") if isinstance(p, dict)]
    if rows:
        return rows
    out = []
    for t in journal_trades():
        if t.get("status") != "open":
            continue
        entry = t.get("entry") or {}
        mark = t.get("mark") or {}
        last = _num(mark.get("price")) if isinstance(mark, dict) else _num(mark)
        qty = _num(t.get("qty"), 0.0)
        ep = _num(entry.get("price"))
        unreal = None
        if last is not None and ep:
            unreal = qty * (last / ep - 1) if t.get("qty_unit") == "usd" else qty * (last - ep)
        out.append({"symbol": t.get("display") or t.get("symbol"), "asset": t.get("asset"), "qty": qty,
                    "qty_unit": t.get("qty_unit"), "avg_entry": ep, "last": last, "unrealized_pl": unreal,
                    "opened_at": entry.get("time"), "plan_id": t.get("plan_id"), "source": "journal",
                    "stop": t.get("stop"), "target": t.get("target")})
    return out


def orders_view() -> dict:
    broker_rows = [o for o in _list(read_json("broker/orders.json", []), "orders") if isinstance(o, dict)]
    local = []
    for o in _list(read_json("orders.json", {}), "orders"):
        if not isinstance(o, dict):
            continue
        local.append({k: o.get(k) for k in ("id", "plan_id", "symbol", "display", "asset", "side", "qty", "qty_unit",
                                             "limit_price", "stop_price", "target_price", "status", "created_at",
                                             "risk_usd", "notional_usd")})
        local[-1]["risk_result"] = (o.get("risk") or {}).get("result") if isinstance(o.get("risk"), dict) else None
    local.sort(key=lambda o: str(o.get("created_at") or ""), reverse=True)
    return {"broker": broker_rows, "local": local[:100]}


def control_view() -> dict:
    c = read_json("autopilot/control.json", {}) or {}
    return {"paused": bool(c.get("paused")), "kill": bool(c.get("kill")), "run_once": bool(c.get("run_once")),
            "updated_at": c.get("updated_at"), "by": c.get("by"), "dd_reset_at": c.get("dd_reset_at")}


def summary_view(app) -> dict:
    cfg = config.load_config()
    bot = read_json("autopilot/state.json", {}) or {}
    trades = journal_trades()
    stats = trade_stats(trades)
    positions = positions_view()
    acct = account_view(cfg, stats, positions)
    feed = read_json("news_feed.json", {}) or {}
    orders = orders_view()
    ap = dict(cfg.get("autopilot") or {})
    ap.pop("live_confirmation", None)  # not a secret, but nothing to show either
    assets_seen = {t.get("asset") for t in trades} | {p.get("asset") for p in positions}
    assets_seen |= {i.get("asset") for i in _list(feed, "items") if isinstance(i, dict)}
    learned = adapt_view(cfg)
    uni = universe_view(cfg)
    return {
        "now": _now_iso(),
        "home": str(home()),
        "offline": config.is_offline(),
        "mode": mode_info(cfg, bot),
        "bot": {"installed": autopilot_installed(), "status": bot.get("status") or ("not started" if autopilot_installed()
                                                                                     else "not installed"),
                "last_cycle": bot.get("last_cycle"), "next_cycle": bot.get("next_cycle"), "cycles": bot.get("cycles"),
                "message": bot.get("message"), "today": bot.get("today") or {},
                "last_errors": (bot.get("last_errors") or [])[-5:], "interval_sec": bot.get("interval_sec")
                or ap.get("interval_sec"), "started_at": bot.get("started_at")},
        "control": control_view(),
        "health": health_view(),
        "sessions": sessions_view(cfg),
        "learned": {k: learned.get(k) for k in ("available", "risk_mult", "risk_reason", "drawdown_pct", "drawdown_pause",
                                                "max_drawdown_pct", "paused_setups", "cooling")},
        "universe_counts": {a: v["count"] for a, v in uni["assets"].items()},
        "server": app.status() if app else {},
        "autopilot_config": {k: ap.get(k) for k in ("enabled", "broker", "mode", "interval_sec", "assets", "setups",
                                                   "gates", "max_new_trades_per_day", "flatten_on_kill", "news_gate",
                                                   "adapt")},
        "ai_desk": {"enabled": bool((cfg.get("ai_desk") or {}).get("enabled")),
                    "model": (cfg.get("ai_desk") or {}).get("model")},
        "account": acct,
        "stats": stats,
        "positions": len(positions),
        "open_orders": sum(1 for o in orders["broker"] if str(o.get("status")) in
                           ("new", "accepted", "pending_new", "partially_filled", "held", "open")),
        "x_usage": read_json("x_usage.json", None),
        "sources": feed.get("sources") if isinstance(feed, dict) else None,
        "news_updated_at": feed.get("updated_at") if isinstance(feed, dict) else None,
        "secrets": {"alpaca_paper": secrets.has("ALPACA_PAPER_KEY_ID") and secrets.has("ALPACA_PAPER_SECRET_KEY"),
                    "alpaca_live": secrets.has("ALPACA_LIVE_KEY_ID") and secrets.has("ALPACA_LIVE_SECRET_KEY"),
                    "x_token": secrets.has("X_BEARER_TOKEN"),
                    "telegram": secrets.has("TELEGRAM_BOT_TOKEN") and secrets.has("TELEGRAM_CHAT_ID"),
                    "ntfy_token": secrets.has("NTFY_TOKEN"), "anthropic": secrets.has("ANTHROPIC_API_KEY")},
        "has_meme": "meme" in assets_seen,
        "disclaimer": disclaimer.text("meme" if "meme" in assets_seen else None),
    }


def _downsample(rows: list, n: int = 500) -> list:
    if len(rows) <= n:
        return rows
    step = len(rows) / float(n - 1)
    picked = [rows[int(round(i * step))] for i in range(n - 1)]
    return picked + [rows[-1]]


RANGES = {"1d": 1, "1w": 7, "1m": 31, "3m": 92}


def _daily_from_equity(rows: list, start: float) -> list:
    last_by_day = {}
    for r in rows:
        last_by_day[str(r["at"])[:10]] = _num(r["equity"])
    out, prev = [], None
    for d in sorted(last_by_day):
        eq = last_by_day[d]
        base = prev if prev is not None else start
        if eq is not None and base is not None:
            out.append({"date": d, "pnl": round(eq - base, 2)})
        prev = eq
    return out


def equity_view(rng: str = "all") -> dict:
    cfg = config.load_config()
    start = _starting_cash(cfg)
    rows = equity_rows()
    trades = journal_trades()
    days = RANGES.get(str(rng or "all").lower())
    cutoff = None
    if days:
        cutoff = market_clock.iso(market_clock.now_utc() - timedelta(days=days))
    if rows:
        daily_rows = _daily_from_equity(rows, start)[-60:]
        shown = [r for r in rows if cutoff is None or str(r["at"]) >= cutoff]
        pts = [{"t": r["at"], "v": _num(r["equity"])} for r in _downsample(shown)]
        return {"source": "broker", "points": pts, "daily": daily_rows, "start": start, "range": rng or "all"}
    daily = {}
    for t in trades:
        if t.get("status") != "closed":
            continue
        d = str(((t.get("exit") or {}).get("time") or ""))[:10]
        if d:
            daily[d] = daily.get(d, 0.0) + _num(t.get("pnl_usd"), 0.0)
    daily_rows = [{"date": d, "pnl": round(v, 2)} for d, v in sorted(daily.items())][-60:]
    closed = sorted([t for t in trades if t.get("status") == "closed" and (t.get("exit") or {}).get("time")],
                    key=lambda t: t["exit"]["time"])
    pts = []
    if closed:
        first = (closed[0].get("entry") or {}).get("time") or closed[0]["exit"]["time"]
        pts.append({"t": first, "v": start})
        run = start
        for t in closed:
            run += _num(t.get("pnl_usd"), 0.0)
            pts.append({"t": t["exit"]["time"], "v": round(run, 2)})
    if cutoff:
        pts = [p for p in pts if p["t"] >= cutoff]
    return {"source": "journal", "points": pts, "daily": daily_rows, "start": start, "range": rng or "all"}


def trades_view(asset: str = "", status: str = "", setup: str = "") -> dict:
    trades = journal_trades()
    out = []
    for t in trades:
        if asset and t.get("asset") != asset:
            continue
        if status and t.get("status") != status:
            continue
        if setup and t.get("setup") != setup:
            continue
        out.append(t)
    out.sort(key=lambda t: str((t.get("entry") or {}).get("time") or t.get("logged_at") or ""), reverse=True)
    return {"trades": out[:500], "stats": trade_stats(trades),
            "setups": sorted({t.get("setup") for t in trades if t.get("setup")})}


_CANDLE_CACHE = {}
_CANDLE_LOCK = threading.Lock()


def trade_view(trade_id: str) -> dict:
    trade = next((t for t in journal_trades() if t.get("id") == trade_id), None)
    if trade is None:
        return None
    out = {"trade": trade, "candles": [], "candles_error": None, "interval": "5m"}
    key = (trade_id, str(home()), os.environ.get("TRADER_NOW"))
    with _CANDLE_LOCK:
        hit = _CANDLE_CACHE.get(key)
    if hit and time.time() - hit[0] < 120:
        out.update(hit[1])
        return out
    try:
        from shared import data
        entry_t = market_clock.parse_iso((trade.get("entry") or {}).get("time"))
        exit_s = (trade.get("exit") or {}).get("time")
        now = market_clock.now_utc()
        end = market_clock.parse_iso(exit_s) if exit_s else now
        end = min(now, end + timedelta(hours=1))
        asset = trade.get("asset")
        days = 2 if asset == "stock" else 1.5
        sym = trade.get("symbol") or trade.get("display")
        series = data.get_candles(sym, "5m", days=days, asset=asset, end=end)
        start_ts = int((entry_t - timedelta(hours=2 if asset == "stock" else 3)).timestamp())
        candles = [[c.t, c.o, c.h, c.l, c.c, c.v] for c in series.candles if c.t >= start_ts]
        res = {"candles": candles[-240:], "candles_source": series.source}
    except Exception as exc:  # the chart is a bonus — never fail the request over it
        res = {"candles": [], "candles_error": "%s: %s" % (type(exc).__name__, exc)}
    with _CANDLE_LOCK:
        _CANDLE_CACHE[key] = (time.time(), res)
    out.update(res)
    return out


def decisions_view(limit: int = 200) -> dict:
    rows = read_jsonl("autopilot/decisions.jsonl", tail=max(1, min(limit, 2000)))
    rows.reverse()
    counts = {"taken": 0, "skipped": 0, "error": 0}
    for r in rows:
        if r.get("action") in counts:
            counts[r["action"]] += 1
    return {"decisions": rows, "counts": counts}


def news_view(asset: str = "", symbol: str = "", kind: str = "") -> dict:
    feed = read_json("news_feed.json", None)
    source = "news_feed.json"
    items = _list(feed, "items") if isinstance(feed, dict) else []
    if not items:
        legacy = read_json("news.json", {}) or {}
        source = "news.json"
        items = []
        for i in _list(legacy, "items"):
            if isinstance(i, dict):
                j = dict(i)
                j.setdefault("asset", legacy.get("asset"))
                j.setdefault("kind", "filing" if i.get("source") == "SEC EDGAR" else "news")
                items.append(j)
    items = [i for i in items if isinstance(i, dict)]
    sentiment = {}
    for i in items:
        if i.get("source") == "StockTwits" and i.get("sentiment") in ("bullish", "bearish"):
            s = sentiment.setdefault(str(i.get("symbol") or "?"), {"bullish": 0, "bearish": 0})
            s[i["sentiment"]] += 1
    symbols = {}
    for i in items:
        s = str(i.get("symbol") or "")
        if s:
            symbols[s] = symbols.get(s, 0) + 1
    filtered = [i for i in items if (not asset or i.get("asset") == asset)
                and (not symbol or str(i.get("symbol") or "") == symbol)
                and (not kind or i.get("kind") == kind)]
    filtered.sort(key=lambda i: str(i.get("published") or ""), reverse=True)
    for i in filtered:
        i["url"] = safe_url(i.get("url"))
    return {"items": filtered[:300], "total": len(items), "source": source,
            "sources": feed.get("sources") if isinstance(feed, dict) else None,
            "updated_at": feed.get("updated_at") if isinstance(feed, dict) else None,
            "x_usage": read_json("x_usage.json", None), "sentiment": sentiment,
            "symbols": [s for s, _ in sorted(symbols.items(), key=lambda kv: -kv[1])[:12]]}


def setups_view() -> dict:
    out = {}
    for p in sorted(home().glob("setups-*.json")):
        doc = read_json(p.name, None)
        if isinstance(doc, dict) and doc.get("asset"):
            out[doc["asset"]] = doc
    latest = read_json("setups.json", None)
    if isinstance(latest, dict) and latest.get("asset") and latest["asset"] not in out:
        out[latest["asset"]] = latest
    view = {}
    for asset, doc in out.items():
        view[asset] = {"generated_at": doc.get("generated_at"), "universe": doc.get("universe"),
                       "setups": [s for s in _list(doc, "setups") if isinstance(s, dict)][:60],
                       "hidden": [h for h in _list(doc, "hidden") if isinstance(h, dict)][:30],
                       "warnings": _list(doc, "warnings")[:10]}
    return {"assets": view}


def reports_view() -> dict:
    d = home() / "reports"
    rows = []
    if d.exists():
        for p in d.glob("*.html"):
            if not REPORT_NAME.match(p.name):
                continue
            try:
                st = p.stat()
            except OSError:
                continue
            rows.append({"name": p.name, "kind": p.name.split("-", 1)[0].replace(".html", ""),
                         "size": st.st_size, "modified": market_clock.iso(st.st_mtime)})
    rows.sort(key=lambda r: r["modified"], reverse=True)
    return {"reports": rows}


def desk_view() -> dict:
    rows = []
    d = home() / "desk"
    if d.exists():
        for f in d.glob("*/desk.json"):
            doc = read_json(str(f.relative_to(home())), None)
            if not isinstance(doc, dict):
                continue
            rows.append({"id": doc.get("id") or f.parent.name, "symbol": doc.get("symbol"), "asset": doc.get("asset"),
                         "status": doc.get("status"), "decision": doc.get("decision"),
                         "headline": doc.get("headline"), "verified_at": doc.get("verified_at"),
                         "objections": len(doc.get("objections") or []),
                         "report": "desk-%s.html" % (doc.get("id") or f.parent.name)})
    rows.sort(key=lambda r: str(r.get("verified_at") or ""), reverse=True)
    return {"desk": rows}


# --- v3: health, trading hours, universe, what it learned, notifications, AI desk -----------------

def _age_sec(iso_s):
    try:
        return (market_clock.now_utc() - market_clock.parse_iso(iso_s)).total_seconds()
    except (TypeError, ValueError, AttributeError):
        return None


def health_view() -> dict:
    """alive / stale / stopped / never — from autopilot/heartbeat.json, whoever wrote it."""
    hb = read_json("autopilot/heartbeat.json", None)
    keys = ("at", "pid", "host", "runner", "started_at", "cycle", "status", "interval_sec", "next_cycle",
            "universe", "scan", "sessions")
    if not isinstance(hb, dict) or not hb.get("at"):
        out = {k: None for k in keys}
        out.update(state="never", age_sec=None, stale_after_sec=HEARTBEAT_MIN_STALE_SEC)
        return out
    interval = _num(hb.get("interval_sec"), 60.0) or 60.0
    stale_after = max(float(HEARTBEAT_MIN_STALE_SEC), 3.0 * interval)
    age = _age_sec(hb.get("at"))
    if age is not None:
        age = max(0.0, age)  # a pinned demo clock can sit a little behind the last beat
    if str(hb.get("status") or "") == "stopped":
        st = "stopped"
    elif age is not None and age <= stale_after:
        st = "alive"
    else:
        st = "stale"
    out = {k: hb.get(k) for k in keys}
    out.update(state=st, age_sec=int(round(age)) if age is not None else None, stale_after_sec=int(stale_after))
    return out


def sessions_view(cfg: dict = None) -> dict:
    """Crypto trades 24/7; US stocks only in the regular session (new entries until 3:30 p.m. ET)."""
    cfg = cfg or config.load_config()
    assets = (cfg.get("autopilot") or {}).get("assets") or ["stock", "crypto"]
    now = market_clock.now_utc()
    ms = market_clock.market_status(now)
    d = market_clock.et_date(now)
    weekend = not ms["trading_day"] and d.weekday() >= 5
    holiday = ms.get("holiday") if not ms["trading_day"] else None
    entries_until = None
    bot_trading = False
    if ms["state"] == "open" and ms.get("closes_at"):
        cutoff = market_clock.et_to_utc(d, *NO_NEW_STOCK_ENTRIES_ET)
        close = market_clock.parse_iso(ms["closes_at"])
        entries_until = min(cutoff, close)
        bot_trading = now < entries_until
    if ms["state"] == "open":
        label = "open — new entries until 3:30 p.m. ET" if bot_trading else \
            "open — exits only, no new entries after 3:30 p.m. ET"
    elif ms["state"] == "pre-market":
        label = "pre-market — the bot waits for the 9:30 a.m. ET open"
    elif ms["state"] == "after-hours":
        label = "after-hours — the bot does not trade extended hours"
    elif weekend:
        label = "closed — weekend"
    elif holiday:
        label = "closed — %s" % holiday
    else:
        label = "closed"
    enabled_stock = "stock" in assets
    enabled_crypto = "crypto" in assets
    return {
        "now": market_clock.iso(now),
        "crypto": {"enabled": enabled_crypto, "state": "open", "label": "open 24/7",
                   "bot_trading": enabled_crypto},
        "stock": {"enabled": enabled_stock, "state": ms["state"], "label": label,
                  "bot_trading": bot_trading and enabled_stock, "trading_day": ms["trading_day"],
                  "weekend": weekend, "holiday": holiday, "early_close": ms.get("early_close"),
                  "opens_at": ms.get("opens_at"), "closes_at": ms.get("closes_at"), "next_open": ms.get("next_open"),
                  "entries_until": market_clock.iso(entries_until) if entries_until else None,
                  "minutes_to_close": ms.get("minutes_to_close"),
                  "next_change": ms.get("closes_at") if ms["state"] == "open" else ms.get("next_open")},
    }


def _str_list(v) -> list:
    return [str(x) for x in v if isinstance(x, (str, int, float))] if isinstance(v, list) else []


def universe_view(cfg: dict = None) -> dict:
    cfg = cfg or config.load_config()
    ucfg = ((cfg.get("autopilot") or {}).get("universe") or {})
    doc = read_json("autopilot/universe.json", None)
    doc = doc if isinstance(doc, dict) else None
    scan = read_json("autopilot/scan.json", {})
    scan = scan if isinstance(scan, dict) else {}
    out = {"available": doc is not None, "mode": (doc or {}).get("mode") or ucfg.get("mode") or "watchlist",
           "generated_at": (doc or {}).get("generated_at"), "assets": {}, "excluded": [],
           "warnings": _str_list((doc or {}).get("warnings"))[:20], "scan": {},
           "config": {"stock_top_n": (ucfg.get("stocks") or {}).get("top_n"),
                      "crypto_top_n": (ucfg.get("crypto") or {}).get("top_n"),
                      "stock_refresh_minutes": (ucfg.get("stocks") or {}).get("refresh_minutes"),
                      "crypto_refresh_minutes": (ucfg.get("crypto") or {}).get("refresh_minutes")}}
    for asset in ("stock", "crypto"):
        sec = (doc or {}).get(asset)
        if isinstance(sec, dict):
            syms = _str_list(sec.get("symbols"))
            reasons = sec.get("reasons") if isinstance(sec.get("reasons"), dict) else {}
            out["assets"][asset] = {"count": len(syms), "refreshed_at": sec.get("refreshed_at"),
                                    "source": sec.get("source"), "candidates": sec.get("candidates"),
                                    "symbols": [{"symbol": x, "reason": str(reasons.get(x) or "")} for x in syms[:400]]}
        sc = scan.get(asset)
        if isinstance(sc, dict):
            done = sc.get("done")
            n_done = len(done) if isinstance(done, list) else int(_num(done, 0) or 0)
            total = _num(sc.get("total"))
            bar = sc.get("bar")
            out["scan"][asset] = {"done": n_done, "total": int(total) if total is not None else None,
                                  "pct": round(100.0 * n_done / total, 1) if total else None,
                                  "bar": market_clock.iso(bar) if isinstance(bar, (int, float)) else bar,
                                  "finished_at": sc.get("finished_at")}
    excl = (doc or {}).get("excluded")
    if isinstance(excl, dict):
        out["excluded"] = [{"symbol": str(k), "reason": str(v or "")} for k, v in sorted(excl.items())][:200]
    return out


def adapt_view(cfg: dict = None) -> dict:
    cfg = cfg or config.load_config()
    acfg = ((cfg.get("autopilot") or {}).get("adapt") or {})
    base = {"enabled": bool(acfg.get("enabled", True)), "max_drawdown_pct": _num(acfg.get("max_drawdown_pct")),
            "config": {k: acfg.get(k) for k in ("min_trades", "disable_below_r", "cooldown_days", "symbol_loss_streak",
                                                "symbol_cooldown_days", "loss_streak", "loss_streak_risk_mult")}}
    doc = read_json("autopilot/adapt.json", None)
    if not isinstance(doc, dict):
        base.update(available=False, setups=[], symbols=[], events=[], paused_setups=0, cooling=0, risk_mult=1.0,
                    risk_reason=None, loss_streak=0, equity_peak=None, equity=None, drawdown_pct=None,
                    drawdown_pause=False, updated_at=None)
        return base
    setups = []
    for key, v in (doc.get("setups") or {}).items():
        if not isinstance(v, dict):
            continue
        asset, _, setup = str(key).partition(":")
        setups.append({"key": str(key), "asset": asset if setup else None, "setup": setup or asset,
                       "trades": v.get("trades"), "wins": v.get("wins"), "expectancy_r": _num(v.get("expectancy_r")),
                       "status": v.get("status") or "active", "until": v.get("until"), "since": v.get("since"),
                       "reason": v.get("reason")})
    setups.sort(key=lambda x: (x["status"] == "active", -(_num(x.get("trades"), 0) or 0)))
    symbols = []
    for sym, v in (doc.get("symbols") or {}).items():
        if isinstance(v, dict):
            symbols.append({"symbol": str(sym), "loss_streak": v.get("loss_streak"), "status": v.get("status") or "active",
                            "until": v.get("until"), "reason": v.get("reason")})
    symbols.sort(key=lambda x: (x["status"] == "active", -(_num(x.get("loss_streak"), 0) or 0)))
    events = [e for e in (doc.get("events") or []) if isinstance(e, dict)][-20:]
    events.reverse()
    base.update(available=True, updated_at=doc.get("updated_at"), enabled=bool(doc.get("enabled", base["enabled"])),
                setups=setups, symbols=symbols, events=events,
                paused_setups=sum(1 for x in setups if x["status"] != "active"),
                cooling=sum(1 for x in symbols if x["status"] != "active"),
                risk_mult=_num(doc.get("risk_mult"), 1.0), risk_reason=doc.get("risk_reason"),
                loss_streak=doc.get("loss_streak") or 0, equity_peak=_num(doc.get("equity_peak")),
                equity=_num(doc.get("equity")), drawdown_pct=_num(doc.get("drawdown_pct")),
                drawdown_pause=bool(doc.get("drawdown_pause")))
    return base


def notify_view(cfg: dict = None) -> dict:
    cfg = cfg or config.load_config()
    n = cfg.get("notify") or {}
    topic = str(n.get("ntfy_topic") or "")
    server = urlsplit(safe_url(n.get("ntfy_server") or "https://ntfy.sh")).netloc or "ntfy.sh"
    recent = []
    for r in reversed(read_jsonl("notifications.jsonl", tail=20)):
        ch = r.get("channels") if isinstance(r.get("channels"), dict) else {}
        recent.append({"at": r.get("at"), "event": r.get("event"), "title": r.get("title"), "text": r.get("text"),
                       "priority": r.get("priority"), "suppressed": r.get("suppressed"),
                       "channels": {str(k): str(v) for k, v in ch.items()}})
    return {"enabled": bool(n.get("enabled")),
            # the topic works like a password (anyone who knows it can read the alerts) — never shown
            "ntfy": {"configured": bool(topic), "server": server, "short_topic": 0 < len(topic) < 16,
                     "token": secrets.has("NTFY_TOKEN")},
            "telegram": {"enabled": bool(n.get("telegram")), "bot_token": secrets.has("TELEGRAM_BOT_TOKEN"),
                         "chat_id": secrets.has("TELEGRAM_CHAT_ID")},
            "events": _str_list(n.get("events")), "daily_summary_et": n.get("daily_summary_et"),
            "max_per_hour": n.get("max_per_hour"), "recent": recent}


_SDK = {}


def _anthropic_sdk_installed() -> bool:
    if "ok" not in _SDK:
        try:
            _SDK["ok"] = importlib.util.find_spec("anthropic") is not None
        except (ImportError, ValueError):
            _SDK["ok"] = False
    return _SDK["ok"]


def ai_view(cfg: dict = None) -> dict:
    cfg = cfg or config.load_config()
    a = cfg.get("ai_desk") or {}
    usage = read_json("ai_usage.json", {})
    days = usage.get("days") if isinstance(usage, dict) and isinstance(usage.get("days"), dict) else {}
    today = _today()
    t = days.get(today) if isinstance(days.get(today), dict) else {}
    recent = []
    d = home() / "desk"
    if d.exists():
        for f in d.glob("*/ai.json"):
            doc = read_json(str(f.relative_to(home())), None)
            if not isinstance(doc, dict):
                continue
            objs = [o for o in doc.get("objections") or [] if isinstance(o, dict)]
            recent.append({"id": f.parent.name, "at": doc.get("at"), "model": doc.get("model"),
                           "status": doc.get("status"), "reason": doc.get("reason"), "objections": len(objs),
                           "top": (objs[0].get("text") if objs else None),
                           "usd": _num((doc.get("usage") or {}).get("usd")) if isinstance(doc.get("usage"), dict) else None})
    recent.sort(key=lambda r: str(r.get("at") or ""), reverse=True)
    key, sdk = secrets.has("ANTHROPIC_API_KEY"), _anthropic_sdk_installed()
    enabled = bool(a.get("enabled"))
    return {"enabled": enabled, "model": a.get("model"), "max_calls_per_day": a.get("max_calls_per_day"),
            "max_usd_per_day": _num(a.get("max_usd_per_day")), "on_unavailable": a.get("on_unavailable"),
            "key": key, "sdk": sdk, "ready": enabled and key and sdk,
            "today": {"date": today, "calls": int(_num(t.get("calls"), 0) or 0), "usd": _num(t.get("usd"), 0.0),
                      "input_tokens": int(_num(t.get("input_tokens"), 0) or 0),
                      "output_tokens": int(_num(t.get("output_tokens"), 0) or 0)},
            "recent": recent[:10]}


def _tier_mult(pc, n, pcfg: dict) -> float:
    """Same tiers as the autopilot's confidence sizing (trader-autopilot/autopilot.py confidence_mult)."""
    if not pcfg.get("confidence_sizing", True):
        return 1.0
    tiers = pcfg.get("risk_tiers") or [[0.9, 2.0], [0.8, 1.5], [0.7, 1.0], [0.0, 0.5]]
    mult = 1.0
    for threshold, m in sorted(([_num(a, 0.0), _num(b, 1.0)] for a, b in tiers), reverse=True):
        if (_num(pc, 0.0) or 0.0) >= threshold:
            mult = m
            break
    if mult > 1 and (int(_num(n, 0) or 0)) < int(_num(pcfg.get("boost_min_test_trades"), 30) or 30):
        mult = 1.0
    return min(mult, _num(pcfg.get("max_risk_mult"), 2.0) or 2.0)


def lab_view(cfg: dict = None) -> dict:
    """The backtest lab's last run and the crypto playbook the autopilot trades from."""
    cfg = cfg or config.load_config()
    pcfg = ((cfg.get("autopilot") or {}).get("playbook") or {})
    out = {"required": bool(pcfg.get("required_for_crypto", True)), "max_age_days": _num(pcfg.get("max_age_days")),
           "auto_refresh_days": _num(pcfg.get("auto_refresh_days")), "available": False, "playbook": None,
           "families": [], "highest_win": []}
    pb = read_json("backtests/playbook.json", None)
    if isinstance(pb, dict) and isinstance(pb.get("entries"), dict):
        entries = []
        for key, e in pb["entries"].items():
            if not isinstance(e, dict):
                continue
            te = e.get("test") if isinstance(e.get("test"), dict) else {}
            entries.append({"key": key, "display": e.get("display") or e.get("symbol"), "setup": e.get("setup"),
                            "interval": e.get("interval"), "exit": e.get("exit_text"),
                            "win_rate": _num(te.get("win_rate")), "edge_r": _num(te.get("expectancy_r")),
                            "profit_chance": _num(te.get("profit_chance")), "trades": te.get("n"),
                            "risk_mult": _tier_mult(te.get("profit_chance"), te.get("n"), pcfg)})
        entries.sort(key=lambda e: -(e["profit_chance"] or 0))
        out["playbook"] = {"generated_at": pb.get("generated_at"), "valid_until": pb.get("valid_until"),
                           "entries": entries}
    doc = read_json("backtests/lab-crypto.json", None)
    if isinstance(doc, dict) and isinstance(doc.get("families"), list):
        out["available"] = True
        out["generated_at"] = doc.get("generated_at")
        out["universe"] = doc.get("universe")
        out["timeframes"] = doc.get("timeframes")
        out["costs"] = doc.get("costs")
        out["summary"] = doc.get("summary") if isinstance(doc.get("summary"), dict) else {}
        out["report"] = "lab-crypto.html" if (home() / "reports" / "lab-crypto.html").exists() else None
        for f in doc["families"]:
            if not isinstance(f, dict):
                continue
            tr = f.get("train") if isinstance(f.get("train"), dict) else {}
            te = f.get("test") if isinstance(f.get("test"), dict) else {}
            out["families"].append({"setup": f.get("setup"), "timeframe": f.get("timeframe"),
                                    "exit": (f.get("exit") or {}).get("text") if isinstance(f.get("exit"), dict) else None,
                                    "validated": bool(f.get("validated")), "verdict": f.get("verdict"),
                                    "win_train": _num(tr.get("win_rate")), "win_test": _num(te.get("win_rate")),
                                    "edge_train": _num(tr.get("expectancy_r")), "edge_test": _num(te.get("expectancy_r")),
                                    "profit_chance": _num(te.get("profit_chance"))})
            hw = f.get("highest_win") if isinstance(f.get("highest_win"), dict) else None
            if hw:
                out["highest_win"].append({"setup": f.get("setup"), "timeframe": f.get("timeframe"),
                                           "exit": (hw.get("exit") or {}).get("text"),
                                           "win_test": _num((hw.get("test") or {}).get("win_rate")),
                                           "edge_test": _num((hw.get("test") or {}).get("expectancy_r"))})
        out["highest_win"].sort(key=lambda x: -(x["win_test"] or 0))
        out["highest_win"] = out["highest_win"][:4]
    return out


def system_view(app=None) -> dict:
    cfg = config.load_config()
    return {"now": _now_iso(), "health": health_view(), "sessions": sessions_view(cfg), "universe": universe_view(cfg),
            "adapt": adapt_view(cfg), "notify": notify_view(cfg), "ai": ai_view(cfg), "lab": lab_view(cfg),
            "server": app.status() if app else {}}


def _secret_values() -> list:
    """Every configured secret (and the ntfy topic), longest first — scrubbed from every response."""
    vals = set()
    for name in secrets.KNOWN:
        v = secrets.get(name)
        if v and len(v) >= 8:
            vals.add(v)
    try:
        topic = str(((config.load_config().get("notify") or {}).get("ntfy_topic")) or "")
    except SystemExit:
        topic = ""
    if len(topic) >= 8:
        vals.add(topic)
    return sorted(vals, key=len, reverse=True)


def redact(text: str) -> str:
    for v in _secret_values():
        text = text.replace(v, REDACTED)
        quoted = json.dumps(v, ensure_ascii=False)[1:-1]
        if quoted != v:
            text = text.replace(quoted, REDACTED)
    return text


def write_control(action: str, by: str = "dashboard") -> dict:
    old = read_json("autopilot/control.json", {}) or {}
    c = {"paused": bool(old.get("paused")), "kill": bool(old.get("kill")), "run_once": bool(old.get("run_once"))}
    if old.get("dd_reset_at"):
        c["dd_reset_at"] = old["dd_reset_at"]  # keep the drawdown baseline across pause / run once
    if action == "pause":
        c["paused"] = True
    elif action == "resume":
        # resuming after a drawdown pause starts a new peak — otherwise the guard would trip again at once
        c.update(paused=False, kill=False, dd_reset_at=_now_iso())
    elif action == "run_once":
        c["run_once"] = True
    elif action == "kill":
        c.update(kill=True, paused=True)
    else:
        raise ValueError("unknown action %r" % action)
    c.update(updated_at=_now_iso(), by=by)
    state.write_json("autopilot/control.json", c)
    return c


# --- the app: background loops + sessions ------------------------------------------------------

class DashboardApp:
    def __init__(self, password: str = "", run_autopilot: bool = False, news_every: float = None):
        self.csrf = _pysecrets.token_urlsafe(32)
        self.password = password or ""
        self.sessions = {}
        self.lock = threading.Lock()
        self.run_autopilot = run_autopilot
        self.news_every = news_every
        self.wake = threading.Event()
        self.stop_event = threading.Event()
        self.autopilot = {"thread": False, "last_run": None, "last_error": None, "runs": 0, "available": None,
                          "deferred_to_daemon": False}
        self.news = {"thread": False, "last_run": None, "last_error": None, "runs": 0, "available": None,
                     "refreshing": False, "deferred_to_daemon": False}
        self.threads = []

    # sessions
    @property
    def auth_required(self) -> bool:
        return bool(self.password)

    def check_password(self, given: str) -> bool:
        return hmac.compare_digest(str(given or "").encode("utf-8"), self.password.encode("utf-8"))

    def new_session(self) -> str:
        token = _pysecrets.token_urlsafe(32)
        with self.lock:
            self.sessions[token] = time.time()
        return token

    def valid_session(self, token: str) -> bool:
        if not token:
            return False
        with self.lock:
            for known, created in list(self.sessions.items()):
                if time.time() - created > 7 * 86400:
                    del self.sessions[known]
                    continue
                if hmac.compare_digest(known.encode(), token.encode()):
                    return True
        return False

    def status(self) -> dict:
        return {"autopilot": {k: v for k, v in self.autopilot.items()},
                "news": {k: v for k, v in self.news.items()}, "auth": self.auth_required}

    # autopilot
    def _autopilot_module(self):
        try:
            mod = skills.load("trader-autopilot", "autopilot")
        except Exception as exc:
            self.autopilot.update(available=False, last_error="autopilot not installed (%s)" % exc)
            return None
        if not hasattr(mod, "run_cycle"):
            self.autopilot.update(available=False, last_error="autopilot not installed (no run_cycle)")
            return None
        self.autopilot["available"] = True
        return mod

    @staticmethod
    def daemon_active() -> bool:
        """A separate autopilot daemon is beating — this server must not trade the same folder too."""
        hb = health_view()
        if hb["state"] != "alive" or hb.get("runner") != "daemon":
            return False
        return not (hb.get("pid") == os.getpid() and hb.get("host") == socket.gethostname())

    @staticmethod
    def _run_cycle(mod):
        # this loop only runs when the user started it (--autopilot or autopilot.enabled): that is the
        # standing approval — limits, desk and risk gates still apply to every order
        kwargs = {"approved": True}
        if _accepts(mod.run_cycle, "runner"):
            kwargs["runner"] = "dashboard"
        return mod.run_cycle(**kwargs)

    def autopilot_loop(self):
        self.autopilot["thread"] = True
        while not self.stop_event.is_set():
            mod = self._autopilot_module()
            interval = 60.0
            if mod is not None and self.daemon_active():
                self.autopilot["deferred_to_daemon"] = True
            elif mod is not None:
                self.autopilot["deferred_to_daemon"] = False
                try:
                    self._run_cycle(mod)
                    self.autopilot.update(last_run=_now_iso(), last_error=None, runs=self.autopilot["runs"] + 1)
                except Exception as exc:  # keep the dashboard alive whatever the bot does
                    self.autopilot.update(last_run=_now_iso(), last_error="%s: %s" % (type(exc).__name__, exc))
                    _log_error("autopilot cycle", exc)
            try:
                interval = float((config.load_config().get("autopilot") or {}).get("interval_sec") or 60)
            except (SystemExit, Exception):
                interval = 60.0
            self.wake.wait(max(5.0, interval))
            self.wake.clear()
        self.autopilot["thread"] = False

    # news
    def _news_module(self):
        try:
            mod = skills.load("trader-news", "news")
        except Exception as exc:
            self.news.update(available=False, last_error="news skill unavailable (%s)" % exc)
            return None
        if not hasattr(mod, "refresh_feed"):
            self.news.update(available=False, last_error="news feed refresh not available yet (no refresh_feed)")
            return None
        self.news["available"] = True
        return mod

    def refresh_news(self) -> bool:
        mod = self._news_module()
        if mod is None:
            return False
        with self.lock:
            if self.news["refreshing"]:
                return True
            self.news["refreshing"] = True
        try:
            mod.refresh_feed()
            self.news.update(last_run=_now_iso(), last_error=None, runs=self.news["runs"] + 1)
        except Exception as exc:
            self.news.update(last_run=_now_iso(), last_error="%s: %s" % (type(exc).__name__, exc))
            _log_error("news refresh", exc)
        finally:
            self.news["refreshing"] = False
        return True

    def refresh_news_async(self) -> bool:
        if self._news_module() is None:
            return False
        t = threading.Thread(target=self.refresh_news, name="news-refresh", daemon=True)
        t.start()
        return True

    def news_loop(self):
        self.news["thread"] = True
        while not self.stop_event.is_set():
            if self.daemon_active():  # the daemon refreshes the feed itself — don't pay for X reads twice
                self.news["deferred_to_daemon"] = True
            else:
                self.news["deferred_to_daemon"] = False
                self.refresh_news()
            self.stop_event.wait(max(60.0, float(self.news_every or 15) * 60.0))
        self.news["thread"] = False

    def start_background(self):
        if self.run_autopilot:
            t = threading.Thread(target=self.autopilot_loop, name="autopilot", daemon=True)
            t.start()
            self.threads.append(t)
        if self.news_every:
            t = threading.Thread(target=self.news_loop, name="news", daemon=True)
            t.start()
            self.threads.append(t)

    def stop(self):
        self.stop_event.set()
        self.wake.set()


def _accepts(fn, name: str) -> bool:
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False
    return name in params or any(p.kind == p.VAR_KEYWORD for p in params.values())


# --- HTTP -----------------------------------------------------------------------------------------

LOGIN_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Trader · sign in</title>
<link rel="stylesheet" href="/static/app.css"></head><body class="login-body">
<form class="login" method="post" action="/login"><div class="brand"><span class="brand-mark"></span>Trader</div>
<label for="pw">Dashboard password</label><input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
<button type="submit" class="btn btn-primary">Sign in</button>%s
<p class="muted small">Educational tool, not financial advice.</p></form></body></html>"""


def make_handler(app: DashboardApp):
    class Handler(BaseHTTPRequestHandler):
        server_version = "TraderDashboard/1.0"
        sys_version = ""

        def log_message(self, fmt, *args):  # quiet by default; errors still go to stderr
            if os.environ.get("TRADER_DASHBOARD_LOG"):
                sys.stderr.write("dashboard: " + fmt % args + "\n")

        # -- helpers
        def _security_headers(self, csp: str = APP_CSP):
            self.send_header("Content-Security-Policy", csp)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Cache-Control", "no-store")

        def _send(self, code, body: bytes, ctype: str, csp: str = APP_CSP, extra=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self._security_headers(csp)
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, obj, code=200):
            text = redact(json.dumps(obj, ensure_ascii=False, default=str))  # defence in depth: no secret leaves
            self._send(code, text.encode("utf-8"), "application/json; charset=utf-8")

        def _error(self, code, message):
            self._json({"ok": False, "error": message}, code)

        def _cookie(self, name: str) -> str:
            raw = self.headers.get("Cookie") or ""
            for part in raw.split(";"):
                if "=" in part:
                    k, v = part.split("=", 1)
                    if k.strip() == name:
                        return v.strip()
            return ""

        def _authed(self) -> bool:
            return (not app.auth_required) or app.valid_session(self._cookie(SESSION_COOKIE))

        def _proxied_without_password(self) -> bool:
            # bound to 127.0.0.1 but reached through Caddy/nginx = public; a password is then mandatory
            return not app.auth_required and any(self.headers.get(h) for h in PROXY_HEADERS)

        def _refuse_proxy(self):
            return self._error(403, "this dashboard is reached through a reverse proxy but has no password — set "
                                    "TRADER_DASHBOARD_PASSWORD and restart it")

        def _same_origin(self) -> bool:
            host = self.headers.get("Host") or ""
            for h in ("Origin", "Referer"):
                v = self.headers.get(h)
                if v:
                    return urlsplit(v).netloc == host
            return True

        def _read_body(self) -> bytes:
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            if n > MAX_BODY:
                raise ValueError("request body too large")
            return self.rfile.read(n) if n > 0 else b""

        # -- GET
        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            try:
                self._get()
            except BrokenPipeError:
                pass
            except Exception as exc:
                _log_error("%s %s" % (self.command, urlsplit(self.path).path), exc)
                self._error(500, "internal error: %s" % type(exc).__name__)

        def _get(self):
            parts = urlsplit(self.path)
            path = parts.path
            q = {k: v[-1] for k, v in parse_qs(parts.query).items()}
            if self._proxied_without_password():
                return self._refuse_proxy()
            if path == "/login":
                if not app.auth_required:
                    return self._redirect("/")
                return self._send(200, (LOGIN_PAGE % "").encode("utf-8"), "text/html; charset=utf-8")
            if path.startswith("/static/"):
                return self._static(path[len("/static/"):])
            if path == "/favicon.ico":
                return self._static("favicon.svg")
            if not self._authed():
                if path.startswith("/api/"):
                    return self._error(401, "sign in first")
                return self._redirect("/login")
            if path in ("/", "/index.html"):
                html_ = (STATIC / "index.html").read_text(encoding="utf-8").replace("{{CSRF}}", app.csrf)
                return self._send(200, html_.encode("utf-8"), "text/html; charset=utf-8")
            if path.startswith("/reports/"):
                return self._report(path[len("/reports/"):])
            if path.startswith("/api/"):
                return self._api(path[len("/api/"):], q)
            return self._error(404, "not found")

        def _redirect(self, where: str, extra=None):
            self.send_response(303)
            self.send_header("Location", where)
            self.send_header("Content-Length", "0")
            self._security_headers()
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()

        def _static(self, name: str):
            if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._\-]*$", name or ""):
                return self._error(404, "not found")
            p = STATIC / name
            if not p.is_file() or p.suffix not in STATIC_TYPES or name == "index.html":
                return self._error(404, "not found")
            return self._send(200, p.read_bytes(), STATIC_TYPES[p.suffix])

        def _report(self, name: str):
            if not REPORT_NAME.match(name or "") or ".." in name:
                return self._error(404, "no such report")
            base = (home() / "reports").resolve()
            p = (base / name).resolve()
            if p.parent != base or not p.is_file():
                return self._error(404, "no such report")
            return self._send(200, p.read_bytes(), "text/html; charset=utf-8", csp=REPORT_CSP)

        def _api(self, name: str, q: dict):
            if name == "summary":
                return self._json(summary_view(app))
            if name == "equity":
                return self._json(equity_view(q.get("range", "all")))
            if name == "positions":
                return self._json({"positions": positions_view()})
            if name == "orders":
                return self._json(orders_view())
            if name == "trades":
                return self._json(trades_view(q.get("asset", ""), q.get("status", ""), q.get("setup", "")))
            if name.startswith("trade/"):
                tid = name[len("trade/"):]
                if not re.match(r"^[A-Za-z0-9._:\-]{1,200}$", tid):
                    return self._error(400, "bad trade id")
                res = trade_view(tid)
                return self._json(res) if res else self._error(404, "no such trade")
            if name == "decisions":
                try:
                    limit = int(q.get("limit") or 200)
                except ValueError:
                    limit = 200
                return self._json(decisions_view(limit))
            if name == "news":
                return self._json(news_view(q.get("asset", ""), q.get("symbol", ""), q.get("kind", "")))
            if name == "setups":
                return self._json(setups_view())
            if name == "reports":
                return self._json(reports_view())
            if name == "desk":
                return self._json(desk_view())
            if name == "control":
                return self._json(control_view())
            if name == "system":
                return self._json(system_view(app))
            return self._error(404, "unknown endpoint")

        # -- POST
        def do_POST(self):
            try:
                self._post()
            except BrokenPipeError:
                pass
            except ValueError as exc:
                self._error(400, str(exc))
            except Exception as exc:
                _log_error("%s %s" % (self.command, urlsplit(self.path).path), exc)
                self._error(500, "internal error: %s" % type(exc).__name__)

        def _post(self):
            path = urlsplit(self.path).path
            if self._proxied_without_password():
                return self._refuse_proxy()
            if path == "/login":
                return self._login()
            if not self._authed():
                return self._error(401, "sign in first")
            if not self._same_origin():
                return self._error(403, "cross-origin request refused")
            token = self.headers.get("X-Trader-CSRF") or ""
            if not hmac.compare_digest(token.encode("utf-8"), app.csrf.encode("utf-8")):
                return self._error(403, "missing or wrong X-Trader-CSRF header")
            raw = self._read_body()
            try:
                body = json.loads(raw.decode("utf-8") or "{}") if raw else {}
            except ValueError:
                return self._error(400, "body must be JSON")
            if not isinstance(body, dict):
                return self._error(400, "body must be a JSON object")
            if path == "/api/control":
                action = str(body.get("action") or "")
                if action not in ("pause", "resume", "run_once", "kill"):
                    return self._error(400, "action must be pause, resume, run_once or kill")
                if action == "kill" and body.get("confirm") != "KILL":
                    return self._error(400, "type KILL to confirm the kill switch")
                c = write_control(action)
                if action in ("run_once", "resume"):
                    app.wake.set()
                return self._json({"ok": True, "control": c})
            if path == "/api/news/refresh":
                started = app.refresh_news_async()
                return self._json({"ok": started, "available": started,
                                   "message": "refreshing" if started else (app.news.get("last_error")
                                                                             or "news refresh not available")})
            if path == "/api/logout":
                return self._redirect("/login", {"Set-Cookie": "%s=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"
                                                 % SESSION_COOKIE})
            return self._error(404, "unknown endpoint")

        def _login(self):
            if not app.auth_required:
                return self._redirect("/")
            if not self._same_origin():
                return self._error(403, "cross-origin request refused")
            raw = self._read_body().decode("utf-8", "replace")
            pw = (parse_qs(raw).get("password") or [""])[-1]
            if not app.check_password(pw):
                time.sleep(0.5)  # slow down guessing
                return self._send(401, (LOGIN_PAGE % "<p class='login-error'>Wrong password.</p>").encode("utf-8"),
                                  "text/html; charset=utf-8")
            token = app.new_session()
            secure = "; Secure" if (self.headers.get("X-Forwarded-Proto") or "").lower() == "https" else ""
            return self._redirect("/", {"Set-Cookie": "%s=%s; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800%s"
                                        % (SESSION_COOKIE, token, secure)})

    return Handler


def is_loopback(host: str) -> bool:
    if host in ("localhost", ""):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class StartupError(Exception):
    pass


def make_server(host: str = "127.0.0.1", port: int = 8765, password: str = "", run_autopilot: bool = False,
                news_every: float = None):
    """Build (but don't start serving) the dashboard. Raises StartupError on unsafe settings."""
    config.ensure_home()
    password = password or secrets.get("TRADER_DASHBOARD_PASSWORD")
    if not is_loopback(host) and not password:
        raise StartupError("refusing to listen on %s without a password — set TRADER_DASHBOARD_PASSWORD "
                           "(environment or trader/secrets.env) or pass --password" % host)
    app = DashboardApp(password, run_autopilot, news_every)
    httpd = ThreadingHTTPServer((host, port), make_handler(app))
    httpd.daemon_threads = True
    httpd.app = app
    return httpd, app


def build_parser():
    p = argparse.ArgumentParser(prog="server.py", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--home", metavar="DIR", help="trader/ state folder (default ./trader, also TRADER_HOME)")
    p.add_argument("--host", default="127.0.0.1", help="interface to bind (default 127.0.0.1 = this computer only)")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--password", default="", help="dashboard password (prefer TRADER_DASHBOARD_PASSWORD)")
    loop = p.add_mutually_exclusive_group()
    loop.add_argument("--autopilot", action="store_true", help="run the autopilot loop in the background")
    loop.add_argument("--no-autopilot", action="store_true",
                      help="never run the loop here, even if autopilot.enabled (a separate daemon trades)")
    p.add_argument("--news-every", type=float, metavar="MIN",
                   help="refresh the news & social feed every MIN minutes (default: config news.x.poll_minutes; 0 = off)")
    p.add_argument("--offline", action="store_true", help="serve fixture data (demos)")
    p.add_argument("--fixtures", metavar="DIR", help="fixture folder for --offline")
    p.add_argument("--now", metavar="ISO", help="pin the clock (demos)")
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.home:
        os.environ["TRADER_HOME"] = str(Path(args.home).expanduser().resolve())
    if args.fixtures:
        os.environ["TRADER_FIXTURES"] = str(Path(args.fixtures).expanduser().resolve())
    if args.offline:
        os.environ["TRADER_OFFLINE"] = "1"
    if args.now:
        os.environ["TRADER_NOW"] = market_clock.iso(market_clock.parse_iso(args.now))
    elif config.is_offline() and not os.environ.get("TRADER_NOW"):
        from shared import cli
        pinned = cli._fixture_now()
        if pinned:
            os.environ["TRADER_NOW"] = pinned
    config.ensure_home()
    cfg = config.load_config()
    run_ap = False if args.no_autopilot else bool(args.autopilot or (cfg.get("autopilot") or {}).get("enabled"))
    news_every = args.news_every
    if news_every is None:
        news_every = 0 if config.is_offline() else float(((cfg.get("news") or {}).get("x") or {}).get("poll_minutes") or 15)
    try:
        httpd, app = make_server(args.host, args.port, args.password, run_ap, news_every or None)
    except StartupError as exc:
        sys.stderr.write("trader: %s\n" % exc)
        return 2
    except OSError as exc:
        sys.stderr.write("trader: cannot listen on %s:%s (%s)\n" % (args.host, args.port, exc))
        return 2
    app.start_background()
    host, port = httpd.server_address[:2]
    shown = "127.0.0.1" if host in ("0.0.0.0", "::") else host
    print("Trader dashboard → http://%s:%s/   (state: %s)" % (shown, port, config.trader_home()))
    if not is_loopback(args.host):
        print("  listening on %s — reachable from other devices on your network; password required" % args.host)
    loop_txt = "on (idles while a separate daemon is running)" if run_ap else "off"
    print("  autopilot loop: %s · news refresh: %s" % (loop_txt, ("every %g min" % news_every) if news_every else "off"))
    print("  Ctrl+C to stop. Educational tool, not financial advice.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.stop()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
