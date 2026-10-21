"""GeckoTerminal public API — OHLCV candles per DEX pool (≈30 requests/min, newest bar first)."""
from __future__ import annotations

import time as _time

from .. import http
from ..indicators import Candle

NAME = "GeckoTerminal"
BASE = "https://api.geckoterminal.com/api/v2"
TIMEFRAMES = {"1m": ("minute", 1), "5m": ("minute", 5), "15m": ("minute", 15),
              "1h": ("hour", 1), "4h": ("hour", 4), "1d": ("day", 1)}


def parse_ohlcv(obj) -> list:
    rows = (((obj or {}).get("data") or {}).get("attributes") or {}).get("ohlcv_list") or []
    out = []
    for r in rows:
        try:
            out.append(Candle(int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])))
        except (TypeError, ValueError, IndexError):
            continue
    return sorted(out, key=lambda c: c.t)


def ohlcv(network: str, pool: str, interval: str = "5m", days: float = 30, end_ts: int = None,
          max_pages: int = 10) -> list:
    tf, agg = TIMEFRAMES[interval]
    step = {"minute": 60, "hour": 3600, "day": 86400}[tf] * agg
    end_ts = int(end_ts or _time.time()) // step * step  # on a bar boundary: one cached URL per bar, not per second
    start_ts = end_ts - int(days * 86400)
    out = {}
    before = end_ts + 1
    for _ in range(max_pages):
        url = ("%s/networks/%s/pools/%s/ohlcv/%s?aggregate=%d&limit=1000&currency=usd&before_timestamp=%d"
               % (BASE, network, pool, tf, agg, before))
        batch = parse_ohlcv(http.get_json(url, ttl=60))
        if not batch:
            break
        for c in batch:
            out[c.t] = c
        oldest = batch[0].t
        if len(batch) < 1000 or oldest <= start_ts:
            break
        before = oldest
    if not out:
        raise http.SourceError("geckoterminal", "GeckoTerminal returned no candles for pool %s" % pool)
    return [out[t] for t in sorted(out) if t >= start_ts]
