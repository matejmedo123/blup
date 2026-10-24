"""Perpetual-futures funding by coin and day — what the funding_squeeze setup reads.

    daily(base, days) → {UTC day index: mean funding that day, as a fraction a year} (0.10 = 10 %/yr)

Binance USD-M is the reference (the research behind the setup used it): complete months come from its public
archive (data.binance.vision, immutable, cached for good), the current month from its futures API. Where that API
is out of reach (it refuses US addresses), Kraken's perpetuals fill the recent days — the same quantity, hourly
on another venue. A coin without a perpetual has no funding and the setup never fires on it.
"""
from __future__ import annotations

import calendar
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
# Binance publishes a month's archive a few days after it ends: until this long after, a missing file is "not yet"
PUBLISH_DAYS = 10
API_PAGES = 5  # 1000 prints a page — enough for 55 days of hourly funding
ALIAS = {"BCC": "BCH", "BCHABC": "BCH"}
KRAKEN_BASE = {"BTC": "XBT"}
_memo = {}    # {(base, days): (hour, series)} — one entry per coin and window, replaced every hour
_source = {}  # {base: where its latest days came from}


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


def _interval_hours(gap_sec: float) -> int:
    """The funding interval a gap between two prints stands for (Binance pays every 1, 2, 4 or 8 hours)."""
    return min((1, 2, 4, 8), key=lambda h: abs(gap_sec / 3600.0 - h))


def _annualise(prints: list) -> dict:
    """{day: mean annualised funding} from [(time s, rate per interval)], each print by the gap to the one before
    (the first by the gap to the next) — the same quantity as the archive's rate × 8760 / interval hours."""
    prints = sorted(prints)
    out = {}
    for k, (t, rate) in enumerate(prints):
        if len(prints) == 1:
            hours = 8
        else:
            gap = prints[k][0] - prints[k - 1][0] if k else prints[1][0] - prints[0][0]
            hours = _interval_hours(gap)
        out.setdefault(int(t // DAY), []).append(rate * 8760.0 / hours)
    return {str(d): sum(v) / len(v) for d, v in out.items()}


def _recent_binance(base: str, start_ts: int) -> dict:
    for prefix in ("", "1000"):
        prints, start = [], int(start_ts * 1000)
        for _ in range(API_PAGES):
            try:
                rows = http.get_json(FAPI.format(s=_symbol(base, prefix), ms=start), ttl=RECENT_TTL)
            except http.SourceError:
                break
            if not isinstance(rows, list) or not rows:
                break
            for r in rows:
                try:
                    prints.append((int(r["fundingTime"]) / 1000.0, float(r["fundingRate"])))
                except (KeyError, TypeError, ValueError):
                    continue
            if len(rows) < 1000 or not prints:
                break
            start = int(prints[-1][0] * 1000) + 1
        if prints:
            return _annualise(prints)
    return {}


def _recent_kraken(base: str, start_ts: int) -> dict:
    b = KRAKEN_BASE.get(base.upper(), base.upper())
    try:
        rows = (http.get_json(KRAKEN.format(b=b), ttl=RECENT_TTL) or {}).get("rates") or []
    except http.SourceError:
        return {}
    out = {}
    for r in rows:
        try:
            t = calendar.timegm(time.strptime(r["timestamp"][:19], "%Y-%m-%dT%H:%M:%S"))
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
    hour = now // RECENT_TTL
    hit = _memo.get((base, days))
    if hit and hit[0] == hour:
        return hit[1]
    offline = config.is_offline()
    name = "cache/funding/%s.json" % base
    try:
        doc = state.read_json(name, {}) or {}
    except ValueError:
        doc = {}
    # months: the archive's days; none: {month: when it was found missing} — a month with no file (no perpetual
    # then) is settled only once it was checked well after Binance publishes; an empty month in "months" is from an
    # older cache that could not tell the two apart and is looked up again
    months = {m: v for m, v in (doc.get("months") or {}).items() if v}
    none = dict(doc.get("none") or {})
    this_month = time.strftime("%Y-%m", time.gmtime(now))
    changed = len(months) != len(doc.get("months") or {})
    for m in ([] if offline else _months(now - days * DAY, now)):
        if m == this_month or m in months or none.get(m, 0) >= _month_end(m) + PUBLISH_DAYS * DAY:
            continue
        got = _month(base, m)
        if got:
            months[m] = got
            none.pop(m, None)
            changed = True
        elif got is not None:  # no file yet, or never: judged again until it is past the publishing delay
            none[m] = now
            changed = True
    first = calendar.timegm(time.strptime(this_month + "-01", "%Y-%m-%d"))
    # the days the archive does not have yet: this month, and last month until Binance publishes it
    gap_start = first if time.strftime("%Y-%m", time.gmtime(first - DAY)) in months else first - 31 * DAY
    recent, source = ({}, None) if offline else (_recent_binance(base, gap_start), "binance")
    if not recent and not offline:
        recent, source = _recent_kraken(base, gap_start), "kraken"
    if changed and not offline:
        try:
            state.write_json(name, {"months": months, "none": none, "updated_at": now})
        except OSError:
            pass
    out = {}
    for m in months.values():
        out.update({int(d): v for d, v in m.items()})
    out.update({int(d): v for d, v in recent.items()})
    lo = now // DAY - days
    out = {d: v for d, v in out.items() if d >= lo}
    _memo[(base, days)] = (hour, out)
    _source[base] = source if recent else ("archive" if out else None)
    return out


def _month_end(month: str) -> int:
    y, m = int(month[:4]), int(month[5:7])
    return calendar.timegm((y + (m == 12), m % 12 + 1, 1, 0, 0, 0, 0, 0, 0))


def source_of(base: str):
    """Where the latest days of ``daily(base)`` came from: binance, kraken, archive or None."""
    return _source.get(str(base).split("~", 1)[0].upper())


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
