"""DexScreener public API — DEX pairs, liquidity, volume, buys/sells, boosts and new token profiles."""
from __future__ import annotations

import time as _time
from urllib.parse import quote

from .. import http

NAME = "DexScreener"
BASE = "https://api.dexscreener.com"


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def normalize_pair(p: dict, now_ts: float = None) -> dict:
    """Flatten a DexScreener pair into the shape every skill uses."""
    if not isinstance(p, dict):
        return {}
    now_ts = now_ts or _time.time()
    created_ms = p.get("pairCreatedAt")
    created = int(created_ms) // 1000 if created_ms else None
    txns = p.get("txns") or {}
    info = p.get("info") or {}
    base = p.get("baseToken") or {}
    quote_t = p.get("quoteToken") or {}

    def tx(window):
        t = txns.get(window) or {}
        return {"buys": int(t.get("buys") or 0), "sells": int(t.get("sells") or 0)}
    socials = []
    for s in info.get("socials") or []:
        socials.append({"type": s.get("type") or s.get("platform") or "", "url": s.get("url") or s.get("handle") or ""})
    return {
        "chain": p.get("chainId") or "",
        "dex": p.get("dexId") or "",
        "pair_address": p.get("pairAddress") or "",
        "url": p.get("url") or "",
        "labels": p.get("labels") or [],
        "base": {"address": base.get("address") or "", "name": base.get("name") or "", "symbol": base.get("symbol") or ""},
        "quote": {"address": quote_t.get("address") or "", "name": quote_t.get("name") or "",
                  "symbol": quote_t.get("symbol") or ""},
        "price_usd": _f(p.get("priceUsd")),
        "price_native": _f(p.get("priceNative")),
        "liquidity_usd": _f((p.get("liquidity") or {}).get("usd")),
        "fdv": _f(p.get("fdv")),
        "market_cap": _f(p.get("marketCap")),
        "volume": {k: _f((p.get("volume") or {}).get(k)) or 0.0 for k in ("m5", "h1", "h6", "h24")},
        "txns": {k: tx(k) for k in ("m5", "h1", "h6", "h24")},
        "price_change": {k: _f((p.get("priceChange") or {}).get(k)) for k in ("m5", "h1", "h6", "h24")},
        "created_at": created,
        "age_hours": ((now_ts - created) / 3600.0) if created else None,
        "websites": [w.get("url") for w in info.get("websites") or [] if w.get("url")],
        "socials": socials,
        "boosts_active": int((p.get("boosts") or {}).get("active") or 0),
    }


def best_pair(pairs: list, chain: str = None) -> dict:
    cands = [p for p in pairs if not chain or p.get("chain") == chain]
    if not cands:
        return {}
    return max(cands, key=lambda p: p.get("liquidity_usd") or 0)


def token_pairs(chain: str, address: str, now_ts: float = None) -> list:
    rows = http.get_json("%s/token-pairs/v1/%s/%s" % (BASE, chain, quote(address)), ttl=30)
    return [normalize_pair(p, now_ts) for p in rows or []]


def tokens(chain: str, addresses, now_ts: float = None) -> list:
    """Up to 30 token addresses per call."""
    out = []
    addresses = list(addresses)
    for i in range(0, len(addresses), 30):
        chunk = ",".join(addresses[i:i + 30])
        rows = http.get_json("%s/tokens/v1/%s/%s" % (BASE, chain, quote(chunk, safe=",")), ttl=30)
        out.extend(normalize_pair(p, now_ts) for p in rows or [])
    return out


def tokens_any_chain(address: str, now_ts: float = None) -> list:
    obj = http.get_json("%s/latest/dex/tokens/%s" % (BASE, quote(address)), ttl=30)
    return [normalize_pair(p, now_ts) for p in (obj or {}).get("pairs") or []]


def pair(chain: str, pair_address: str, now_ts: float = None) -> dict:
    obj = http.get_json("%s/latest/dex/pairs/%s/%s" % (BASE, chain, quote(pair_address)), ttl=30)
    rows = (obj or {}).get("pairs") or ([obj["pair"]] if (obj or {}).get("pair") else [])
    if not rows:
        raise http.SourceError("dexscreener", "DexScreener has no pair %s on %s" % (pair_address, chain))
    return normalize_pair(rows[0], now_ts)


def search(q: str, now_ts: float = None) -> list:
    obj = http.get_json("%s/latest/dex/search?q=%s" % (BASE, quote(q)), ttl=60)
    return [normalize_pair(p, now_ts) for p in (obj or {}).get("pairs") or []]


def _token_list(path: str) -> list:
    rows = http.get_json(BASE + path, ttl=120)
    out = []
    for r in rows or []:
        if not isinstance(r, dict) or not r.get("tokenAddress"):
            continue
        out.append({
            "chain": r.get("chainId") or "",
            "address": r.get("tokenAddress"),
            "url": r.get("url") or "",
            "description": r.get("description") or "",
            "links": [{"type": l.get("type") or l.get("label") or "link", "url": l.get("url")}
                      for l in r.get("links") or [] if l.get("url")],
            "boost_amount": r.get("amount"),
            "boost_total": r.get("totalAmount"),
        })
    return out


def boosts_top() -> list:
    return _token_list("/token-boosts/top/v1")


def boosts_latest() -> list:
    return _token_list("/token-boosts/latest/v1")


def profiles_latest() -> list:
    return _token_list("/token-profiles/latest/v1")
