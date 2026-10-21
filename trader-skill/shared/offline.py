"""Offline mode: answer every HTTP request from ``tests/fixtures/http``.

Fixtures are stored in each API's *raw* response format, so offline runs go
through exactly the same parsing code as live runs. Paginated endpoints
(Binance klines, GeckoTerminal OHLCV, Coinbase candles) are sliced here the
way the real API would slice them, so pagination logic is exercised too.

``TRADER_OFFLINE_FAIL=host1,host2`` makes those hosts fail (simulated outage)
and ``TRADER_OFFLINE_BLOCK=host`` makes them answer HTTP 451, to test fallbacks.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from urllib.parse import parse_qsl, unquote, urlsplit

from . import config
from .http import GeoBlocked, OfflineMiss, SourceError

ROUTES = []


def route(host_pattern: str, path_pattern: str):
    def deco(fn):
        ROUTES.append((re.compile(host_pattern), re.compile(path_pattern), fn))
        return fn
    return deco


def _env_hosts(name: str) -> set:
    return {h.strip().lower() for h in os.environ.get(name, "").split(",") if h.strip()}


def fetch(url: str) -> str:
    parts = urlsplit(url)
    host = parts.netloc.lower()
    if host in _env_hosts("TRADER_OFFLINE_BLOCK"):
        raise GeoBlocked(url, "%s refused this location (simulated HTTP 451)" % host, 451)
    if host in _env_hosts("TRADER_OFFLINE_FAIL"):
        raise SourceError(url, "%s request failed: simulated outage" % host, 503)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    for host_re, path_re, fn in ROUTES:
        if host_re.fullmatch(host):
            m = path_re.fullmatch(parts.path)
            if m:
                return fn(m, query, url)
    raise OfflineMiss(url, "no offline fixture route for %s" % url, 404)


def _file(rel: str):
    return config.fixtures_dir() / "http" / rel


def _read(rel: str, url: str) -> str:
    f = _file(rel)
    if not f.exists():
        raise OfflineMiss(url, "no offline fixture %s" % rel, 404)
    return f.read_text(encoding="utf-8")


def _json(rel: str, url: str):
    return json.loads(_read(rel, url))


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.\-]", "_", name)


def _pinned_ts():
    """Endpoints that just return "the latest N" must not leak data from after the pinned clock."""
    value = os.environ.get("TRADER_NOW")
    if not value:
        return None
    from .market_clock import parse_iso
    return int(parse_iso(value).timestamp())


# --- stocks -----------------------------------------------------------------

@route(r"query[12]\.finance\.yahoo\.com", r"/v8/finance/chart/(?P<sym>[^/]+)")
def _yahoo_chart(m, q, url):
    return _read("yahoo/chart/%s.json" % _safe(unquote(m.group("sym")).upper()), url)


@route(r"query[12]\.finance\.yahoo\.com", r"/v8/finance/spark")
def _yahoo_spark(m, q, url):
    data = _json("yahoo/spark.json", url)
    wanted = [s.strip().upper() for s in q.get("symbols", "").split(",") if s.strip()]
    return json.dumps({s: data[s] for s in wanted if s in data})


@route(r"query[12]\.finance\.yahoo\.com", r"/v1/finance/screener/predefined/saved")
def _yahoo_screener(m, q, url):
    return _read("yahoo/screener_%s.json" % _safe(q.get("scrIds", "")), url)


@route(r"feeds\.finance\.yahoo\.com", r"/rss/2\.0/headline")
def _yahoo_rss(m, q, url):
    return _read("rss/yahoo_%s.xml" % _safe(q.get("s", "").upper()), url)


@route(r"news\.google\.com", r"/rss/search")
def _google_rss(m, q, url):
    term = (q.get("q", "").split() or [""])[0]
    return _read("rss/google_%s.xml" % _safe(term.upper()), url)


@route(r"stooq\.com", r"/q/d/l/")
def _stooq(m, q, url):
    return _read("stooq/%s_%s.csv" % (_safe(q.get("s", "").lower()), _safe(q.get("i", "d"))), url)


@route(r"www\.sec\.gov", r"/files/company_tickers_exchange\.json")
def _sec_tickers(m, q, url):
    return _read("sec/company_tickers_exchange.json", url)


@route(r"www\.sec\.gov", r"/cgi-bin/browse-edgar")
def _sec_edgar(m, q, url):
    if q.get("action") == "getcurrent":
        return _read("sec/current_8k.atom", url)
    cik = q.get("CIK", "").lstrip("0").zfill(10)
    return _read("sec/8k_%s.atom" % _safe(cik), url)


@route(r"www\.nasdaqtrader\.com", r"/dynamic/SymDir/(?P<name>[a-z]+\.txt)")
def _nasdaq(m, q, url):
    return _read("nasdaq/%s" % m.group("name"), url)


# --- crypto (CEX) -------------------------------------------------------------

_KLINE_SECONDS = {"15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}


def _resample_klines(rows: list, seconds: int) -> list:
    """5-minute fixture rows → longer bars in Binance's raw format (only complete buckets)."""
    out, cur, n_in = [], None, seconds // 300
    for r in rows:
        start = r[0] // 1000 // seconds * seconds * 1000
        if cur is None or cur[0] != start:
            if cur is not None and cur[-1] == n_in:
                out.append(cur[:-1])
            cur = [start, r[1], r[2], r[3], r[4], float(r[5]), start + seconds * 1000 - 1, float(r[7]), int(r[8]),
                   float(r[9]), float(r[10]), "0", 0]
        cur[2] = str(max(float(cur[2]), float(r[2])))
        cur[3] = str(min(float(cur[3]), float(r[3])))
        cur[4] = r[4]
        if cur[-1]:
            cur[5] += float(r[5])
            cur[7] += float(r[7])
            cur[8] += int(r[8])
            cur[9] += float(r[9])
            cur[10] += float(r[10])
        cur[-1] += 1
    if cur is not None and cur[-1] == n_in:
        out.append(cur[:-1])
    return [[r[0], r[1], r[2], r[3], r[4], "%.8f" % r[5], r[6], "%.2f" % r[7], r[8], "%.8f" % r[9], "%.2f" % r[10],
             r[11]] for r in out]


@route(r"(api\.binance\.com|data-api\.binance\.vision)", r"/api/v3/klines")
def _binance_klines(m, q, url):
    sym, interval = _safe(q.get("symbol", "")), _safe(q.get("interval", ""))
    if not _file("binance/klines/%s_%s.json" % (sym, interval)).exists() and interval in _KLINE_SECONDS \
            and _file("binance/klines/%s_5m.json" % sym).exists():
        rows = _resample_klines(_json("binance/klines/%s_5m.json" % sym, url), _KLINE_SECONDS[interval])
    else:
        rows = _json("binance/klines/%s_%s.json" % (sym, interval), url)
    limit = min(int(q.get("limit", 500)), 1000)
    start = int(q["startTime"]) if "startTime" in q else None
    end = int(q["endTime"]) if "endTime" in q else None
    if start is not None:
        rows = [r for r in rows if r[0] >= start]
    if end is not None:
        rows = [r for r in rows if r[0] <= end]
    rows = rows[:limit] if start is not None else rows[-limit:]
    return json.dumps(rows)


@route(r"(api\.binance\.com|data-api\.binance\.vision)", r"/api/v3/ticker/24hr")
def _binance_ticker(m, q, url):
    rows = _json("binance/ticker24hr.json", url)
    if "symbol" in q:
        for r in rows:
            if r["symbol"] == q["symbol"]:
                return json.dumps(r)
        raise OfflineMiss(url, "no ticker fixture for %s" % q["symbol"], 400)
    return json.dumps(rows)


@route(r"(api\.binance\.com|data-api\.binance\.vision)", r"/api/v3/exchangeInfo")
def _binance_exinfo(m, q, url):
    data = _json("binance/exchangeInfo.json", url)
    if "symbol" in q:
        data["symbols"] = [s for s in data["symbols"] if s["symbol"] == q["symbol"]]
        if not data["symbols"]:
            raise OfflineMiss(url, "no exchangeInfo fixture for %s" % q["symbol"], 400)
    return json.dumps(data)


@route(r"fapi\.binance\.com", r"/fapi/v1/premiumIndex")
def _binance_premium(m, q, url):
    rows = _json("binance_futures/premiumIndex.json", url)
    for r in rows:
        if r["symbol"] == q.get("symbol"):
            return json.dumps(r)
    raise OfflineMiss(url, "no premiumIndex fixture", 400)


@route(r"fapi\.binance\.com", r"/futures/data/openInterestHist")
def _binance_oi_hist(m, q, url):
    rows = _json("binance_futures/openInterestHist_%s.json" % _safe(q.get("symbol", "")), url)
    now = _pinned_ts()
    if now is not None:
        rows = [r for r in rows if r["timestamp"] // 1000 <= now]
    return json.dumps(rows[-int(q.get("limit", 30)):])


@route(r"api\.exchange\.coinbase\.com", r"/products/(?P<pid>[A-Z0-9\-]+)/candles")
def _coinbase_candles(m, q, url):
    rows = _json("coinbase/candles_%s_%s.json" % (m.group("pid"), q.get("granularity", "300")), url)

    def ts(value):
        if not value:
            return None
        return int(datetime.strptime(value[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp())
    start, end = ts(q.get("start")), ts(q.get("end"))
    if start is not None:
        rows = [r for r in rows if r[0] >= start]
    if end is not None:
        rows = [r for r in rows if r[0] <= end]
    return json.dumps(rows[:300])


@route(r"api\.exchange\.coinbase\.com", r"/products/(?P<pid>[A-Z0-9\-]+)(?P<rest>/ticker|/stats)?")
def _coinbase_product(m, q, url):
    kind = (m.group("rest") or "/product").strip("/")
    return _read("coinbase/%s_%s.json" % (kind, m.group("pid")), url)


@route(r"api\.kraken\.com", r"/0/public/(?P<kind>OHLC|Ticker)")
def _kraken(m, q, url):
    if m.group("kind") == "OHLC":
        data = _json("kraken/ohlc_%s_%s.json" % (_safe(q.get("pair", "")), _safe(q.get("interval", "1"))), url)
        now = _pinned_ts()
        if now is not None:
            for key, rows in data["result"].items():
                if key != "last":
                    data["result"][key] = [r for r in rows if r[0] + 60 * int(q.get("interval", "1")) <= now]
        return json.dumps(data)
    return _read("kraken/ticker_%s.json" % _safe(q.get("pair", "")), url)


@route(r"www\.okx\.com", r"/api/v5/(?P<path>.+)")
def _okx(m, q, url):
    name = _safe(m.group("path").replace("/", "_") + "_" + q.get("instId", ""))
    return _read("okx/%s.json" % name, url)


@route(r"api\.coingecko\.com", r"/api/v3/coins/markets")
def _coingecko_markets(m, q, url):
    rows = _json("coingecko/markets.json", url)
    per_page = int(q.get("per_page", 100))
    page = int(q.get("page", 1))
    return json.dumps(rows[(page - 1) * per_page: page * per_page])


# --- meme coins (DEX) -----------------------------------------------------------

def _ds_pairs(url):
    return _json("dexscreener/pairs.json", url)


def _same_addr(a: str, b: str) -> bool:
    if a.startswith("0x") or b.startswith("0x"):
        return a.lower() == b.lower()
    return a == b


@route(r"api\.dexscreener\.com", r"/token-boosts/(?P<kind>top|latest)/v1")
def _ds_boosts(m, q, url):
    return _read("dexscreener/token_boosts_%s.json" % m.group("kind"), url)


@route(r"api\.dexscreener\.com", r"/token-profiles/latest/v1")
def _ds_profiles(m, q, url):
    return _read("dexscreener/token_profiles_latest.json", url)


@route(r"api\.dexscreener\.com", r"/tokens/v1/(?P<chain>[a-z]+)/(?P<addrs>[^/]+)")
def _ds_tokens_v1(m, q, url):
    addrs = unquote(m.group("addrs")).split(",")
    return json.dumps([p for p in _ds_pairs(url) if p["chainId"] == m.group("chain")
                       and any(_same_addr(p["baseToken"]["address"], a) for a in addrs)])


@route(r"api\.dexscreener\.com", r"/token-pairs/v1/(?P<chain>[a-z]+)/(?P<addr>[^/]+)")
def _ds_token_pairs(m, q, url):
    a = unquote(m.group("addr"))
    return json.dumps([p for p in _ds_pairs(url) if p["chainId"] == m.group("chain")
                       and _same_addr(p["baseToken"]["address"], a)])


@route(r"api\.dexscreener\.com", r"/latest/dex/pairs/(?P<chain>[a-z]+)/(?P<pairs>[^/]+)")
def _ds_pairs_by_id(m, q, url):
    wanted = unquote(m.group("pairs")).split(",")
    rows = [p for p in _ds_pairs(url) if p["chainId"] == m.group("chain")
            and any(_same_addr(p["pairAddress"], w) for w in wanted)]
    return json.dumps({"schemaVersion": "1.0.0", "pairs": rows, "pair": rows[0] if rows else None})


@route(r"api\.dexscreener\.com", r"/latest/dex/tokens/(?P<addrs>[^/]+)")
def _ds_tokens_latest(m, q, url):
    addrs = unquote(m.group("addrs")).split(",")
    rows = [p for p in _ds_pairs(url) if any(_same_addr(p["baseToken"]["address"], a) for a in addrs)]
    return json.dumps({"schemaVersion": "1.0.0", "pairs": rows})


@route(r"api\.dexscreener\.com", r"/latest/dex/search/?")
def _ds_search(m, q, url):
    term = q.get("q", "").strip().lower()
    rows = [p for p in _ds_pairs(url)
            if term and (term == p["baseToken"]["symbol"].lower() or term in p["baseToken"]["name"].lower()
                         or _same_addr(p["baseToken"]["address"], q.get("q", "")))]
    return json.dumps({"schemaVersion": "1.0.0", "pairs": rows})


@route(r"api\.geckoterminal\.com", r"/api/v2/networks/(?P<net>[a-z\-]+)/pools/(?P<pool>[^/]+)/ohlcv/(?P<tf>minute|hour|day)")
def _gt_ohlcv(m, q, url):
    name = "geckoterminal/ohlcv_%s_%s_%s%s.json" % (m.group("net"), _safe(m.group("pool")), m.group("tf"),
                                                    _safe(q.get("aggregate", "1")))
    data = _json(name, url)
    rows = data["data"]["attributes"]["ohlcv_list"]  # newest first, like the real API
    if "before_timestamp" in q:
        before = int(q["before_timestamp"])
        rows = [r for r in rows if r[0] < before]
    data["data"]["attributes"]["ohlcv_list"] = rows[:min(int(q.get("limit", 100)), 1000)]
    return json.dumps(data)


@route(r"api\.geckoterminal\.com", r"/api/v2/networks/(?P<net>[a-z\-]+)/tokens/(?P<addr>[^/]+)/pools")
def _gt_token_pools(m, q, url):
    return _read("geckoterminal/pools_%s_%s.json" % (m.group("net"), _safe(m.group("addr"))), url)


@route(r"api\.rugcheck\.xyz", r"/v1/tokens/(?P<mint>[^/]+)/report(?P<summary>/summary)?")
def _rugcheck(m, q, url):
    suffix = "_summary" if m.group("summary") else ""
    return _read("rugcheck/%s%s.json" % (_safe(m.group("mint")), suffix), url)


@route(r"api\.honeypot\.is", r"/v2/IsHoneypot")
def _honeypot(m, q, url):
    return _read("honeypot/%s_%s.json" % (_safe(q.get("chainID", "")), _safe(q.get("address", "").lower())), url)


@route(r"api\.honeypot\.is", r"/v1/TopHolders")
def _honeypot_top(m, q, url):
    return _read("honeypot/topholders_%s_%s.json" % (_safe(q.get("chainID", "")), _safe(q.get("address", "").lower())), url)


# --- crypto news feeds ------------------------------------------------------------

@route(r"www\.coindesk\.com", r"/arc/outboundfeeds/rss/?")
def _coindesk(m, q, url):
    return _read("rss/coindesk.xml", url)


@route(r"cointelegraph\.com", r"/rss/?")
def _cointelegraph(m, q, url):
    return _read("rss/cointelegraph.xml", url)


@route(r"www\.theblock\.co", r"/rss\.xml")
def _theblock(m, q, url):
    return _read("rss/theblock.xml", url)


# --- social: X recent search and StockTwits streams ---------------------------------------------

def _before_now(stamp: str, now) -> bool:
    if now is None or not stamp:
        return True
    from .market_clock import parse_iso
    return parse_iso(stamp).timestamp() <= now


@route(r"api\.x\.com", r"/2/tweets/search/recent")
def _x_search(m, q, url):
    query = q.get("query", "")
    if "from:" in query:
        name = "x/breaking.json"
    else:
        tag = re.search(r"\$([A-Za-z0-9]+)", query)
        name = "x/cashtag_%s.json" % _safe(tag.group(1).upper()) if tag else ""
    if not name or not _file(name).exists():
        return json.dumps({"meta": {"result_count": 0}})  # what X answers for a query with no matches
    data = _json(name, url)
    now = _pinned_ts()
    posts = [t for t in data.get("data") or [] if _before_now(t.get("created_at"), now)]
    if q.get("sort_order") == "relevancy":
        posts.sort(key=lambda t: -(t["public_metrics"]["like_count"] + 2 * t["public_metrics"]["retweet_count"]))
    else:
        posts.sort(key=lambda t: t.get("created_at") or "", reverse=True)
    posts = posts[:max(10, min(100, int(q.get("max_results", 10))))]
    if not posts:
        return json.dumps({"meta": {"result_count": 0}})
    authors = {t["author_id"] for t in posts}
    users = [u for u in (data.get("includes") or {}).get("users") or [] if u["id"] in authors]
    return json.dumps({"data": posts, "includes": {"users": users},
                       "meta": {"newest_id": posts[0]["id"], "oldest_id": posts[-1]["id"],
                                "result_count": len(posts)}})


@route(r"api\.stocktwits\.com", r"/api/2/streams/symbol/(?P<sym>[^/]+)\.json")
def _stocktwits(m, q, url):
    data = _json("stocktwits/%s.json" % _safe(unquote(m.group("sym")).upper()), url)
    now = _pinned_ts()
    data["messages"] = [x for x in data.get("messages") or [] if _before_now(x.get("created_at"), now)][:30]
    return json.dumps(data)
