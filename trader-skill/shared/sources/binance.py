"""Binance public market data (crypto, primary).

api.binance.com answers HTTP 451 from some countries (e.g. the US); the
data-api.binance.vision mirror serves the same public market data and is
tried next. Futures funding / open interest come from fapi.binance.com,
which is geo-blocked the same way — callers fall back to OKX.
"""
from __future__ import annotations

from .. import http
from ..indicators import Candle

NAME = "Binance"
HOSTS = ("https://api.binance.com", "https://data-api.binance.vision")
FAPI = "https://fapi.binance.com"
INTERVALS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}


def _get(path: str, ttl: float = 30):
    last = None
    for host in HOSTS:
        try:
            return http.get_json(host + path, ttl=ttl)
        except http.SourceError as exc:  # includes GeoBlocked → try the mirror
            last = exc
    raise last


def parse_klines(rows) -> list:
    out = []
    for r in rows or []:
        try:
            out.append(Candle(int(r[0]) // 1000, float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])))
        except (TypeError, ValueError, IndexError):
            continue
    return out


def klines(symbol: str, interval: str = "5m", days: float = 60, end_ts: int = None) -> list:
    """Paginate 1000 bars at a time from ``end - days`` up to ``end``."""
    step = INTERVALS[interval]
    import time as _time
    end_ts = int(end_ts or _time.time())
    start_ms = (end_ts - int(days * 86400)) * 1000
    end_ms = end_ts * 1000
    out = []
    cursor = start_ms
    for _ in range(200):  # hard stop: 200k bars
        rows = _get("/api/v3/klines?symbol=%s&interval=%s&startTime=%d&endTime=%d&limit=1000"
                    % (symbol, interval, cursor, end_ms), ttl=60)
        batch = parse_klines(rows)
        if not batch:
            break
        out.extend(batch)
        cursor = (batch[-1].t + step) * 1000
        if len(batch) < 1000 or cursor > end_ms:
            break
    seen, uniq = set(), []
    for c in out:
        if c.t not in seen:
            seen.add(c.t)
            uniq.append(c)
    if not uniq:
        raise http.SourceError("binance", "Binance returned no klines for %s" % symbol)
    return uniq


def ticker_24h(symbol: str) -> dict:
    d = _get("/api/v3/ticker/24hr?symbol=%s" % symbol, ttl=20)
    return {
        "price": float(d["lastPrice"]),
        "prev_close": float(d.get("openPrice") or 0) or None,  # 24h-ago price
        "change_pct": float(d.get("priceChangePercent") or 0),
        "volume": float(d.get("volume") or 0),
        "quote_volume": float(d.get("quoteVolume") or 0),
        "high": float(d.get("highPrice") or 0),
        "low": float(d.get("lowPrice") or 0),
        "time": int(d.get("closeTime", 0)) // 1000,
    }


def all_tickers() -> list:
    return _get("/api/v3/ticker/24hr", ttl=300)


def exchange_info(symbol: str) -> dict:
    d = _get("/api/v3/exchangeInfo?symbol=%s" % symbol, ttl=86400)
    syms = d.get("symbols") or []
    if not syms:
        raise http.SourceError("binance", "unknown Binance symbol %s" % symbol)
    filters = {f["filterType"]: f for f in syms[0].get("filters", [])}
    lot = filters.get("LOT_SIZE", {})
    price_f = filters.get("PRICE_FILTER", {})
    notional = filters.get("NOTIONAL") or filters.get("MIN_NOTIONAL") or {}
    return {
        "step": float(lot.get("stepSize") or 0) or None,
        "min_qty": float(lot.get("minQty") or 0) or None,
        "tick": float(price_f.get("tickSize") or 0) or None,
        "min_notional": float(notional.get("minNotional") or 0) or None,
        "status": syms[0].get("status"),
        "source": NAME,
    }


def funding(symbol: str) -> dict:
    d = http.get_json(FAPI + "/fapi/v1/premiumIndex?symbol=%s" % symbol, ttl=60)
    return {"funding_rate": float(d.get("lastFundingRate") or 0), "mark_price": float(d.get("markPrice") or 0),
            "next_funding_time": int(d.get("nextFundingTime") or 0) // 1000, "source": "Binance futures"}


def open_interest_hist(symbol: str, period: str = "5m", limit: int = 48) -> list:
    rows = http.get_json(FAPI + "/futures/data/openInterestHist?symbol=%s&period=%s&limit=%d"
                         % (symbol, period, limit), ttl=60)
    return [(int(r["timestamp"]) // 1000, float(r["sumOpenInterest"]), float(r.get("sumOpenInterestValue") or 0))
            for r in rows]
