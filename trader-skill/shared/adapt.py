"""What the autopilot learns from its own record — and how it gets more careful because of it.

Read from closed journal trades the autopilot opened (``"source": "autopilot"``), scored by
``r_net`` (net of costs; ``r_multiple`` when that is missing):

* a setup that keeps losing on an asset class (≥ ``min_trades`` trades, net expectancy at or below
  ``disable_below_r``) is paused for ``cooldown_days``; afterwards it starts with a clean slate;
* a symbol with ``symbol_loss_streak`` losses in a row sits out ``symbol_cooldown_days``;
* ``loss_streak`` losses in a row overall cut the risk per trade by ``loss_streak_risk_mult``
  until the next winning trade;
* equity ``max_drawdown_pct`` below its peak pauses the autopilot until a human resumes it
  (resume writes ``control.json dd_reset_at`` and the peak starts over from there).

It only ever makes the autopilot more careful — it never raises risk above the configured size
and never re-enables anything early. State lives in ``autopilot/adapt.json``.
"""
from __future__ import annotations

import json
import os
from datetime import timedelta

from . import config, market_clock, state

FILE = "autopilot/adapt.json"
EQUITY = "broker/equity.jsonl"
CONTROL = "autopilot/control.json"
MAX_EVENTS = 100
DEFAULTS = {"enabled": True, "min_trades": 8, "disable_below_r": -0.25, "cooldown_days": 7,
            "symbol_loss_streak": 3, "symbol_cooldown_days": 5, "loss_streak": 3,
            "loss_streak_risk_mult": 0.5, "max_drawdown_pct": 10}


def settings(cfg: dict) -> dict:
    out = dict(DEFAULTS)
    out.update(((cfg or {}).get("autopilot") or {}).get("adapt") or {})
    return out


def _r(t: dict):
    v = t.get("r_net")
    if v is None:
        v = t.get("r_multiple")
    return float(v) if v is not None else None


def _closed_trades(now_ts: float) -> list:
    out = []
    for t in (state.read_json("journal.json", {}) or {}).get("trades") or []:
        if t.get("source") != "autopilot" or t.get("status") != "closed":
            continue
        if (t.get("runner") or {}).get("part") == "ride":  # judged with the trade it rode on from, like the backtest
            continue
        at = (t.get("exit") or {}).get("time")
        r = _r(t)
        if not at or r is None:
            continue
        ts = market_clock.ts(at)
        if ts > now_ts:  # a pinned clock must not see the future
            continue
        out.append({"at": at, "ts": ts, "r": r, "asset": t.get("asset") or "stock", "setup": t.get("setup") or "manual",
                    "key": t.get("symbol_key") or t.get("symbol") or "?",
                    "display": t.get("display") or t.get("symbol") or "?"})
    out.sort(key=lambda x: (x["ts"], x["key"]))
    return out


def _after(rows: list, since) -> list:
    if not since:
        return rows
    s = market_clock.ts(since)
    return [x for x in rows if x["ts"] > s]


def _streak(rows: list) -> int:
    """Losses in a row at the end; a scratch (0R) neither extends nor breaks it, a win ends it."""
    n = 0
    for x in reversed(rows):
        if x["r"] > 0:
            break
        if x["r"] < 0:
            n += 1
    return n


def _day(iso: str) -> str:
    return (iso or "")[:10]


def _first_at(path):
    try:
        with path.open("rb") as fh:
            return json.loads(fh.readline().decode("utf-8")).get("at")
    except (OSError, ValueError, AttributeError):
        return None


def _equity(prev: dict, now_ts: float) -> dict:
    """Incremental peak tracking over broker/equity.jsonl (it grows by one line per cycle)."""
    control = state.read_json(CONTROL, {}) or {}
    basis = control.get("dd_reset_at")
    eq = dict(prev.get("_equity") or {})
    if eq.get("basis") != basis:
        eq = {"basis": basis, "offset": 0, "peak": None, "last": None, "last_at": None}
    path = state.home() / EQUITY
    try:
        size = path.stat().st_size
    except OSError:
        return eq
    offset = int(eq.get("offset") or 0)
    if offset > size:  # smaller than what was read: compacted, or replaced (a fresh simulator)
        first = _first_at(path)
        # compaction keeps the first hour: the same file, and the peak since the same basis still stands
        same = bool(first and eq.get("first_at") and first[:13] == str(eq["first_at"])[:13])
        eq.update(offset=0, last=None, last_at=None, **({} if same else {"peak": None}))
        offset = 0
    if offset == 0:
        eq["first_at"] = _first_at(path)
    basis_ts = market_clock.ts(basis) if basis else None
    with path.open("rb") as fh:
        fh.seek(offset)
        while True:
            line = fh.readline()
            if not line or not line.endswith(b"\n"):
                break  # a half-written last line is read next time
            try:
                row = json.loads(line.decode("utf-8"))
            except ValueError:
                offset = fh.tell()
                continue
            at = row.get("at")
            if not at or row.get("equity") is None:
                offset = fh.tell()
                continue
            ts = market_clock.ts(at)
            if ts > now_ts and os.environ.get("TRADER_NOW"):  # a replay: leave it for when its clock gets there
                break  # (a real clock that stepped back must not hide the drawdown until it catches up)
            offset = fh.tell()
            if basis_ts is not None and ts < basis_ts:
                continue
            value = float(row["equity"])
            eq["peak"] = value if eq.get("peak") is None else max(float(eq["peak"]), value)
            eq["last"], eq["last_at"] = value, at
    eq["offset"] = offset
    return eq


def evaluate(cfg: dict = None, now=None) -> dict:
    """Recompute adapt.json from the record. Returns the doc plus ``new_events`` from this call only."""
    cfg = cfg or config.load_config()
    a = settings(cfg)
    now_dt = market_clock.parse_iso(now) if now else market_clock.now_utc()
    now_ts = now_dt.timestamp()
    now_iso = market_clock.iso(now_dt)
    prev = state.read_json(FILE, {}) or {}
    events = []

    def event(kind, text):
        events.append({"at": now_iso, "kind": kind, "text": text})

    if not a.get("enabled", True):
        doc = {"updated_at": now_iso, "enabled": False, "setups": {}, "symbols": {}, "loss_streak": 0,
               "risk_mult": 1.0, "risk_reason": None, "equity_peak": None, "equity": None, "drawdown_pct": None,
               "drawdown_pause": False, "events": (prev.get("events") or [])[-MAX_EVENTS:]}
        state.write_json(FILE, doc)
        return dict(doc, new_events=[])

    trades = _closed_trades(now_ts)
    min_trades, floor = int(a["min_trades"]), float(a["disable_below_r"])

    # setups per asset class
    setups = {}
    keys = sorted({"%s:%s" % (t["asset"], t["setup"]) for t in trades} | set((prev.get("setups") or {}).keys()))
    for key in keys:
        old = (prev.get("setups") or {}).get(key) or {}
        since, status, until, reason = old.get("since"), old.get("status") or "active", old.get("until"), old.get("reason")
        asset, setup = key.split(":", 1)
        if status == "paused" and until and market_clock.ts(until) <= now_ts:
            status, since, reason = "active", until, "clean slate after the cooldown"
            event("setup_resumed", "%s on %s is back after its cooldown — it starts with a clean slate" % (setup, asset))
            until = None
        rows = _after([t for t in trades if "%s:%s" % (t["asset"], t["setup"]) == key], since)
        n = len(rows)
        wins = sum(1 for t in rows if t["r"] > 0)
        exp = round(sum(t["r"] for t in rows) / n, 3) if n else None
        if status != "paused" and n >= min_trades and exp is not None and exp <= floor:
            until = market_clock.iso(now_dt + timedelta(days=float(a["cooldown_days"])))
            status = "paused"
            reason = "%d trades, %d won, net expectancy %+.2fR (pause at ≤ %+.2fR)" % (n, wins, exp, floor)
            event("setup_paused", "paused %s on %s until %s — %s" % (setup, asset, _day(until), reason))
        setups[key] = {"trades": n, "wins": wins, "expectancy_r": exp, "status": status,
                       "until": until if status == "paused" else None, "since": since, "reason": reason}

    # symbols
    syms = {}
    sym_keys = sorted({t["key"] for t in trades} | set((prev.get("symbols") or {}).keys()))
    need = int(a["symbol_loss_streak"])
    for key in sym_keys:
        old = (prev.get("symbols") or {}).get(key) or {}
        since, status, until, reason = old.get("since"), old.get("status") or "active", old.get("until"), old.get("reason")
        if status == "cooldown" and until and market_clock.ts(until) <= now_ts:
            status, since, reason = "active", until, "clean slate after the cooldown"
            event("symbol_resumed", "%s is back after its cooldown" % key)
            until = None
        rows = _after([t for t in trades if t["key"] == key], since)
        streak = _streak(rows)
        if status != "cooldown" and need > 0 and streak >= need:
            until = market_clock.iso(now_dt + timedelta(days=float(a["symbol_cooldown_days"])))
            status = "cooldown"
            reason = "%d losing trades in a row" % streak
            event("symbol_cooldown", "%s sits out until %s — %s" % (key, _day(until), reason))
        syms[key] = {"loss_streak": streak, "status": status, "until": until if status == "cooldown" else None,
                     "since": since, "reason": reason}

    # risk after a losing streak
    streak = _streak(trades)
    mult = float(a["loss_streak_risk_mult"])
    reduced = int(a["loss_streak"]) > 0 and streak >= int(a["loss_streak"]) and mult < 1.0
    risk_mult = max(0.0, mult) if reduced else 1.0
    risk_reason = ("%d losing trades in a row — risk × %g until the next win" % (streak, risk_mult)) if reduced else None
    prev_mult = float(prev.get("risk_mult") if prev.get("risk_mult") is not None else 1.0)
    if reduced and prev_mult >= 1.0:
        event("risk_reduced", risk_reason)
    elif not reduced and prev_mult < 1.0:
        event("risk_restored", "a winning trade ended the losing streak — back to full risk per trade")

    # drawdown from the equity peak
    eq = _equity(prev, now_ts)
    peak, last = eq.get("peak"), eq.get("last")
    dd = round((peak - last) / peak * 100.0, 2) if peak and last is not None and peak > 0 else None
    pause = dd is not None and dd >= float(a["max_drawdown_pct"])
    was = bool(prev.get("drawdown_pause")) and (prev.get("_equity") or {}).get("basis") == eq.get("basis")
    if pause and not was:
        event("drawdown_pause", "equity %.2f is %.1f%% below its peak %.2f (limit %s%%) — the autopilot pauses "
                                "itself until you resume it" % (last, dd, peak, a["max_drawdown_pct"]))

    doc = {"updated_at": now_iso, "enabled": True, "setups": setups, "symbols": syms, "loss_streak": streak,
           "risk_mult": risk_mult, "risk_reason": risk_reason, "equity_peak": peak, "equity": last,
           "drawdown_pct": dd, "drawdown_pause": pause,
           "events": ((prev.get("events") or []) + events)[-MAX_EVENTS:], "_equity": eq}
    state.write_json(FILE, doc)
    return dict(doc, new_events=events)


def _active(entry: dict, now_ts: float, status: str) -> bool:
    if not entry or entry.get("status") != status:
        return False
    until = entry.get("until")
    return not until or market_clock.ts(until) > now_ts


def check(doc: dict, asset: str, setup: str, symbol_key: str) -> tuple:
    """(ok, reason) — may the autopilot take this setup on this symbol right now?"""
    if not doc or not doc.get("enabled", True):
        return True, None
    now_ts = market_clock.now_utc().timestamp()
    if doc.get("drawdown_pause"):
        return False, "drawdown pause: equity %.1f%% below its peak — resume to trade again" % (doc.get("drawdown_pct") or 0)
    s = (doc.get("setups") or {}).get("%s:%s" % (asset, setup))
    if _active(s, now_ts, "paused"):
        return False, "learned: %s paused on %s until %s — %s" % (setup, asset, _day(s.get("until")), s.get("reason"))
    y = (doc.get("symbols") or {}).get(symbol_key)
    if _active(y, now_ts, "cooldown"):
        return False, "learned: %s sits out until %s — %s" % (symbol_key, _day(y.get("until")), y.get("reason"))
    return True, None


def risk_mult(doc: dict) -> float:
    if not doc or not doc.get("enabled", True):
        return 1.0
    try:
        return max(0.0, min(1.0, float(doc.get("risk_mult", 1.0))))
    except (TypeError, ValueError):
        return 1.0
