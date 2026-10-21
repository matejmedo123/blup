"""What the autopilot watches: its own pick of liquid US stocks and big crypto pairs.

``mode "auto"`` (default): every ``refresh_minutes`` it ranks a built-in list of ~150 liquid US
names by today's gap + intraday move (Yahoo spark, 20 tickers per call), adds Yahoo's "most
actives" and "day gainers" that are big and liquid enough, and takes the top crypto pairs by
24 h volume (minus stablecoins, wrapped and gold-backed tokens, and anything the broker can't
trade). The watchlists and ``universe.always`` are always in; ``universe.exclude`` and the
limits' ``blocked_symbols`` are always out. ``mode "watchlist"`` is v2's fixed watchlist.

A failed refresh keeps the previous pick (with a warning) and tries again later; with nothing
to keep it falls back to the watchlists. Meme coins are never part of it.
"""
from __future__ import annotations

import time

from . import config, data, http, market_clock, state, symbols
from .sources import yahoo

FILE = "autopilot/universe.json"
SPARK_BATCH = 20
RETRY_AFTER_FAIL_MIN = 15
COMMODITY_BACKED = {"PAXG", "XAUT"}

# Liquid US names (mega/large caps people actually trade intraday) plus a few big ETFs.
# The daily ranking decides which of them the autopilot watches; this is only the pool.
LIQUID_US = (
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "BRK-B", "JPM", "V", "MA", "UNH", "XOM",
    "LLY", "JNJ", "WMT", "PG", "HD", "COST", "ORCL", "NFLX", "AMD", "CRM", "ADBE", "PEP", "KO", "MRK", "ABBV",
    "CVX", "BAC", "WFC", "C", "GS", "MS", "SCHW", "BLK", "AXP", "COF", "USB", "PNC", "INTC", "CSCO", "QCOM",
    "TXN", "AMAT", "MU", "LRCX", "KLAC", "ADI", "MRVL", "ARM", "SMCI", "TSM", "ASML", "IBM", "NOW", "INTU",
    "PLTR", "SNOW", "CRWD", "PANW", "ZS", "NET", "DDOG", "MDB", "SHOP", "UBER", "LYFT", "ABNB", "DASH", "COIN",
    "HOOD", "SOFI", "PYPL", "RBLX", "ROKU", "SNAP", "PINS", "SPOT", "DIS", "CMCSA", "T", "VZ", "TMUS", "NKE",
    "SBUX", "MCD", "CMG", "LULU", "TGT", "LOW", "BA", "CAT", "DE", "GE", "HON", "LMT", "RTX", "NOC", "UPS",
    "FDX", "F", "GM", "RIVN", "LCID", "NIO", "BABA", "PDD", "JD", "BIDU", "MSTR", "MARA", "RIOT", "AMGN",
    "GILD", "PFE", "BMY", "CVS", "MRNA", "REGN", "VRTX", "ISRG", "TMO", "ABT", "OXY", "SLB", "COP", "DVN",
    "HAL", "FCX", "NEM", "AA", "CCL", "RCL", "NCLH", "DAL", "UAL", "AAL", "LUV", "MGM", "WYNN", "LVS", "DKNG",
    "EBAY", "ETSY", "ZM", "DOCU", "TWLO", "OKTA", "ENPH", "FSLR", "SPY", "QQQ", "IWM", "DIA", "XLF", "XLE",
    "XLK", "SMH", "GLD", "TLT",
)


# --- helpers ------------------------------------------------------------------------------------

def _ap(cfg: dict) -> dict:
    return (cfg or {}).get("autopilot") or {}


def _ucfg(cfg: dict) -> dict:
    return _ap(cfg).get("universe") or {}


def _assets(cfg: dict) -> list:
    ap = _ap(cfg)
    out = [a for a in (ap.get("assets") or ["stock", "crypto"]) if a in ("stock", "crypto")]
    # no intraday stock setups (the trend profile): no stocks to pick — the ETF trend has its own short list
    if isinstance(ap.get("setups"), dict) and ap["setups"].get("stock") == []:
        out = [a for a in out if a != "stock"]
    return out


def _quote(cfg: dict) -> str:
    return (cfg or {}).get("quote_currency") or "USDT"


def _key(raw, asset: str, quote: str):
    """Normalised data symbol ("btc-usd" → "BTCUSD", "brk.b" → "BRK-B"); None if unparseable or a meme coin."""
    try:
        sym = symbols.parse(str(raw).strip(), asset=asset, quote=quote)
    except (symbols.SymbolError, ValueError):
        return None
    return sym.key if sym.asset == asset else None


def _detect(raw, quote: str):
    try:
        sym = symbols.parse(str(raw).strip(), quote=quote)
    except (symbols.SymbolError, ValueError):
        return None, None
    if sym.asset not in ("stock", "crypto"):
        return None, None
    return sym.asset, sym.key


def watchlist(cfg: dict) -> dict:
    """v2's autopilot watchlist, unchanged: autopilot.watchlist, else the config watchlists."""
    ap = _ap(cfg)
    wl = ap.get("watchlist") or {}
    base = (cfg or {}).get("watchlists") or {}
    out = {}
    for asset, key in (("stock", "stocks"), ("crypto", "crypto")):
        if asset not in (ap.get("assets") or ["stock", "crypto"]):
            continue
        out[asset] = list(wl.get(key) or wl.get(asset) or base.get(key) or [])
    return out  # meme coins are never on it


def _blocked(cfg: dict, quote: str) -> dict:
    """{normalised key or raw upper: reason} for config exclude + limits blocked_symbols."""
    out = {}
    try:
        blocked = config.load_limits().get("blocked_symbols") or []
    except (SystemExit, ValueError):
        blocked = []
    for reason, rows in (("excluded in config (autopilot.universe.exclude)", _ucfg(cfg).get("exclude") or []),
                         ("blocked in limits.json (blocked_symbols)", blocked)):
        for raw in rows:
            out[str(raw).strip().upper()] = reason
            _, key = _detect(raw, quote)
            if key:
                out[key] = reason
    return out


def _fingerprint(cfg: dict, asset: str, broker_name) -> dict:
    u = _ucfg(cfg)
    if asset == "stock":
        s = dict(u.get("stocks") or {})
        sc = (cfg or {}).get("scanner") or {}
        s.update(min_price=sc.get("min_price"), min_avg_volume=sc.get("min_avg_volume"))
    else:
        s = dict(u.get("crypto") or {})
        s.update(quote=_quote(cfg), broker=broker_name)
    s.pop("refresh_minutes", None)
    return s


def _money(x) -> str:
    x = float(x or 0)
    for div, unit in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")):
        if abs(x) >= div:
            return "$%.1f%s" % (x / div, unit)
    return "$%.0f" % x


def _shares(x) -> str:
    x = float(x or 0)
    if x >= 1e9:
        return "%.1fB shares" % (x / 1e9)
    if x >= 1e6:
        return "%.0fM shares" % (x / 1e6)
    return "%.0fK shares" % (x / 1e3)


# --- auto picks ----------------------------------------------------------------------------------

def _stock_picks(cfg: dict, deadline: float):
    """→ (picks [(ticker, reason)], excluded {ticker: reason}, source, candidates, warnings)."""
    s = _ucfg(cfg).get("stocks") or {}
    sc = (cfg or {}).get("scanner") or {}
    base = [str(t).strip().upper().replace(".", "-") for t in (s.get("base") or LIQUID_US) if str(t).strip()]
    base = list(dict.fromkeys(base))
    top_n = int(s.get("top_n") or 40)
    warnings, excluded = [], {}
    ranked, batches, failed = [], 0, 0
    for i in range(0, len(base), SPARK_BATCH):
        if time.monotonic() > deadline:
            warnings.append("stock ranking stopped at the time budget (%d of %d ranked)" % (i, len(base)))
            break
        batches += 1
        try:
            sp = yahoo.spark(base[i:i + SPARK_BATCH])
        except (http.SourceError, ValueError):
            failed += 1
            continue
        for t, d in sp.items():
            closes, prev = d.get("closes") or [], d.get("prev_close")
            if not closes or not prev:
                continue
            gap = closes[0] / prev - 1
            move = closes[-1] / closes[0] - 1
            ranked.append((abs(gap) + abs(move), t, gap, move))
    if failed:
        warnings.append("Yahoo spark failed for %d of %d batches" % (failed, batches))
    ranked.sort(key=lambda r: (-r[0], r[1]))
    picks = [(t, "top mover: gap %+.1f%% · move %+.1f%%" % (gap * 100, move * 100))
             for _, t, gap, move in ranked[:top_n]]
    movers_ok = 0
    if s.get("include_movers", True):
        cap = int(s.get("max_movers") or 10)
        min_price = float(sc.get("min_price") or 0)
        min_avg = float(sc.get("min_avg_volume") or 0)
        min_cap = float(s.get("min_market_cap_usd") or 0)
        have = {t for t, _ in picks}
        added = 0
        for scr_id in ("most_actives", "day_gainers"):
            try:
                rows = yahoo.screener(scr_id, 25)
            except http.SourceError as exc:
                warnings.append("Yahoo %s: %s" % (scr_id.replace("_", " "), exc))
                continue
            movers_ok += 1
            for r in rows:
                t = r["ticker"].replace(".", "-")
                if t in have:
                    continue
                if r.get("quote_type") not in (None, "EQUITY", "ETF"):
                    excluded.setdefault(t, "not a stock or ETF (%s)" % r.get("quote_type"))
                    continue
                if r.get("price") is None or r["price"] < min_price:
                    excluded.setdefault(t, "price %s below min_price $%.2f" % (
                        "$%.2f" % r["price"] if r.get("price") is not None else "unknown", min_price))
                    continue
                if min_cap and (r.get("market_cap") or 0) < min_cap:
                    excluded.setdefault(t, "market cap %s below %s" % (_money(r.get("market_cap")), _money(min_cap)))
                    continue
                if min_avg and (r.get("avg_volume") or 0) < min_avg:
                    excluded.setdefault(t, "average volume %s below min_avg_volume" % _shares(r.get("avg_volume")))
                    continue
                if added >= cap:
                    break
                reason = ("most active today: %s" % _shares(r.get("volume")) if scr_id == "most_actives"
                          else "day gainer: %+.1f%%" % (r.get("change_pct") or 0))
                picks.append((t, reason))
                have.add(t)
                excluded.pop(t, None)
                added += 1
    source = "built-in liquid list ranked by Yahoo spark"
    if s.get("base"):
        source = "your autopilot.universe.stocks.base list ranked by Yahoo spark"
    if s.get("include_movers", True):
        source += " + Yahoo most actives / day gainers"
    if not ranked and not movers_ok:
        raise http.SourceError("yahoo", "no stock ranking source answered (%s)" % "; ".join(warnings or ["no data"]))
    return picks, excluded, source, len(base), warnings


def _crypto_picks(cfg: dict, broker):
    c = _ucfg(cfg).get("crypto") or {}
    top_n = int(c.get("top_n") or 20)
    min_vol = float(c.get("min_volume_usd") or 0)
    quote = _quote(cfg)
    uni = data.crypto_universe(top_n * 2 + 10, quote)
    warnings = list(uni.get("warnings") or [])
    tradable, bname = None, None
    if broker is not None:
        bname = getattr(broker, "name", "broker")
        try:
            tradable = broker.tradable("crypto")
        except Exception as exc:  # an asset-list failure must not stop crypto trading
            warnings.append("%s asset list unavailable: %s" % (bname, exc))
        for note in getattr(broker, "notes", None) or []:
            if note not in warnings:
                warnings.append(note)
    picks, excluded = [], {}
    for row in uni.get("coins") or []:
        sym = row["symbol"]
        if sym.base in COMMODITY_BACKED:
            excluded[sym.key] = "gold-backed token"
            continue
        if sym.base in symbols.STABLECOINS:
            excluded[sym.key] = "stablecoin"
            continue
        if sym.base in symbols.WRAPPED:
            excluded[sym.key] = "wrapped token"
            continue
        if sym.base in symbols.MEME_BASES:
            excluded[sym.key] = "meme coin — never auto-traded"
            continue
        vol = row.get("volume_24h")
        if min_vol and vol is not None and float(vol) < min_vol:
            excluded[sym.key] = "24h volume %s below %s" % (_money(vol), _money(min_vol))
            continue
        if tradable is not None and sym.base not in tradable:
            excluded[sym.key] = "not tradable on %s" % bname
            continue
        if len(picks) >= top_n:
            break
        picks.append((sym.key, "top %d by 24h volume (%s)" % (top_n, _money(vol)) if vol is not None
                      else "top %d by 24h volume" % top_n))
    source = "%s top by 24h volume" % uni.get("source", "?")
    if tradable is not None:
        source += " · tradable on %s" % bname
    return picks, excluded, source, len(uni.get("coins") or []), warnings


# --- the universe --------------------------------------------------------------------------------

def _stale(sec: dict, minutes: float, now_ts: float, fp: dict) -> bool:
    if not sec or sec.get("fingerprint") != fp:
        return True
    done = market_clock.ts(sec["refreshed_at"]) if sec.get("refreshed_at") else 0
    if now_ts - done >= minutes * 60 or now_ts < done:  # a replay that went back in time refreshes too
        tried = market_clock.ts(sec["attempted_at"]) if sec.get("attempted_at") else 0
        if sec.get("failed") and 0 <= now_ts - tried < min(minutes, RETRY_AFTER_FAIL_MIN) * 60:
            return False
        return True
    return False


def _compose(cfg: dict, asset: str, picks: list, quote: str, blocked: dict, excluded: dict) -> tuple:
    fixed = []
    for raw in watchlist(cfg).get(asset) or []:
        k = _key(raw, asset, quote)
        if k:
            fixed.append((k, "watchlist"))
        else:
            excluded[str(raw)] = "not a valid %s symbol" % asset
    for raw in _ucfg(cfg).get("always") or []:
        a, k = _detect(raw, quote)
        if a == asset and k:
            fixed.append((k, "always (autopilot.universe.always)"))
    symbols_, reasons = [], {}
    for k, reason in fixed + list(picks):
        if k in reasons:
            continue
        why = blocked.get(k)
        if not why and asset == "crypto" and k.endswith(quote) and k[: -len(quote)] in symbols.MEME_BASES:
            why = "meme coin — never auto-traded (watch it with /trader-scanner)"
        if why:
            excluded[k] = why
            continue
        symbols_.append(k)
        reasons[k] = reason
    return symbols_, reasons


def build(cfg: dict = None, now=None, broker=None, force: bool = True) -> dict:
    """Refresh (all sections when ``force``, else only stale ones) and write autopilot/universe.json."""
    cfg = cfg or config.load_config()
    now_dt = market_clock.parse_iso(now) if now else market_clock.now_utc()
    now_ts = now_dt.timestamp()
    now_iso = market_clock.iso(now_dt)
    u = _ucfg(cfg)
    mode = u.get("mode") or "auto"
    quote = _quote(cfg)
    prev = state.read_json(FILE, {}) or {}
    if prev.get("mode") != mode:
        prev = {}
    blocked = _blocked(cfg, quote)
    bname = getattr(broker, "name", None)
    doc = {"generated_at": now_iso, "mode": mode, "excluded": {}, "warnings": []}
    for asset in _assets(cfg):
        old = prev.get(asset) or {}
        if mode == "watchlist":
            sec = {"picks": [], "refreshed_at": now_iso, "source": "watchlist (autopilot.universe.mode)",
                   "candidates": 0, "warnings": []}
        else:
            settings = u.get("stocks" if asset == "stock" else "crypto") or {}
            minutes = float(settings.get("refresh_minutes") or (60 if asset == "stock" else 240))
            fp = _fingerprint(cfg, asset, bname)
            sec = dict(old)
            if force or _stale(old, minutes, now_ts, fp):
                try:
                    if asset == "stock":
                        budget = float(_ap(cfg).get("scan_time_budget_sec") or 40)
                        picks, excl, source, n, warns = _stock_picks(cfg, time.monotonic() + max(budget, 20.0))
                    else:
                        picks, excl, source, n, warns = _crypto_picks(cfg, broker)
                    sec = {"picks": [list(p) for p in picks], "refreshed_at": now_iso, "attempted_at": now_iso,
                           "failed": False, "source": source, "candidates": n, "fingerprint": fp,
                           "pick_excluded": excl, "warnings": warns}
                except (http.SourceError, data.DataUnavailable, ValueError) as exc:
                    sec = dict(old, attempted_at=now_iso, failed=True, fingerprint=fp)
                    if old.get("picks"):
                        sec["warnings"] = ["%s universe refresh failed (%s) — kept the list from %s"
                                           % (asset, exc, old.get("refreshed_at"))]
                    else:
                        sec.update(picks=[], source="watchlists (no ranking source answered)", candidates=0,
                                   pick_excluded={}, refreshed_at=None,
                                   warnings=["%s universe refresh failed (%s) — fell back to the watchlists"
                                             % (asset, exc)])
        excluded = dict(sec.get("pick_excluded") or {})
        syms, reasons = _compose(cfg, asset, [tuple(p) for p in sec.get("picks") or []], quote, blocked, excluded)
        sec.update(symbols=syms, reasons=reasons)
        doc[asset] = sec
        doc["excluded"].update(excluded)
        doc["warnings"] += sec.get("warnings") or []
    state.write_json(FILE, doc)
    return doc


def current(cfg: dict = None, now=None, broker=None, force: bool = False) -> dict:
    """{"stock": [...], "crypto": [...]} for the enabled asset classes — refreshes stale sections only."""
    cfg = cfg or config.load_config()
    doc = build(cfg, now=now, broker=broker, force=force)
    return {a: list((doc.get(a) or {}).get("symbols") or []) for a in _assets(cfg)}
