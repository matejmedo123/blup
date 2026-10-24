"""Perpetual-futures funding by coin and day — what the funding_squeeze setup reads.

    daily(base, days) → {UTC day index: mean funding that day, as a fraction a year} (0.10 = 10 %/yr)

Binance USD-M is the reference (the research behind the setup used it): complete months come from its public
archive (data.binance.vision, immutable, cached for good), the current month from its futures API. Where that API
is out of reach (it refuses US addresses), Kraken's perpetuals fill the recent days — the same quantity, hourly
on another venue. A coin without a perpetual has no funding and the setup never fires on it.
"""
from __future__ import annotations

import csv
import io
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor

from . import config, http, state

DAY = 86400
ARCHIVE = "https://data.binance.vision/data/futures/um/monthly/fundingRate/{s}/{s}-fundingRate-{m}.zip"
FAPI = "https://fapi.binance.com/fapi/v1/fundingRate?symbol={s}&startTime={ms}&limit=1000"
KRAKEN = "https://futures.kraken.com/derivatives/api/v4/historicalfundingrates?symbol=PF_{b}USD"
RECENT_TTL = 3600
ALIAS = {"BCC": "BCH", "BCHABC": "BCH"}
KRAKEN_BASE = {"BTC": "XBT"}
_memo = {}


def _symbol(base: str, prefix: str = "") -> str:
    return "%s%sUSDT" % (prefix, ALIAS.get(base.upper(), base.upper()))


def _months(start_ts: int, end_ts: int) -> list:
    y, m = time.gmtime(start_ts)[:2]
    out = []
    while (y, m) <= tuple(time.gmtime(end_ts)[:2]):
        out.append("%04d-%02d" % (y, m))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


def _download(url: str):
    """The archive's bytes, or None when Binance has no file for that month (404) — raises on other trouble."""
    if config.is_offline():
        return None
    req = urllib.request.Request(url, headers={"User-Agent": http.USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return http.read_body(resp, 60)
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return None
        raise


def _parse_archive(raw: bytes) -> dict:
    """{day: [annualised prints]} from one monthly CSV (calc_time ms, funding_interval_hours, last_funding_rate)."""
    out = {}
    z = zipfile.ZipFile(io.BytesIO(raw))
    for name in z.namelist():
        for row in csv.reader(io.TextIOWrapper(z.open(name), encoding="utf-8")):
            try:
                ms, hours, rate = int(row[0]), float(row[1] or 8), float(row[2])
            except (ValueError, IndexError):
                continue  # the header line
            out.setdefault(ms // 1000 // DAY, []).append(rate * 8760.0 / (hours or 8))
    return out


def _month(base: str, month: str) -> dict:
    """{day: mean} for one complete month, from the archive (both the plain and the 1000× contract names)."""
    for prefix in ("", "1000"):
        s = _symbol(base, prefix)
        try:
            raw = _download(ARCHIVE.format(s=s, m=month))
        except (urllib.error.URLError, OSError, ValueError):
            return None  # unknown: tried again next time
        if raw:
            try:
                return {str(d): sum(v) / len(v) for d, v in _parse_archive(raw).items()}
            except (zipfile.BadZipFile, ValueError):
                return None
    return {}


def _recent_binance(base: str, start_ts: int) -> dict:
    out = {}
    for prefix in ("", "1000"):
        try:
            rows = http.get_json(FAPI.format(s=_symbol(base, prefix), ms=int(start_ts * 1000)), ttl=RECENT_TTL)
        except http.SourceError:
            continue
        if isinstance(rows, list) and rows:
            for r in rows:
                try:
                    out.setdefault(int(r["fundingTime"]) // 1000 // DAY, []).append(float(r["fundingRate"]) * 3 * 365)
                except (KeyError, TypeError, ValueError):
                    continue
            break
    return {str(d): sum(v) / len(v) for d, v in out.items()}


def _recent_kraken(base: str, start_ts: int) -> dict:
    b = KRAKEN_BASE.get(base.upper(), base.upper())
    try:
        rows = (http.get_json(KRAKEN.format(b=b), ttl=RECENT_TTL) or {}).get("rates") or []
    except http.SourceError:
        return {}
    out = {}
    for r in rows:
        try:
            t = int(time.mktime(time.strptime(r["timestamp"][:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone)
            rel = float(r["relativeFundingRate"])  # per hour on Kraken
        except (KeyError, TypeError, ValueError):
            continue
        if t >= start_ts:
            out.setdefault(t // DAY, []).append(rel * 8760.0)
    return {str(d): sum(v) / len(v) for d, v in out.items()}


def daily(base: str, days: int = 400, now_ts: float = None) -> dict:
    """{day index (int): annualised mean funding} for the last ``days`` days, as far as any source has it."""
    base = str(base or "").split("~", 1)[0].upper()
    if not base:
        return {}
    now = int(now_ts if now_ts is not None else time.time())
    key = (base, days, now // RECENT_TTL)
    if key in _memo:
        return _memo[key]
    name = "cache/funding/%s.json" % base
    try:
        doc = state.read_json(name, {}) or {}
    except ValueError:
        doc = {}
    months = doc.get("months") or {}
    this_month = time.strftime("%Y-%m", time.gmtime(now))
    changed = False
    for m in _months(now - days * DAY, now):
        if m == this_month or m in months:
            continue
        got = _month(base, m)
        if got is not None:
            months[m] = got
            changed = True
    first = int(time.mktime(time.strptime(this_month + "-01", "%Y-%m-%d")) - time.timezone)
    # the days the archive does not have yet: this month, and last month until Binance publishes it
    gap_start = first if (time.strftime("%Y-%m", time.gmtime(first - DAY)) in months) else first - 31 * DAY
    recent = _recent_binance(base, gap_start) if not config.is_offline() else {}
    source = "binance"
    if not recent and not config.is_offline():
        recent, source = _recent_kraken(base, gap_start), "kraken"
    if changed:
        try:
            state.write_json(name, {"months": months, "updated_at": now})
        except OSError:
            pass
    out = {}
    for m in months.values():
        out.update({int(d): v for d, v in m.items()})
    out.update({int(d): v for d, v in recent.items()})
    lo = now // DAY - days
    out = {d: v for d, v in out.items() if d >= lo}
    _memo[key] = out
    _memo[(base, "source")] = source if recent else ("archive" if out else None)
    return out


def source_of(base: str):
    """Where the latest days of ``daily(base)`` came from: binance, kraken, archive or None."""
    return _memo.get((str(base).split("~", 1)[0].upper(), "source"))


def daily_many(bases, days: int = 400, now_ts: float = None, workers: int = 8) -> dict:
    """{base: daily(base)} for many coins at once (the first run downloads years of monthly archives)."""
    bases = sorted({str(b).split("~", 1)[0].upper() for b in bases if b})
    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        return dict(zip(bases, ex.map(lambda b: daily(b, days, now_ts), bases)))


def mean(series: dict, t: float, n: int = 3):
    """Mean of the n days ending on the day of bar time t (the signal day and the n−1 before), or None."""
    d = int(t // DAY)
    vals = [series.get(d - k) for k in range(n)]
    if any(v is None for v in vals):
        return None
    return sum(vals) / n
