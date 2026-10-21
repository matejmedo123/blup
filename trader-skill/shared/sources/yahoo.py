"""Yahoo Finance chart JSON (stocks, primary). No key; be polite, it throttles hard."""
from __future__ import annotations

from urllib.parse import quote

from .. import http
from ..indicators import Candle

BASES = ("https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com")
INTERVALS = {"1m": ("1m", 7), "5m": ("5m", 60), "15m": ("15m", 60), "30m": ("30m", 60),
             "1h": ("60m", 365), "1d": ("1d", 3650)}
NAME = "Yahoo Finance"


def chart_url(ticker: str, interval: str = "5m", days: int = 60, base: str = BASES[0],
              prepost: bool = False) -> str:
    iv, max_days = INTERVALS[interval]
    days = max(1, min(int(days), max_days))
    return "%s/v8/finance/chart/%s?interval=%s&range=%dd&includePrePost=%s" % (
        base, quote(ticker), iv, days, "true" if prepost else "false")


def parse_chart(obj):
    chart = (obj or {}).get("chart") or {}
    if chart.get("error"):
        err = chart["error"]
        raise ValueError(err.get("description") if isinstance(err, dict) else str(err))
    results = chart.get("result") or []
    if not results:
        raise ValueError("Yahoo returned no chart data")
    r = results[0]
    meta = r.get("meta") or {}
    stamps = r.get("timestamp") or []
    q = ((r.get("indicators") or {}).get("quote") or [{}])[0]
    o, h, l, c, v = (q.get(k) or [] for k in ("open", "high", "low", "close", "volume"))
    candles = []
    for i, t in enumerate(stamps):
        try:
            row = (o[i], h[i], l[i], c[i])
        except IndexError:
            continue
        if None in row:
            continue
        vol = v[i] if i < len(v) and v[i] is not None else 0
        candles.append(Candle(int(t), float(row[0]), float(row[1]), float(row[2]), float(row[3]), float(vol)))
    return candles, meta


def _chart(ticker: str, interval: str, days: int, ttl: float):
    last = None
    for base in BASES:
        url = chart_url(ticker, interval, days, base)
        try:
            return parse_chart(http.get_json(url, ttl=ttl))
        except http.GeoBlocked:
            raise
        except http.OfflineMiss:
            raise
        except (http.SourceError, ValueError) as exc:
            last = exc
    raise http.SourceError(chart_url(ticker, interval, days), "Yahoo chart failed for %s: %s" % (ticker, last))


def get_candles(sym, interval: str = "5m", days: int = 60):
    candles, meta = _chart(sym.yahoo, interval, days, ttl=60)
    info = {
        "name": meta.get("shortName") or meta.get("longName") or "",
        "exchange": meta.get("fullExchangeName") or meta.get("exchangeName") or "",
        "currency": meta.get("currency") or "USD",
        "regular_market_price": meta.get("regularMarketPrice"),
    }
    return candles, info


def get_quote(sym) -> dict:
    candles, meta = _chart(sym.yahoo, "5m", 1, ttl=30)
    price = meta.get("regularMarketPrice") or (candles[-1].c if candles else None)
    prev = meta.get("chartPreviousClose") or meta.get("previousClose")
    if price is None:
        raise http.SourceError("yahoo", "Yahoo returned no price for %s" % sym.yahoo)
    return {
        "price": float(price),
        "prev_close": float(prev) if prev else None,
        "volume": meta.get("regularMarketVolume"),
        "time": meta.get("regularMarketTime"),
        "day_high": meta.get("regularMarketDayHigh"),
        "day_low": meta.get("regularMarketDayLow"),
        "name": meta.get("shortName") or meta.get("longName") or "",
    }


def spark_url(tickers, base: str = BASES[0]) -> str:
    return "%s/v8/finance/spark?symbols=%s&range=1d&interval=5m" % (base, quote(",".join(tickers), safe=","))


def parse_spark(obj) -> dict:
    """Both spark formats → {ticker: {"closes": [...], "prev_close": float}}."""
    out = {}
    if isinstance(obj, dict) and "spark" in obj:  # older format
        for item in (obj["spark"] or {}).get("result") or []:
            resp = (item.get("response") or [{}])[0]
            closes = (((resp.get("indicators") or {}).get("quote") or [{}])[0].get("close")) or []
            meta = resp.get("meta") or {}
            out[item.get("symbol")] = {"closes": [c for c in closes if c is not None],
                                       "prev_close": meta.get("chartPreviousClose") or meta.get("previousClose")}
        return out
    for sym, item in (obj or {}).items():
        if not isinstance(item, dict):
            continue
        closes = [c for c in (item.get("close") or []) if c is not None]
        out[sym] = {"closes": closes, "prev_close": item.get("chartPreviousClose") or item.get("previousClose")}
    return out


def spark(tickers) -> dict:
    """Cheap bulk pre-filter: today's 5-min closes for up to 20 tickers in one call."""
    return parse_spark(http.get_json(spark_url(tickers), ttl=120))


SCREENERS = ("most_actives", "day_gainers", "day_losers")


def screener_url(scr_id: str, count: int = 25, base: str = BASES[0]) -> str:
    return "%s/v1/finance/screener/predefined/saved?scrIds=%s&count=%d" % (base, quote(scr_id), int(count))


def _raw(v):
    """Yahoo sends plain numbers or {"raw": 1.2, "fmt": "1.20"} depending on the endpoint."""
    if isinstance(v, dict):
        v = v.get("raw")
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def parse_screener(obj) -> list:
    fin = (obj or {}).get("finance") or {}
    if fin.get("error"):
        err = fin["error"]
        raise ValueError(err.get("description") if isinstance(err, dict) else str(err))
    out = []
    for res in fin.get("result") or []:
        for q in res.get("quotes") or []:
            t = str(q.get("symbol") or "").upper()
            if not t:
                continue
            out.append({"ticker": t, "price": _raw(q.get("regularMarketPrice")),
                        "change_pct": _raw(q.get("regularMarketChangePercent")),
                        "volume": _raw(q.get("regularMarketVolume")),
                        "avg_volume": _raw(q.get("averageDailyVolume3Month")) or _raw(q.get("averageDailyVolume10Day")),
                        "market_cap": _raw(q.get("marketCap")),
                        "name": q.get("shortName") or q.get("longName") or t,
                        "quote_type": q.get("quoteType")})
    return out


def screener(scr_id: str, count: int = 25) -> list:
    """Yahoo's predefined screeners ("most_actives", "day_gainers") — today's busiest names."""
    if scr_id not in SCREENERS:
        raise ValueError("unknown Yahoo screener %r" % scr_id)
    try:
        return parse_screener(http.get_json(screener_url(scr_id, count), ttl=300))
    except ValueError as exc:
        raise http.SourceError(screener_url(scr_id, count), "Yahoo screener %s: %s" % (scr_id, exc))


def news_rss_url(ticker: str) -> str:
    return "https://feeds.finance.yahoo.com/rss/2.0/headline?s=%s&region=US&lang=en-US" % quote(ticker)
