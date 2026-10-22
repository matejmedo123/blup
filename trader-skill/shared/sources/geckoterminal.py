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


# GeckoTerminal network id → the chain id DexScreener and the rest of the pack use
NETWORKS = {"solana": "solana", "bsc": "bsc", "base": "base", "eth": "ethereum"}
CHAIN_TO_NETWORK = {v: k for k, v in NETWORKS.items()}


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def parse_pools(obj, network: str) -> list:
    """Pools in one flat shape: price, liquidity, age, volume, and buys/sells with the number of distinct wallets."""
    out = []
    for p in (obj or {}).get("data") or []:
        a = p.get("attributes") or {}
        rel = p.get("relationships") or {}
        base_id = (((rel.get("base_token") or {}).get("data") or {}).get("id") or "")
        dex_id = (((rel.get("dex") or {}).get("data") or {}).get("id") or "")
        created = a.get("pool_created_at")
        try:
            from ..market_clock import ts as _ts
            created_ts = _ts(created) if created else None
        except ValueError:
            created_ts = None

        def tx(w):
            t = (a.get("transactions") or {}).get(w) or {}
            return {k: int(t.get(k) or 0) for k in ("buys", "sells", "buyers", "sellers")}
        out.append({
            "chain": NETWORKS.get(network, network), "pool": a.get("address") or "",
            "address": base_id.split("_", 1)[1] if "_" in base_id else base_id, "name": a.get("name") or "",
            "dex": dex_id, "created_at": created_ts, "price_usd": _num(a.get("base_token_price_usd")),
            "liquidity_usd": _num(a.get("reserve_in_usd")), "fdv": _num(a.get("fdv_usd")),
            "market_cap": _num(a.get("market_cap_usd")),
            "change": {k: _num((a.get("price_change_percentage") or {}).get(k)) for k in ("m5", "m15", "h1", "h6", "h24")},
            "volume": {k: _num((a.get("volume_usd") or {}).get(k)) or 0.0 for k in ("m5", "m15", "h1", "h6", "h24")},
            "txns": {k: tx(k) for k in ("m5", "m15", "h1", "h24")},
        })
    return out


def pools(network: str, kind: str = "new_pools", page: int = 1, duration: str = None) -> list:
    """kind: new_pools (the newest), trending_pools (the busiest now; duration 5m / 1h / 6h / 24h)."""
    url = "%s/networks/%s/%s?page=%d&include=base_token,dex" % (BASE, network, kind, int(page))
    if duration:
        url += "&duration=" + duration
    return parse_pools(http.get_json(url, ttl=60), network)
