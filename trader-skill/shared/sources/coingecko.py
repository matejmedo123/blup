"""CoinGecko public API — the crypto universe (top coins by volume, market cap)."""
from __future__ import annotations

from .. import http
from ..symbols import STABLECOINS, WRAPPED

NAME = "CoinGecko"
BASE = "https://api.coingecko.com/api/v3"


def _dollar_peg(r: dict, sym: str) -> bool:
    """A dollar stablecoin the list does not know yet: priced at $1, barely moving, named like one."""
    name = str(r.get("name") or "").lower()
    try:
        return (0.97 <= float(r.get("current_price")) <= 1.03 and abs(float(r.get("price_change_percentage_24h") or 0)) < 1.0
                and ("usd" in sym.lower() or "usd" in name or "dollar" in name))
    except (TypeError, ValueError):
        return False


def parse_markets(rows) -> list:
    out = []
    for r in rows or []:
        sym = str(r.get("symbol") or "").upper()
        if not sym or sym in STABLECOINS or sym in WRAPPED or _dollar_peg(r, sym):
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
