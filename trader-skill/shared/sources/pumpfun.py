"""pump.fun public frontend API — new coins, coins close to graduating, one coin's state (read-only)."""
from __future__ import annotations

from urllib.parse import quote

from .. import http

NAME = "pump.fun"
BASE = "https://frontend-api-v3.pump.fun"
GRADUATION_SOL = 85.0  # a bonding curve moves to the DEX (PumpSwap) once about this much SOL is in it


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def normalize(c: dict) -> dict:
    """One coin in the shape the sniper uses; times in seconds, SOL in SOL."""
    if not isinstance(c, dict) or not c.get("mint"):
        return {}
    real_sol = (_f(c.get("real_sol_reserves")) or 0.0) / 1e9
    created = _f(c.get("created_timestamp"))
    return {
        "chain": "solana", "address": c["mint"], "name": c.get("name") or "", "symbol": c.get("symbol") or "",
        "created_at": int(created / 1000) if created else None, "creator": c.get("creator") or "",
        "market_cap_usd": _f(c.get("usd_market_cap") or c.get("market_cap_usd")),
        "ath_market_cap_usd": _f(c.get("ath_market_cap")),
        "complete": bool(c.get("complete")),  # graduated: trading on the DEX now, its LP burned by the program
        "curve_sol": round(real_sol, 3), "curve_progress": round(min(1.0, real_sol / GRADUATION_SOL), 4),
        "replies": int(c.get("reply_count") or 0),
        "koth_at": int((_f(c.get("king_of_the_hill_timestamp")) or 0) / 1000) or None,
        "last_trade_at": int((_f(c.get("last_trade_timestamp")) or 0) / 1000) or None,
        "banned": bool(c.get("is_banned")), "nsfw": bool(c.get("nsfw")),
        "transfer_fee_bps": int(c.get("transfer_fee_bps") or 0),
        "pool_address": c.get("pool_address") or c.get("pump_swap_pool") or c.get("raydium_pool") or "",
        "socials": [{"type": k, "url": c[k]} for k in ("twitter", "telegram", "website") if c.get(k)],
        "url": "https://pump.fun/coin/%s" % c["mint"],
    }


def _list(params: str, ttl: float) -> list:
    rows = http.get_json("%s/coins?%s&includeNsfw=false" % (BASE, params), ttl=ttl)
    return [n for n in (normalize(r) for r in rows or []) if n]


def latest(limit: int = 50) -> list:
    """The newest coins, newest first."""
    return _list("offset=0&limit=%d&sort=created_timestamp&order=DESC" % int(limit), ttl=20)


def near_graduation(limit: int = 50) -> list:
    """Coins still on their bonding curve, biggest first — the ones about to move to the DEX."""
    return _list("offset=0&limit=%d&sort=market_cap&order=DESC&complete=false" % int(limit), ttl=30)


def coin(mint: str) -> dict:
    return normalize(http.get_json("%s/coins/%s" % (BASE, quote(mint)), ttl=20))
