"""Kraken public OHLC (crypto, fallback #2). Kraken only serves the latest 720 bars."""
from __future__ import annotations

from .. import http
from ..indicators import Candle

NAME = "Kraken"
BASE = "https://api.kraken.com/0/public"
INTERVALS = {"1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440}


def _result(obj):
    if not isinstance(obj, dict) or obj.get("error"):
        raise http.SourceError("kraken", "Kraken error: %s" % (obj or {}).get("error"))
    res = obj.get("result") or {}
    for key, value in res.items():
        if key != "last":
            return value
    raise http.SourceError("kraken", "Kraken returned no data")


def parse_ohlc(obj) -> list:
    # [time, open, high, low, close, vwap, volume, count]
    out = []
    for r in _result(obj):
        try:
            out.append(Candle(int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[6])))
        except (TypeError, ValueError, IndexError):
            continue
    return out


def candles(pair: str, interval: str = "5m") -> list:
    rows = parse_ohlc(http.get_json("%s/OHLC?pair=%s&interval=%d" % (BASE, pair, INTERVALS[interval]), ttl=60))
    if not rows:
        raise http.SourceError("kraken", "Kraken returned no candles for %s" % pair)
    return rows


def ticker(pair: str) -> dict:
    t = _result(http.get_json("%s/Ticker?pair=%s" % (BASE, pair), ttl=20))
    price = float(t["c"][0])
    opened = float(t.get("o") or 0) or None
    return {"price": price, "prev_close": opened,
            "change_pct": ((price / opened - 1) * 100) if opened else None,
            "volume": float((t.get("v") or [0, 0])[1])}
