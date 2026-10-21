"""X (Twitter) official API v2 — recent search, with a hard daily read budget.

X moved to pay-per-use pricing in 2026: every post a search returns is billed to
the token owner (X's Developer Console shows the current price). So this module
never scrapes x.com, counts every post read in ``trader/x_usage.json`` per UTC
day, refuses a request that could overrun ``news.x.max_reads_per_day``, and
caches each query for ``news.x.poll_minutes`` so a busy dashboard does not
re-buy the same posts.

The bearer token comes from ``shared.secrets`` (env or trader/secrets.env). It
is sent only in the Authorization header and never appears in URLs, cache keys,
files, exceptions or output.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from urllib.parse import urlencode

from .. import config, http, market_clock, secrets, state

NAME = "X"
SEARCH_URL = "https://api.x.com/2/tweets/search/recent"
MAX_QUERY = 512
MIN_RESULTS, MAX_RESULTS = 10, 100  # the API rejects max_results outside 10–100

ST_OK = "ok"
ST_NO_TOKEN = "no token — add X_BEARER_TOKEN (X API is pay-per-use)"
ST_REJECTED = "token rejected (401)"
ST_PLAN = "plan/credits do not allow search (402/403)"
ST_RATE = "rate limited (429)"
ST_DISABLED = "disabled in config (news.x.enabled)"


class XUnavailable(Exception):
    """Raised with a feed-ready status string (never contains the token)."""

    def __init__(self, status: str):
        super().__init__(status)
        self.status = status


def settings(cfg: dict = None) -> dict:
    cfg = cfg or config.load_config()
    x = dict((cfg.get("news") or {}).get("x") or {})
    x.setdefault("enabled", True)
    x.setdefault("max_reads_per_day", 300)
    x.setdefault("poll_minutes", 15)
    x.setdefault("accounts", {})
    return x


def budget_status(reads: int) -> str:
    return "budget exhausted (%d reads today)" % reads


# --- usage accounting ---------------------------------------------------------------------

def _today() -> str:
    return market_clock.now_utc().strftime("%Y-%m-%d")


def usage(cfg: dict = None) -> dict:
    s = settings(cfg)
    doc = state.read_json("x_usage.json", {}) or {}
    if doc.get("date") != _today():
        doc = {"date": _today(), "reads": 0, "requests": 0}
    doc["max_reads_per_day"] = int(s["max_reads_per_day"])
    return doc


def _record(reads: int, cfg: dict = None) -> dict:
    with state.locked("x_usage.json"):  # the news thread and a cycle both read X — every read is counted
        doc = usage(cfg)
        doc["reads"] = int(doc.get("reads", 0)) + int(reads)
        doc["requests"] = int(doc.get("requests", 0)) + 1
        state.write_json("x_usage.json", doc)
    return doc


# --- per-query cache (posts already paid for) -------------------------------------------------

def _cache_file(key: str):
    return config.ensure_home() / "cache" / "x" / (hashlib.sha1(key.encode("utf-8")).hexdigest() + ".json")


def _cache_get(key: str, max_age: float):
    f = _cache_file(key)
    try:
        doc = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if time.time() - float(doc.get("fetched_at", 0)) <= max_age:
        return doc.get("items") or []
    return None


def _cache_set(key: str, items: list) -> None:
    f = _cache_file(key)
    try:
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_name(f.name + ".tmp")
        tmp.write_text(json.dumps({"fetched_at": time.time(), "items": items}), encoding="utf-8")
        os.replace(str(tmp), str(f))
    except OSError:
        pass


# --- parsing ----------------------------------------------------------------------------------

def _plain(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def parse_search(obj) -> list:
    """Recent-search JSON → [{id, author, author_name, text, url, published, metrics}]."""
    obj = obj or {}
    users = {u.get("id"): u for u in ((obj.get("includes") or {}).get("users") or [])}
    out = []
    for t in obj.get("data") or []:
        u = users.get(t.get("author_id")) or {}
        username = u.get("username") or "i"
        pm = t.get("public_metrics") or {}
        published = None
        if t.get("created_at"):
            try:
                published = market_clock.iso(market_clock.parse_iso(t["created_at"]))
            except ValueError:
                published = None
        out.append({
            "id": str(t.get("id") or ""),
            "author": "@" + username,
            "author_name": u.get("name") or username,
            "verified": bool(u.get("verified")),
            "followers": int(((u.get("public_metrics") or {}).get("followers_count")) or 0),
            "text": _plain(t.get("text")),
            "url": "https://x.com/%s/status/%s" % (username, t.get("id")),
            "published": published,
            "lang": t.get("lang"),
            "metrics": {"likes": int(pm.get("like_count") or 0), "reposts": int(pm.get("retweet_count") or 0),
                        "replies": int(pm.get("reply_count") or 0), "quotes": int(pm.get("quote_count") or 0)},
        })
    return out


# --- queries -------------------------------------------------------------------------------------

def cashtag_query(symbol: str, asset: str = "stock", name: str = "") -> str:
    """`($TSLA OR "Tesla") -is:retweet -is:reply lang:en` — crypto uses a hashtag instead of a name."""
    sym = re.sub(r"[^A-Za-z0-9]", "", symbol or "").upper()
    if asset == "crypto":
        alt = " OR #%s" % re.sub(r"[^a-z0-9]", "", (name or "").lower()) if name else ""
    else:
        clean = re.sub(r'["\\]', "", name or "").strip()
        alt = ' OR "%s"' % clean if clean else ""
    return ("($%s%s) -is:retweet -is:reply lang:en" % (sym, alt))[:MAX_QUERY]


def accounts_query(accounts, extra_query: str = "") -> str:
    """`(from:a OR from:b …) -is:retweet` — drops accounts from the end until it fits in 512 chars."""
    names = [re.sub(r"[^A-Za-z0-9_]", "", a.lstrip("@")) for a in accounts or []]
    names = [n for n in names if n]
    tail = " -is:retweet" + ((" " + extra_query.strip()) if extra_query.strip() else "")
    while names:
        q = "(%s)%s" % (" OR ".join("from:%s" % n for n in names), tail)
        if len(q) <= MAX_QUERY:
            return q
        names.pop()
    raise ValueError("no usable X accounts for the breaking-news query")


# --- requests ------------------------------------------------------------------------------------

def search_recent(query: str, max_results: int = 10, sort: str = "relevancy", cfg: dict = None) -> list:
    """One recent-search request (or a cached answer). Raises XUnavailable with a status string."""
    s = settings(cfg)
    if not s.get("enabled", True):
        raise XUnavailable(ST_DISABLED)
    token = secrets.get("X_BEARER_TOKEN")
    if not token:
        raise XUnavailable(ST_NO_TOKEN)
    if len(query) > MAX_QUERY:
        raise ValueError("X query longer than %d characters" % MAX_QUERY)
    sort = "recency" if sort == "recency" else "relevancy"
    want = max(MIN_RESULTS, min(MAX_RESULTS, int(max_results)))
    key = "%s|%s|%s" % (query, want, sort)
    cached = _cache_get(key, float(s["poll_minutes"]) * 60)
    if cached is not None:
        return cached
    use = usage(cfg)
    remaining = int(s["max_reads_per_day"]) - int(use.get("reads", 0))
    if remaining < MIN_RESULTS:
        raise XUnavailable(budget_status(int(use.get("reads", 0))))
    want = min(want, remaining)
    params = {"query": query, "max_results": want, "sort_order": sort,
              "tweet.fields": "created_at,public_metrics,author_id,lang",
              "expansions": "author_id", "user.fields": "username,name,verified,public_metrics"}
    url = SEARCH_URL + "?" + urlencode(params)
    try:
        # ttl=0: the shared HTTP cache stays out of it (we cache parsed posts ourselves, keyed by query only)
        text = http.get_text(url, ttl=0, headers={"Authorization": "Bearer " + token}, retries=0, timeout=10,
                             allow_stale=False)
        obj = json.loads(text)
    except http.SourceError as exc:
        code = getattr(exc, "status", None)
        if code == 401:
            raise XUnavailable(ST_REJECTED)
        if code in (402, 403):
            raise XUnavailable(ST_PLAN)
        if code == 429:
            raise XUnavailable(ST_RATE)
        raise XUnavailable("error: %s" % _scrub(str(exc), token))
    except ValueError:
        raise XUnavailable("error: X returned something that is not JSON")
    posts = parse_search(obj)
    _record(len(posts), cfg)
    _cache_set(key, posts)
    return posts


def breaking(accounts, extra_query: str = "", max_results: int = 20, cfg: dict = None) -> list:
    """Latest posts from curated wire-style accounts (newest first)."""
    return search_recent(accounts_query(accounts, extra_query), max_results=max_results, sort="recency", cfg=cfg)


def _scrub(text: str, token: str) -> str:
    return text.replace(token, "[token]") if token else text
