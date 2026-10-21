"""StockTwits public symbol streams (no key) — crowd chatter and its bullish/bearish mix.

Crowd mood, not information: these are retail posts. The feed uses them for a
per-symbol sentiment summary and at most a couple of top messages.
"""
from __future__ import annotations

import re
from urllib.parse import quote

from .. import http, market_clock

NAME = "StockTwits"
BASE = "https://api.stocktwits.com/api/2/streams/symbol/%s.json"


def st_symbol(symbol: str, asset: str = "stock") -> str:
    """Stocks as-is (BRK.B), crypto as BASE.X (BTC.X)."""
    s = (symbol or "").upper().strip()
    if asset == "crypto":
        base = re.sub(r"(USDT|USDC|USD|FDUSD|BUSD)$", "", s.replace("/", "").replace("-", "")) or s
        return base + ".X"
    return s.replace("-", ".")


def _text(body: str) -> str:
    return re.sub(r"\s+", " ", body or "").strip()


def parse_stream(obj, now_ts: float = None) -> dict:
    obj = obj or {}
    msgs = []
    for m in obj.get("messages") or []:
        user = m.get("user") or {}
        senti = ((m.get("entities") or {}).get("sentiment") or {}) or {}
        basic = (senti.get("basic") or "").lower() or None
        try:
            published = market_clock.iso(market_clock.parse_iso(m.get("created_at")))
        except (TypeError, ValueError):
            published = None
        username = user.get("username") or "user"
        msgs.append({
            "id": str(m.get("id") or ""),
            "author": username,
            "followers": int(user.get("followers") or 0),
            "official": bool(user.get("official")),
            "text": _text(m.get("body")),
            "published": published,
            "sentiment": basic if basic in ("bullish", "bearish") else None,
            "likes": int((m.get("likes") or {}).get("total") or 0),
            "url": "https://stocktwits.com/%s/message/%s" % (username, m.get("id")),
        })
    msgs.sort(key=lambda x: x["published"] or "", reverse=True)
    return {"symbol": ((obj.get("symbol") or {}).get("symbol")) or "", "title": (obj.get("symbol") or {}).get("title"),
            "messages": msgs, "summary": summarize(msgs, now_ts)}


def summarize(msgs: list, now_ts: float = None) -> dict:
    bull = sum(1 for m in msgs if m["sentiment"] == "bullish")
    bear = sum(1 for m in msgs if m["sentiment"] == "bearish")
    stamps = sorted(market_clock.parse_iso(m["published"]).timestamp() for m in msgs if m["published"])
    now_ts = now_ts if now_ts is not None else market_clock.now_utc().timestamp()
    last_hour = sum(1 for t in stamps if now_ts - 3600 <= t <= now_ts)
    rate = None
    if len(stamps) >= 2:
        span_h = max((stamps[-1] - stamps[0]) / 3600.0, 1 / 60.0)
        rate = round(len(stamps) / span_h, 1)
    return {"count": len(msgs), "bullish": bull, "bearish": bear,
            "bullish_pct": round(100.0 * bull / (bull + bear), 1) if (bull + bear) else None,
            "msgs_per_hour": rate, "last_hour": last_hour,
            # the public stream returns one page (30): if all of it is from the last hour the real rate is higher
            "capped": bool(msgs) and last_hour >= len(msgs) >= 30}


def stream(symbol: str, asset: str = "stock", ttl: float = 120, now_ts: float = None) -> dict:
    sym = st_symbol(symbol, asset)
    obj = http.get_json(BASE % quote(sym), ttl=ttl, retries=1, timeout=10)
    if not isinstance(obj, dict) or (obj.get("response") or {}).get("status", 200) != 200:
        raise http.SourceError(BASE % sym, "StockTwits error for %s" % sym)
    return parse_stream(obj, now_ts)
