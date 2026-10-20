"""Polite HTTP GET for free public APIs.

* per-host minimum spacing between requests (SEC: max 10 req/s, CoinGecko and
  GeckoTerminal ~30/min, ...)
* exponential back-off on 429/5xx, honouring ``Retry-After``
* a geo-block (HTTP 451, e.g. api.binance.com from the US) trips a per-process
  circuit breaker so the data layer falls through to the next source at once
* responses are cached on disk; if the network fails we serve a stale copy
  (< 24 h) and say so
* ``TRADER_OFFLINE=1`` routes every URL to ``tests/fixtures/http`` instead
"""
from __future__ import annotations

import gzip
import json
import random
import socket
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from . import config
from .cache import FileCache

USER_AGENT = "Mozilla/5.0 (compatible; trader-skill/1.0; educational research tool)"
MAX_BYTES = 12 * 1024 * 1024
STALE_MAX_AGE = 24 * 3600

# seconds between requests to the same host
MIN_INTERVAL = {
    "www.sec.gov": 0.12,
    "efts.sec.gov": 0.12,
    "api.coingecko.com": 2.5,
    "api.geckoterminal.com": 2.1,
    "api.dexscreener.com": 0.25,
    "query1.finance.yahoo.com": 0.3,
    "query2.finance.yahoo.com": 0.3,
    "feeds.finance.yahoo.com": 0.5,
    "news.google.com": 1.0,
    "api.rugcheck.xyz": 0.6,
    "api.honeypot.is": 0.6,
    "api.exchange.coinbase.com": 0.15,
    "api.kraken.com": 1.0,
    "stooq.com": 1.0,
}
DEFAULT_INTERVAL = 0.2


class SourceError(Exception):
    def __init__(self, url: str, message: str, status: int = None):
        super().__init__(message)
        self.url = url
        self.status = status


class GeoBlocked(SourceError):
    pass


class OfflineMiss(SourceError):
    pass


_last_call = {}
_blocked_hosts = {}
_cache = None
stats = {"requests": 0, "cache_hits": 0, "retries": 0, "stale": 0}
warnings = []


def reset() -> None:
    """Forget per-process state (used by tests)."""
    global _cache
    _last_call.clear()
    _blocked_hosts.clear()
    warnings.clear()
    for k in stats:
        stats[k] = 0
    _cache = None


def host_of(url: str) -> str:
    return urlsplit(url).netloc.lower()


def _get_cache() -> FileCache:
    global _cache
    if _cache is None:
        _cache = FileCache()
    return _cache


def _throttle(host: str) -> None:
    gap = MIN_INTERVAL.get(host, DEFAULT_INTERVAL)
    last = _last_call.get(host)
    if last is not None:
        wait = gap - (time.monotonic() - last)
        if wait > 0:
            time.sleep(wait)
    _last_call[host] = time.monotonic()


def _decode(raw: bytes, headers) -> str:
    if (headers.get("Content-Encoding") or "").lower() == "gzip":
        raw = gzip.decompress(raw)
    charset = "utf-8"
    ctype = headers.get("Content-Type") or ""
    if "charset=" in ctype:
        charset = ctype.split("charset=", 1)[1].split(";")[0].strip() or "utf-8"
    try:
        return raw.decode(charset, errors="replace")
    except LookupError:
        return raw.decode("utf-8", errors="replace")


def _retry_after(err) -> float:
    value = err.headers.get("Retry-After") if getattr(err, "headers", None) else None
    try:
        return min(float(value), 60.0)
    except (TypeError, ValueError):
        return 0.0


def get_text(url: str, ttl: float = 60, headers: dict = None, retries: int = 3,
             timeout: float = 20, allow_stale: bool = True) -> str:
    if config.is_offline():
        from . import offline
        return offline.fetch(url)

    host = host_of(url)
    if host in _blocked_hosts:
        raise GeoBlocked(url, "%s is blocked from this location (%s)" % (host, _blocked_hosts[host]), 451)

    cache = _get_cache()
    hit = cache.get(url, ttl) if ttl and ttl > 0 else None
    if hit is not None:
        stats["cache_hits"] += 1
        return hit[0]

    hdrs = {"User-Agent": USER_AGENT, "Accept": "*/*", "Accept-Encoding": "gzip"}
    hdrs.update(headers or {})
    last_error = None
    for attempt in range(retries + 1):
        _throttle(host)
        stats["requests"] += 1
        try:
            req = urllib.request.Request(url, headers=hdrs)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read(MAX_BYTES + 1)
                if len(raw) > MAX_BYTES:
                    raise SourceError(url, "response larger than %d bytes" % MAX_BYTES)
                body = _decode(raw, resp.headers)
            if ttl and ttl > 0:
                cache.set(url, body)
            return body
        except urllib.error.HTTPError as err:
            last_error = err
            if err.code == 451:
                _blocked_hosts[host] = "HTTP 451"
                raise GeoBlocked(url, "%s refused this location (HTTP 451)" % host, 451)
            if err.code == 429 or err.code >= 500:
                if attempt < retries:
                    stats["retries"] += 1
                    delay = _retry_after(err) or min(30.0, (2 ** attempt) + random.random())
                    time.sleep(delay)
                    continue
            break
        except (urllib.error.URLError, socket.timeout, ConnectionError) as err:
            last_error = err
            if attempt < min(retries, 1):
                stats["retries"] += 1
                time.sleep(1.0 + random.random())
                continue
            break

    if allow_stale:
        stale = cache.get(url, 0, allow_stale=True)
        if stale is not None and stale[1] <= STALE_MAX_AGE:
            stats["stale"] += 1
            warnings.append("served a cached copy of %s (%d min old) — live request failed" % (host, stale[1] // 60))
            return stale[0]
    status = getattr(last_error, "code", None)
    reason = getattr(last_error, "reason", None) or str(last_error)
    raise SourceError(url, "%s request failed: %s" % (host, reason), status)


def get_json(url: str, **kwargs):
    text = get_text(url, **kwargs)
    try:
        return json.loads(text)
    except ValueError:
        raise SourceError(url, "%s returned something that is not JSON" % host_of(url))
