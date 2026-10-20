"""Coinbase Exchange public candles (crypto, fallback #1). Max 300 bars per request."""
from __future__ import annotations

import time as _time
from datetime import datetime, timezone

from .. import http
from ..indicators import Candle

NAME = "Coinbase"
BASE = "https://api.exchange.coinbase.com"
GRANULARITY = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400}
MAX_DAYS = 30  # 30 days of 5-min bars = 29 requests; enough for a fallback


def _iso(t: int) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_candles(rows) -> list:
    # [time, low, high, open, close, volume], newest first
    out = []
    for r in rows or []:
        try:
            out.append(Candle(int(r[0]), float(r[3]), float(r[2]), float(r[1]), float(r[4]), float(r[5])))
        except (TypeError, ValueError, IndexError):
            continue
    return sorted(out, key=lambda c: c.t)


def candles(product: str, interval: str = "5m", days: float = 30, end_ts: int = None) -> list:
    gran = GRANULARITY[interval]
    end_ts = int(end_ts or _time.time())
    start_ts = end_ts - int(min(days, MAX_DAYS) * 86400)
    out = {}
    cursor_end = end_ts
    while cursor_end > start_ts:
        cursor_start = max(start_ts, cursor_end - gran * 300)
        rows = http.get_json("%s/products/%s/candles?granularity=%d&start=%s&end=%s"
                             % (BASE, product, gran, _iso(cursor_start), _iso(cursor_end)), ttl=60)
        batch = parse_candles(rows)
        for c in batch:
            out[c.t] = c
        if not batch:
            break
        cursor_end = cursor_start
    if not out:
        raise http.SourceError("coinbase", "Coinbase returned no candles for %s" % product)
    return [out[t] for t in sorted(out)]


def ticker(product: str) -> dict:
    t = http.get_json("%s/products/%s/ticker" % (BASE, product), ttl=20)
    s = {}
    try:
        s = http.get_json("%s/products/%s/stats" % (BASE, product), ttl=60)
    except http.SourceError:
        pass
    price = float(t["price"])
    opened = float(s.get("open") or 0) or None
    return {"price": price, "prev_close": opened,
            "change_pct": ((price / opened - 1) * 100) if opened else None,
            "volume": float(t.get("volume") or s.get("volume") or 0)}


def product(product_id: str) -> dict:
    p = http.get_json("%s/products/%s" % (BASE, product_id), ttl=86400)
    return {"step": float(p.get("base_increment") or 0) or None, "tick": float(p.get("quote_increment") or 0) or None,
            "min_notional": float(p.get("min_market_funds") or 0) or None, "min_qty": None,
            "status": p.get("status"), "source": NAME}
