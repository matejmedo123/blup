"""Stooq CSV (stocks, fallback).

Stooq stamps intraday bars in Polish local time (CET/CEST). Whether a bar is
stamped at its start or its end is detected from where the first bar of each
US session lands relative to the 9:30 ET open.
"""
from __future__ import annotations

import csv
import io
from datetime import datetime, timedelta

from .. import http, market_clock
from ..indicators import Candle

NAME = "Stooq"
INTERVALS = {"5m": "5", "15m": "15", "1h": "60", "1d": "d"}


def csv_url(sym, interval: str = "5m") -> str:
    return "https://stooq.com/q/d/l/?s=%s&i=%s" % (sym.stooq, INTERVALS[interval])


def parse_csv(text: str, interval: str = "5m") -> list:
    if not text or text.lstrip().lower().startswith(("no data", "<")):
        raise ValueError("Stooq returned no data")
    rows = list(csv.DictReader(io.StringIO(text)))
    if not rows or "Close" not in rows[0]:
        raise ValueError("unexpected Stooq CSV header")
    step = market_clock.interval_seconds(interval)
    raw = []
    for r in rows:
        try:
            local = datetime.strptime("%s %s" % (r["Date"], r.get("Time") or "00:00:00"), "%Y-%m-%d %H:%M:%S")
            guess = local.replace(tzinfo=market_clock.UTC) - timedelta(hours=1)
            utc = local.replace(tzinfo=market_clock.UTC) - market_clock.warsaw_offset(guess)
            raw.append((int(utc.timestamp()), float(r["Open"]), float(r["High"]), float(r["Low"]),
                        float(r["Close"]), float(r.get("Volume") or 0)))
        except (KeyError, ValueError):
            continue
    if interval == "1d" or not raw:
        return [Candle(*x) for x in raw]
    # end-stamped feeds put the first bar at 9:35 ET instead of 9:30 → shift back one bar
    firsts = {}
    for t, *_ in raw:
        d = market_clock.et_date(t)
        firsts[d] = min(firsts.get(d, t), t)
    end_stamped = 0
    for d, t in firsts.items():
        b = market_clock.session_bounds(d)
        if b and t - int(b[0].timestamp()) == step:
            end_stamped += 1
    shift = step if end_stamped > len(firsts) / 2 else 0
    return [Candle(t - shift, o, h, l, c, v) for t, o, h, l, c, v in raw]


def get_candles(sym, interval: str = "5m", days: int = 60):
    if interval not in INTERVALS:
        raise http.SourceError("stooq", "Stooq has no %s bars" % interval)
    text = http.get_text(csv_url(sym, interval), ttl=120)
    try:
        candles = parse_csv(text, interval)
    except ValueError as exc:
        raise http.SourceError(csv_url(sym, interval), "Stooq: %s" % exc)
    if not candles:
        raise http.SourceError(csv_url(sym, interval), "Stooq returned no candles for %s" % sym.base)
    cutoff = candles[-1].t - days * 86400
    return [c for c in candles if c.t >= cutoff], {}
