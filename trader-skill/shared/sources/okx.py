"""OKX public swap data — fallback for funding rate and open interest when Binance futures is geo-blocked."""
from __future__ import annotations

from .. import http

NAME = "OKX"
BASE = "https://www.okx.com/api/v5"


def _data(url: str, ttl: float = 60):
    obj = http.get_json(url, ttl=ttl)
    if not isinstance(obj, dict) or str(obj.get("code")) != "0":
        raise http.SourceError(url, "OKX error: %s" % (obj or {}).get("msg"))
    return obj.get("data") or []


def funding(inst_id: str) -> dict:
    rows = _data("%s/public/funding-rate?instId=%s" % (BASE, inst_id))
    if not rows:
        raise http.SourceError("okx", "OKX has no funding rate for %s" % inst_id)
    r = rows[0]
    return {"funding_rate": float(r.get("fundingRate") or 0), "mark_price": None,
            "next_funding_time": int(r.get("nextFundingTime") or r.get("fundingTime") or 0) // 1000,
            "source": NAME}


def open_interest_hist(inst_id: str, period: str = "5m", limit: int = 48) -> list:
    rows = _data("%s/rubik/stat/contracts/open-interest-history?instId=%s&period=%s&limit=%d"
                 % (BASE, inst_id, period, limit))
    # [ts, oi (contracts), oiCcy, oiUsd], newest first
    out = [(int(r[0]) // 1000, float(r[2]), float(r[3])) for r in rows if len(r) >= 4]
    return sorted(out)
