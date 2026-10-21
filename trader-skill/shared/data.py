"""One API for candles, quotes and universes across stocks, crypto and meme coins.

    get_candles("TSLA")                     Yahoo → Stooq
    get_candles("BTCUSDT")                  Binance → Binance mirror → Coinbase → Kraken
    get_candles("SOL:<mint>")               DexScreener (find the pool) → GeckoTerminal OHLCV

Only *closed* candles are returned (close time ≤ ``end``, default now), so a
rule like "5-min close above X" can never fire on a half-finished bar.
When the clock is pinned (``TRADER_NOW``) or we are offline, quotes are
derived from those candles too, so every tool sees the same "now".
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass, field

from . import config, http, market_clock, symbols
from .indicators import Candle
from .sources import (binance, coinbase, coingecko, dexscreener, geckoterminal, kraken, nasdaq, okx, sec,
                      stooq, yahoo)


class DataUnavailable(Exception):
    pass


DEFAULT_DAYS = {"stock": 60, "crypto": 60, "meme": 30}
DEFAULT_LOTS = {
    "BTC": (0.00001, 0.01), "ETH": (0.0001, 0.01), "SOL": (0.001, 0.01), "XRP": (0.1, 0.0001),
    "DOGE": (1.0, 0.00001), "BNB": (0.001, 0.01), "ADA": (0.1, 0.0001), "AVAX": (0.01, 0.01),
}


@dataclass
class Series:
    symbol: symbols.Symbol
    interval: str
    candles: list
    source: str
    warnings: list = field(default_factory=list)
    meta: dict = field(default_factory=dict)

    def __len__(self):
        return len(self.candles)

    @property
    def last(self):
        return self.candles[-1] if self.candles else None

    @property
    def step(self) -> int:
        return market_clock.interval_seconds(self.interval)

    def to_dict(self, include_candles: bool = False) -> dict:
        d = {"symbol": self.symbol.to_dict(), "interval": self.interval, "source": self.source,
             "bars": len(self.candles), "warnings": list(self.warnings),
             "first": market_clock.iso(self.candles[0].t) if self.candles else None,
             "last": market_clock.iso(self.candles[-1].t) if self.candles else None}
        if include_candles:
            d["candles"] = [list(c) for c in self.candles]
        return d


def pinned_clock() -> bool:
    return bool(os.environ.get("TRADER_NOW")) or config.is_offline()


def as_symbol(symbol, asset: str = None, quote: str = None) -> symbols.Symbol:
    if isinstance(symbol, symbols.Symbol):
        return symbol
    if quote is None:
        try:
            quote = config.load_config().get("quote_currency") or "USDT"
        except (SystemExit, ValueError):
            quote = "USDT"
    return symbols.parse(symbol, asset=asset, quote=quote)


def _asof(end_ts: int) -> int:
    """The latest moment the data just read can speak for: a body downloaded (or cached) before ``end_ts`` holds
    the bars that had closed by then — the next one was still forming in it. Pinned clocks (replays, tests) and
    offline fixtures keep ``end_ts``."""
    fetched = http.oldest_fetch()
    return min(end_ts, int(fetched)) if fetched and not pinned_clock() else end_ts


def _clean(candles: list, step: int, end_ts: int, start_ts: int = None) -> list:
    seen = {}
    for c in candles:
        if c.t + step > end_ts:
            continue
        if start_ts is not None and c.t < start_ts:
            continue
        if not all(math.isfinite(x) for x in (c.o, c.h, c.l, c.c)) or c.c <= 0:
            continue
        seen[c.t] = c
    return [seen[t] for t in sorted(seen)]


def _regular_hours(candles: list) -> list:
    bounds = {}
    out = []
    for c in candles:
        d = market_clock.et_date(c.t)
        if d not in bounds:
            b = market_clock.session_bounds(d)
            bounds[d] = (int(b[0].timestamp()), int(b[1].timestamp())) if b else None
        b = bounds[d]
        if b and b[0] <= c.t < b[1]:
            out.append(c)
    return out


def _fail(sym, errors) -> DataUnavailable:
    detail = "; ".join("%s: %s" % (name, err) for name, err in errors)
    return DataUnavailable("no %s data for %s (%s)" % (sym.asset, sym.display, detail or "no source"))


# --- candles -----------------------------------------------------------------------

def get_candles(symbol, interval: str = "5m", days: float = None, asset: str = None, end=None,
                quote: str = None) -> Series:
    """``days`` = trading sessions for stocks, calendar days for crypto and meme coins."""
    sym = as_symbol(symbol, asset, quote)
    end_dt = market_clock.parse_iso(end) if end else market_clock.now_utc()
    end_ts = int(end_dt.timestamp())
    days = days or DEFAULT_DAYS[sym.asset]
    if sym.asset == "stock":
        return _stock_candles(sym, interval, int(days), end_ts)
    if sym.asset == "crypto":
        return _crypto_candles(sym, interval, float(days), end_ts)
    return _meme_candles(sym, interval, float(days), end_ts)


def _stock_candles(sym, interval, sessions, end_ts) -> Series:
    step = market_clock.interval_seconds(interval)
    calendar_days = min(60, int(sessions * 1.45) + 4) if interval in ("1m", "5m", "15m", "30m") else sessions * 2
    errors, warnings = [], []
    for name, mod in (("Yahoo Finance", yahoo), ("Stooq", stooq)):
        try:
            http.track()
            raw, info = mod.get_candles(sym, interval, calendar_days)
        except http.SourceError as exc:
            errors.append((name, exc))
            continue
        candles = _clean(raw, step, _asof(end_ts))
        if interval != "1d":
            candles = _regular_hours(candles)
        dates = []
        for c in candles:
            d = market_clock.et_date(c.t)
            if not dates or dates[-1] != d:
                dates.append(d)
        keep = set(dates[-sessions:])
        candles = [c for c in candles if market_clock.et_date(c.t) in keep]
        if not candles:
            errors.append((name, "no candles before %s" % market_clock.iso(end_ts)))
            continue
        if len(keep) < sessions and interval != "1d":
            warnings.append("only %d of %d sessions of %s bars available from %s (Yahoo keeps ~60 calendar days)"
                            % (len(keep), sessions, interval, name))
        if errors:
            warnings.append("primary source failed (%s) — using %s" % (errors[0][1], name))
        return Series(sym, interval, candles, name, warnings + list(http.warnings), dict(info or {}))
    raise _fail(sym, errors)


def _crypto_candles(sym, interval, days, end_ts) -> Series:
    step = market_clock.interval_seconds(interval)
    start_ts = end_ts - int(days * 86400)
    errors, warnings = [], []
    if sym.quote == "USD":
        warnings.append("USD price taken from the %s pair where needed (USDT ≈ USD)" % sym.binance)
    attempts = [
        ("Binance", lambda: binance.klines(sym.binance, interval, days, end_ts)),
        ("Coinbase", lambda: coinbase.candles(sym.coinbase, interval, days, end_ts)),
        ("Kraken", lambda: kraken.candles(sym.kraken, interval)),
    ]
    if days > coinbase.MAX_DAYS:  # Coinbase stops at 30 days; Kraken's 720 bars cover a 200-day average
        attempts[1], attempts[2] = attempts[2], attempts[1]
    for name, fn in attempts:
        try:
            http.track()
            raw = fn()
        except (http.SourceError, KeyError) as exc:
            errors.append((name, exc))
            continue
        candles = _clean(raw, step, _asof(end_ts), start_ts)
        if not candles:
            errors.append((name, "no candles in window"))
            continue
        if name == "Coinbase" and days > coinbase.MAX_DAYS:
            warnings.append("Coinbase fallback limited to %d days of history" % coinbase.MAX_DAYS)
        if name == "Kraken":
            warnings.append("Kraken fallback only has the latest 720 bars (~%.1f days)" % (720 * step / 86400.0))
        if errors:
            warnings.append("%s unavailable (%s) — using %s" % (errors[0][0], errors[0][1], name))
        return Series(sym, interval, candles, name, warnings + list(http.warnings), {})
    raise _fail(sym, errors)


def _meme_candles(sym, interval, days, end_ts) -> Series:
    step = market_clock.interval_seconds(interval)
    sym, pair, pairs, warnings = resolve_meme(sym)
    errors = []
    pools = [pair] + [p for p in sorted(pairs, key=lambda p: -(p.get("liquidity_usd") or 0))
                      if p.get("pair_address") != pair.get("pair_address")][:1]
    for p in pools:
        try:
            http.track()
            raw = geckoterminal.ohlcv(symbols.GT_NETWORK.get(p["chain"], p["chain"]), p["pair_address"],
                                      interval, days, end_ts)
        except http.SourceError as exc:
            errors.append(("GeckoTerminal", exc))
            continue
        candles = _clean(raw, step, _asof(end_ts))
        if not candles:
            errors.append(("GeckoTerminal", "no candles before %s" % market_clock.iso(end_ts)))
            continue
        if p is not pair:
            warnings.append("main pool had no candles — using pool %s" % p["pair_address"])
        span_days = (candles[-1].t - candles[0].t + step) / 86400.0
        meta = {"pair": p, "pool": p["pair_address"], "network": symbols.GT_NETWORK.get(p["chain"], p["chain"]),
                "history_days": round(span_days, 2)}
        return Series(sym, interval, candles, "GeckoTerminal", warnings + list(http.warnings), meta)
    raise _fail(sym, errors)


# --- meme coin resolution -------------------------------------------------------------

def _now_ts() -> float:
    return market_clock.now_utc().timestamp()


def resolve_meme(symbol):
    """→ (Symbol with chain/address/name, best pair, all pairs, warnings). Raises DataUnavailable."""
    sym = as_symbol(symbol, "meme")
    warnings = []
    now = _now_ts()
    try:
        if sym.address and sym.chain:
            try:
                pairs = dexscreener.token_pairs(sym.chain, sym.address, now)
            except http.SourceError:
                pairs = dexscreener.tokens(sym.chain, [sym.address], now)
        elif sym.address:
            pairs = dexscreener.tokens_any_chain(sym.address, now)
        else:
            cfg_chains = config.load_config().get("meme_chains") or []
            pairs = [p for p in dexscreener.search(sym.base, now) if not cfg_chains or p["chain"] in cfg_chains]
            warnings.append("resolved %r by name search — verify the contract address before doing anything"
                            % sym.base)
    except http.SourceError as exc:
        raise DataUnavailable("DexScreener lookup failed for %s: %s" % (sym.display, exc))
    if sym.address:
        pairs = [p for p in pairs if dexscreener_same(p["base"]["address"], sym.address)] or pairs
    best = dexscreener.best_pair(pairs, sym.chain or None)
    if not best:
        raise DataUnavailable("no DEX pairs found for %s" % sym.display)
    resolved = symbols.meme_symbol(best["chain"], best["base"]["address"], best["base"]["symbol"])
    resolved.raw = sym.raw
    return resolved, best, [p for p in pairs if p["chain"] == best["chain"]], warnings


def dexscreener_same(a: str, b: str) -> bool:
    if (a or "").startswith("0x") or (b or "").startswith("0x"):
        return (a or "").lower() == (b or "").lower()
    return a == b


def get_pair(symbol) -> dict:
    sym, pair, pairs, warnings = resolve_meme(symbol)
    out = dict(pair)
    out["symbol"] = sym.to_dict()
    out["warnings"] = warnings
    out["pool_count"] = len(pairs)
    return out


# --- quotes ----------------------------------------------------------------------------

def _quote_from_candles(sym, interval: str = "5m") -> dict:
    if sym.asset == "stock":
        s = get_candles(sym, interval, days=2)
        last = s.candles[-1]
        today = market_clock.et_date(last.t)
        prev = [c for c in s.candles if market_clock.et_date(c.t) < today]
        prev_close = prev[-1].c if prev else None
    else:
        s = get_candles(sym, interval, days=1.2)
        last = s.candles[-1]
        ago = [c for c in s.candles if c.t <= last.t - 86400 + s.step]
        prev_close = ago[-1].c if ago else s.candles[0].o
    change = ((last.c / prev_close - 1) * 100) if prev_close else None
    return {"price": last.c, "prev_close": prev_close, "change_pct": change, "time": last.t + s.step,
            "source": s.source + " (last closed bar)", "volume": None}


def get_quote(symbol, asset: str = None) -> dict:
    sym = as_symbol(symbol, asset)
    base = {"symbol": sym.display, "key": sym.key, "asset": sym.asset,
            "note": "quotes from free public sources may be delayed"}
    if sym.asset == "meme":
        p = get_pair(sym)
        base.update(price=p.get("price_usd"), prev_close=None, change_pct=p["price_change"].get("h24"),
                    volume=p["volume"].get("h24"), liquidity_usd=p.get("liquidity_usd"),
                    time=int(_now_ts()), source="DexScreener", pair=p)
        return base
    if pinned_clock():
        base.update(_quote_from_candles(sym))
        return base
    errors = []
    if sym.asset == "stock":
        attempts = (("Yahoo Finance", lambda: yahoo.get_quote(sym)),)
    else:
        attempts = (("Binance", lambda: binance.ticker_24h(sym.binance)),
                    ("Coinbase", lambda: coinbase.ticker(sym.coinbase)),
                    ("Kraken", lambda: kraken.ticker(sym.kraken)))
    for name, fn in attempts:
        try:
            q = fn()
        except (http.SourceError, KeyError, ValueError) as exc:
            errors.append((name, exc))
            continue
        if q.get("change_pct") is None and q.get("prev_close"):
            q["change_pct"] = (q["price"] / q["prev_close"] - 1) * 100
        base.update(q)
        base["source"] = name
        return base
    try:
        base.update(_quote_from_candles(sym))
        return base
    except DataUnavailable:
        raise _fail(sym, errors)


# --- universes ---------------------------------------------------------------------------

_STOCK_OK = symbols._STOCK


def stock_universe(cfg: dict = None) -> dict:
    cfg = cfg or config.load_config()
    errors = []
    for name, fn in (("SEC EDGAR", lambda: sec.tickers(cfg)), ("Nasdaq Trader", nasdaq.tickers)):
        try:
            rows = fn()
        except http.SourceError as exc:
            errors.append((name, exc))
            continue
        seen, out = set(), []
        for r in rows:
            t = r["ticker"].replace(".", "-")
            if t in seen or not _STOCK_OK.match(t.replace("-", ".")):
                continue
            seen.add(t)
            out.append(dict(r, ticker=t))
        return {"source": name, "tickers": out, "warnings": ["%s: %s" % e for e in errors]}
    raise DataUnavailable("no US ticker list (%s)" % "; ".join("%s: %s" % e for e in errors))


def crypto_universe(n: int = 30, quote: str = "USDT") -> dict:
    errors = []
    try:
        rows = coingecko.markets(n)
        syms = []
        for r in rows:
            try:
                syms.append(dict(r, symbol=symbols.parse(r["symbol"] + quote, asset="crypto")))
            except symbols.SymbolError:
                continue
        return {"source": "CoinGecko", "coins": syms, "warnings": []}
    except http.SourceError as exc:
        errors.append(("CoinGecko", exc))
    try:
        rows = [r for r in binance.all_tickers() if r["symbol"].endswith(quote)]
        rows.sort(key=lambda r: -float(r.get("quoteVolume") or 0))
        syms = []
        for r in rows:
            base_ = r["symbol"][: -len(quote)]
            if base_ in symbols.STABLECOINS or base_ in symbols.WRAPPED:
                continue
            syms.append({"symbol": symbols.parse(r["symbol"], asset="crypto"), "name": base_,
                         "volume_24h": float(r.get("quoteVolume") or 0)})
            if len(syms) >= n:
                break
        return {"source": "Binance", "coins": syms, "warnings": ["CoinGecko: %s" % errors[0][1]]}
    except http.SourceError as exc:
        errors.append(("Binance", exc))
    raise DataUnavailable("no crypto universe (%s)" % "; ".join("%s: %s" % e for e in errors))


def meme_universe(chains=None) -> dict:
    """Boosted/trending tokens + fresh token profiles on the configured chains, with their best pair."""
    chains = chains or config.load_config().get("meme_chains") or ["solana"]
    found, warnings = {}, []
    for tag, fn in (("boosted", dexscreener.boosts_top), ("boosted", dexscreener.boosts_latest),
                    ("new_profile", dexscreener.profiles_latest)):
        try:
            rows = fn()
        except http.SourceError as exc:
            warnings.append("DexScreener %s: %s" % (tag, exc))
            continue
        for r in rows:
            if r["chain"] not in chains:
                continue
            key = (r["chain"], r["address"])
            entry = found.setdefault(key, {"chain": r["chain"], "address": r["address"], "tags": [],
                                           "links": r.get("links") or [], "boost": r.get("boost_total")})
            if tag not in entry["tags"]:
                entry["tags"].append(tag)
    now = _now_ts()
    out = []
    by_chain = {}
    for (chain, addr) in found:
        by_chain.setdefault(chain, []).append(addr)
    for chain, addrs in by_chain.items():
        try:
            pairs = dexscreener.tokens(chain, addrs, now)
        except http.SourceError as exc:
            warnings.append("DexScreener pairs on %s: %s" % (chain, exc))
            continue
        for addr in addrs:
            mine = [p for p in pairs if dexscreener_same(p["base"]["address"], addr)]
            best = dexscreener.best_pair(mine)
            if not best:
                continue
            entry = found[(chain, addr)]
            out.append({"symbol": symbols.meme_symbol(chain, addr, best["base"]["symbol"]), "pair": best,
                        "tags": entry["tags"], "links": entry["links"]})
    if not out and warnings:
        raise DataUnavailable("no meme-coin universe (%s)" % "; ".join(warnings))
    return {"source": "DexScreener", "tokens": out, "warnings": warnings}


# --- derivatives & lot sizes --------------------------------------------------------------

def derivatives(symbol) -> dict:
    """Funding rate and open-interest trend for a crypto symbol (Binance futures → OKX)."""
    sym = as_symbol(symbol, "crypto")
    now = int(market_clock.now_utc().timestamp())
    out = {"funding_rate": None, "funding_source": None, "oi_change_pct_1h": None, "oi_change_pct_4h": None,
           "oi_series": [], "oi_source": None, "warnings": []}
    for name, fn in (("Binance futures", lambda: binance.funding(sym.binance)),
                     ("OKX", lambda: okx.funding(sym.okx_swap))):
        try:
            f = fn()
            out["funding_rate"], out["funding_source"] = f["funding_rate"], name
            break
        except (http.SourceError, KeyError, ValueError) as exc:
            out["warnings"].append("%s funding: %s" % (name, exc))
    for name, fn in (("Binance futures", lambda: binance.open_interest_hist(sym.binance, "5m", 60)),
                     ("OKX", lambda: okx.open_interest_hist(sym.okx_swap, "5m", 60))):
        try:
            series = [r for r in fn() if r[0] <= now]
        except (http.SourceError, KeyError, ValueError) as exc:
            out["warnings"].append("%s open interest: %s" % (name, exc))
            continue
        if len(series) >= 2:
            last = series[-1][1]
            for bars, key in ((12, "oi_change_pct_1h"), (48, "oi_change_pct_4h")):
                if len(series) > bars and series[-1 - bars][1]:
                    out[key] = (last / series[-1 - bars][1] - 1) * 100
            out["oi_series"], out["oi_source"] = series, name
            break
    return out


def lot_info(symbol) -> dict:
    sym = as_symbol(symbol)
    if sym.asset == "stock":
        frac = bool(config.load_config().get("fractional_shares"))
        return {"step": 0.0001 if frac else 1.0, "tick": 0.01, "min_qty": 0.0001 if frac else 1.0,
                "min_notional": 1.0 if frac else None, "source": "US equities (penny tick)"}
    if sym.asset == "meme":
        return {"step": None, "tick": None, "min_qty": None, "min_notional": None, "source": "DEX (USD amount)"}
    for fn in (lambda: binance.exchange_info(sym.binance), lambda: coinbase.product(sym.coinbase)):
        try:
            info = fn()
            if info.get("step"):
                return info
        except (http.SourceError, KeyError, ValueError):
            continue
    step, tick = DEFAULT_LOTS.get(sym.base, (0.000001, 0.0001))
    return {"step": step, "tick": tick, "min_qty": step, "min_notional": 5.0,
            "source": "built-in default (exchange info unavailable)"}
