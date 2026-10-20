"""CoinGecko public API — the crypto universe (top coins by volume, market cap)."""
from __future__ import annotations

from .. import http
from ..symbols import STABLECOINS, WRAPPED

NAME = "CoinGecko"
BASE = "https://api.coingecko.com/api/v3"


def parse_markets(rows) -> list:
    out = []
    for r in rows or []:
        sym = str(r.get("symbol") or "").upper()
        if not sym or sym in STABLECOINS or sym in WRAPPED:
            continue
        out.append({
            "id": r.get("id"), "symbol": sym, "name": r.get("name") or sym,
            "price": r.get("current_price"), "market_cap": r.get("market_cap"),
            "volume_24h": r.get("total_volume"), "change_24h_pct": r.get("price_change_percentage_24h"),
            "rank": r.get("market_cap_rank"),
        })
    return out


def markets(n: int = 50) -> list:
    per_page = min(250, max(n + 20, 50))  # stables/wrapped get dropped, so over-fetch
    rows = http.get_json("%s/coins/markets?vs_currency=usd&order=volume_desc&per_page=%d&page=1"
                         % (BASE, per_page), ttl=900)
    return parse_markets(rows)[:n]
