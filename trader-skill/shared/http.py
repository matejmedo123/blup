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
import http.client
import json
import random
import socket
import threading
import time
import urllib.error
import urllib.request
import zlib
from urllib.parse import urlsplit

from . import config
from .cache import FileCache

USER_AGENT = "Mozilla/5.0 (compatible; trader-skill/1.0; educational research tool)"
MAX_BYTES = 12 * 1024 * 1024
STALE_MAX_AGE = 24 * 3600
BLOCK_RETRY_SEC = 6 * 3600  # a geo-block is tried again after this — a daemon runs for months, a VPN can change

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
    "api.stocktwits.com": 1.0,   # public stream: roughly 200 requests/hour per IP
    "api.x.com": 1.0,            # pay-per-use: the budget matters more than the rate
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
_FETCH = threading.local()  # per thread: when the oldest body handed out since track() was downloaded
_cache = None
stats = {"requests": 0, "cache_hits": 0, "retries": 0, "stale": 0}
warnings = []


MAX_WARNINGS = 20


def note(text: str) -> None:
    """A data warning for whoever reads data next — each once, and only the latest few (a daemon runs for months)."""
    try:
        warnings.remove(text)  # another thread may clear the list in between — never an error for a warning
    except ValueError:
        pass
    warnings.append(text)
    del warnings[:-MAX_WARNINGS]


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


def read_body(resp, timeout: float, max_bytes: int = None) -> bytes:
    """The whole body within ``timeout`` seconds in total — a socket timeout only limits each read, so a server
    that trickles a byte a second would otherwise hold the caller for as long as it likes."""
    deadline = time.monotonic() + timeout
    chunks, size = [], 0
    while True:
        chunk = resp.read(65536)
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
        if max_bytes is not None and size > max_bytes:
            raise SourceError(getattr(resp, "url", "?"), "response larger than %d bytes" % max_bytes)
        if time.monotonic() > deadline:
            raise socket.timeout("the download took longer than %d s" % timeout)
    raw = b"".join(chunks)
    want = (resp.headers.get("Content-Length") or "").strip() if getattr(resp, "headers", None) else ""
    if want.isdigit() and len(raw) < int(want):
        raise http.client.IncompleteRead(raw, int(want) - len(raw))
    return raw


def _retry_after(err) -> float:
    value = err.headers.get("Retry-After") if getattr(err, "headers", None) else None
    try:
        return min(float(value), 60.0)
    except (TypeError, ValueError):
        return 0.0


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A request that carries a credential (the X bearer token) is never sent on to another server."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused (the request carries a credential)",
                                     headers, fp)


_NO_REDIRECT = urllib.request.build_opener(_NoRedirect)


def track() -> None:
    """Start noting when the bodies this thread receives were downloaded (see ``oldest_fetch``)."""
    _FETCH.oldest = None


def oldest_fetch():
    """Unix time the oldest body since ``track()`` was downloaded (a cached copy is as old as its download), or
    None. A bar that closed after that moment was still forming in the data — it must not count as closed."""
    return getattr(_FETCH, "oldest", None)


def _seen(fetched_at: float) -> None:
    old = getattr(_FETCH, "oldest", None)
    _FETCH.oldest = fetched_at if old is None else min(old, fetched_at)


def get_text(url: str, ttl: float = 60, headers: dict = None, retries: int = 3,
             timeout: float = 20, allow_stale: bool = True) -> str:
    if config.is_offline():
        from . import offline
        return offline.fetch(url)

    host = host_of(url)
    blocked = _blocked_hosts.get(host)
    if blocked and time.monotonic() - blocked[1] < BLOCK_RETRY_SEC:
        raise GeoBlocked(url, "%s is blocked from this location (%s)" % (host, blocked[0]), 451)

    cache = _get_cache()
    hit = cache.get(url, ttl) if ttl and ttl > 0 else None
    if hit is not None:
        stats["cache_hits"] += 1
        _seen(time.time() - hit[1])
        return hit[0]

    hdrs = {"User-Agent": USER_AGENT, "Accept": "*/*", "Accept-Encoding": "gzip"}
    hdrs.update(headers or {})
    last_error = None
    budget = time.monotonic() + timeout * 3 + 30  # retries and waits included: one source never holds a cycle long
    for attempt in range(retries + 1):
        _throttle(host)
        stats["requests"] += 1
        sent = time.time()
        try:
            req = urllib.request.Request(url, headers=hdrs)
            opener = _NO_REDIRECT.open if "Authorization" in hdrs else urllib.request.urlopen
            with opener(req, timeout=timeout) as resp:
                raw = read_body(resp, timeout * 2, MAX_BYTES)
                body = _decode(raw, resp.headers)
            if ttl and ttl > 0:
                cache.set(url, body, fetched_at=sent)
            _seen(sent)
            return body
        except urllib.error.HTTPError as err:
            last_error = err
            if err.code == 451:
                _blocked_hosts[host] = ("HTTP 451", time.monotonic())
                raise GeoBlocked(url, "%s refused this location (HTTP 451)" % host, 451)
            if err.code == 429 or err.code >= 500:
                delay = _retry_after(err) or min(30.0, (2 ** attempt) + random.random())
                if attempt < retries and time.monotonic() + delay < budget:
                    stats["retries"] += 1
                    time.sleep(delay)
                    continue
            break
        except (urllib.error.URLError, socket.timeout, ConnectionError, OSError, EOFError, zlib.error,
                http.client.HTTPException) as err:  # a cut-off or garbled download is a failed request, not a crash
            last_error = err
            if attempt < min(retries, 1) and time.monotonic() + 2 < budget:
                stats["retries"] += 1
                time.sleep(1.0 + random.random())
                continue
            break

    if allow_stale:
        stale = cache.get(url, 0, allow_stale=True)
        if stale is not None and stale[1] <= STALE_MAX_AGE:
            stats["stale"] += 1
            _seen(time.time() - stale[1])
            note("served a cached copy of %s (%d min old) — live request failed" % (host, stale[1] // 60))
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
