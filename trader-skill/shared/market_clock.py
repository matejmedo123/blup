"""Market clock: NYSE sessions in America/New_York, and 24/7 windows for crypto.

* NYSE holidays and 1:00 p.m. early closes for 2026 and 2027 are pinned from
  the official NYSE calendar; other years fall back to the published rules
  (and say so).
* ``zoneinfo`` is used when available; otherwise (Python 3.8, or Windows
  without tzdata) the US and EU daylight-saving rules are computed directly.
* ``now_utc()`` honours ``TRADER_NOW`` so offline demos and tests can pin time.
"""
from __future__ import annotations

import os
import re
from datetime import date, datetime, time as dtime, timedelta, timezone

UTC = timezone.utc

try:  # Python 3.9+
    from zoneinfo import ZoneInfo
    try:
        _NY = ZoneInfo("America/New_York")
    except Exception:  # tzdata missing (e.g. Windows)
        _NY = None
except ImportError:  # Python 3.8
    _NY = None

# Official NYSE calendar (NYSE Group press release, Dec 2025).
OFFICIAL_HOLIDAYS = {
    2026: {
        date(2026, 1, 1): "New Year's Day",
        date(2026, 1, 19): "Martin Luther King, Jr. Day",
        date(2026, 2, 16): "Washington's Birthday",
        date(2026, 4, 3): "Good Friday",
        date(2026, 5, 25): "Memorial Day",
        date(2026, 6, 19): "Juneteenth National Independence Day",
        date(2026, 7, 3): "Independence Day (observed)",
        date(2026, 9, 7): "Labor Day",
        date(2026, 11, 26): "Thanksgiving Day",
        date(2026, 12, 25): "Christmas Day",
    },
    2027: {
        date(2027, 1, 1): "New Year's Day",
        date(2027, 1, 18): "Martin Luther King, Jr. Day",
        date(2027, 2, 15): "Washington's Birthday",
        date(2027, 3, 26): "Good Friday",
        date(2027, 5, 31): "Memorial Day",
        date(2027, 6, 18): "Juneteenth National Independence Day (observed)",
        date(2027, 7, 5): "Independence Day (observed)",
        date(2027, 9, 6): "Labor Day",
        date(2027, 11, 25): "Thanksgiving Day",
        date(2027, 12, 24): "Christmas Day (observed)",
    },
}
OFFICIAL_EARLY_CLOSES = {
    2026: {date(2026, 11, 27): "Day after Thanksgiving", date(2026, 12, 24): "Christmas Eve"},
    2027: {date(2027, 11, 26): "Day after Thanksgiving"},
}

REGULAR_OPEN = dtime(9, 30)
REGULAR_CLOSE = dtime(16, 0)
EARLY_CLOSE = dtime(13, 0)
PRE_MARKET_OPEN = dtime(4, 0)
AFTER_HOURS_CLOSE = dtime(20, 0)


# --- time helpers --------------------------------------------------------------

def parse_iso(value) -> datetime:
    """Parse ISO-8601 (``Z`` allowed, Python 3.8 safe) into an aware UTC datetime."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), UTC)
    s = str(value).strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
        s += "T00:00:00"
    s = s.replace(" ", "T")
    if s.endswith("Z") or s.endswith("z"):
        s = s[:-1] + "+00:00"
    s = re.sub(r"\.(\d{1,6})\d*", lambda m: "." + m.group(1).ljust(6, "0"), s)
    # +0000 and -04 (what some APIs send) → +00:00 / -04:00, which Python 3.8's fromisoformat needs
    s = re.sub(r"([+-])(\d{2})(?::?(\d{2}))?$", lambda m: "%s%s:%s" % (m.group(1), m.group(2), m.group(3) or "00"), s)
    dt = datetime.fromisoformat(s)
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


def iso(dt) -> str:
    if isinstance(dt, (int, float)):
        dt = datetime.fromtimestamp(float(dt), UTC)
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def ts(dt) -> int:
    return int(parse_iso(dt).timestamp())


def from_ts(t) -> datetime:
    return datetime.fromtimestamp(float(t), UTC)


def now_utc() -> datetime:
    pinned = os.environ.get("TRADER_NOW")
    if pinned:
        return parse_iso(pinned)
    return datetime.now(UTC).replace(microsecond=0)


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    d = date(year, month, 1)
    d += timedelta(days=(weekday - d.weekday()) % 7)
    return d + timedelta(weeks=n - 1)


def _last_weekday(year: int, month: int, weekday: int) -> date:
    d = date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)
    return d - timedelta(days=(d.weekday() - weekday) % 7)


def _us_dst_utc(year: int):
    """US DST runs from 2:00 local on the 2nd Sunday of March to 2:00 local on the 1st Sunday of November."""
    start = datetime.combine(_nth_weekday(year, 3, 6, 2), dtime(7, 0), UTC)   # 2:00 EST
    end = datetime.combine(_nth_weekday(year, 11, 6, 1), dtime(6, 0), UTC)    # 2:00 EDT
    return start, end


def _eu_dst_utc(year: int):
    """EU summer time runs from 01:00 UTC on the last Sunday of March to 01:00 UTC on the last Sunday of October."""
    return (datetime.combine(_last_weekday(year, 3, 6), dtime(1, 0), UTC),
            datetime.combine(_last_weekday(year, 10, 6), dtime(1, 0), UTC))


def et_offset(dt_utc: datetime) -> timedelta:
    dt_utc = parse_iso(dt_utc)
    if _NY is not None:
        return dt_utc.astimezone(_NY).utcoffset()
    start, end = _us_dst_utc(dt_utc.year)
    return timedelta(hours=-4) if start <= dt_utc < end else timedelta(hours=-5)


def warsaw_offset(dt_utc: datetime) -> timedelta:
    start, end = _eu_dst_utc(dt_utc.year)
    return timedelta(hours=2) if start <= dt_utc < end else timedelta(hours=1)


def to_et(dt) -> datetime:
    dt = parse_iso(dt)
    if _NY is not None:
        return dt.astimezone(_NY)
    return dt.astimezone(timezone(et_offset(dt)))


def et_to_utc(d: date, hh: int, mm: int = 0) -> datetime:
    if _NY is not None:
        return datetime(d.year, d.month, d.day, hh, mm, tzinfo=_NY).astimezone(UTC)
    naive = datetime(d.year, d.month, d.day, hh, mm)
    guess = (naive + timedelta(hours=5)).replace(tzinfo=UTC)          # assume EST
    if et_offset(guess) == timedelta(hours=-4):
        guess = (naive + timedelta(hours=4)).replace(tzinfo=UTC)
    return guess


def et_date(dt) -> date:
    return to_et(dt).date()


def fmt_et(dt, with_date: bool = False) -> str:
    """'9:45' or 'Oct 20 9:45' in New York time."""
    e = to_et(dt)
    hm = "%d:%02d" % (e.hour % 12 or 12, e.minute)
    return ("%s %d %s" % (e.strftime("%b"), e.day, hm)) if with_date else hm


def fmt_et_ampm(dt) -> str:
    e = to_et(dt)
    return "%d:%02d %s" % (e.hour % 12 or 12, e.minute, "a.m." if e.hour < 12 else "p.m.")


def fmt_utc(dt, with_date: bool = False) -> str:
    u = parse_iso(dt)
    return u.strftime("%b %d %H:%M UTC" if with_date else "%H:%M UTC")


# --- NYSE calendar ---------------------------------------------------------------

def _easter(year: int) -> date:
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def _observed(d: date, saturday_rule: bool = True):
    if d.weekday() == 5:
        return d - timedelta(days=1) if saturday_rule else None
    if d.weekday() == 6:
        return d + timedelta(days=1)
    return d


def rule_holidays(year: int) -> dict:
    out = {}
    ny = _observed(date(year, 1, 1), saturday_rule=False)  # NYSE does not close Dec 31 for a Saturday New Year
    if ny:
        out[ny] = "New Year's Day"
    out[_nth_weekday(year, 1, 0, 3)] = "Martin Luther King, Jr. Day"
    out[_nth_weekday(year, 2, 0, 3)] = "Washington's Birthday"
    out[_easter(year) - timedelta(days=2)] = "Good Friday"
    out[_last_weekday(year, 5, 0)] = "Memorial Day"
    if year >= 2022:
        jt = date(year, 6, 19)
        out[_observed(jt)] = "Juneteenth National Independence Day" + ("" if jt.weekday() < 5 else " (observed)")
    j4 = date(year, 7, 4)
    out[_observed(j4)] = "Independence Day" + ("" if j4.weekday() < 5 else " (observed)")
    out[_nth_weekday(year, 9, 0, 1)] = "Labor Day"
    out[_nth_weekday(year, 11, 3, 4)] = "Thanksgiving Day"
    xmas = date(year, 12, 25)
    out[_observed(xmas)] = "Christmas Day" + ("" if xmas.weekday() < 5 else " (observed)")
    return out


def rule_early_closes(year: int) -> dict:
    out = {_nth_weekday(year, 11, 3, 4) + timedelta(days=1): "Day after Thanksgiving"}
    hol = rule_holidays(year)
    for d, name in ((date(year, 7, 3), "Independence Day eve"), (date(year, 12, 24), "Christmas Eve")):
        if d.weekday() < 4 and d not in hol:  # Mon–Thu only, and not itself an observed holiday
            out[d] = name
    return out


def holidays(year: int) -> dict:
    return dict(OFFICIAL_HOLIDAYS.get(year) or rule_holidays(year))


def early_closes(year: int) -> dict:
    return dict(OFFICIAL_EARLY_CLOSES.get(year) or rule_early_closes(year))


def calendar_source(year: int) -> str:
    return "official NYSE calendar" if year in OFFICIAL_HOLIDAYS else "rule-based (verify against nyse.com)"


def holiday_name(d: date):
    return holidays(d.year).get(d)


def is_trading_day(d: date) -> bool:
    return d.weekday() < 5 and d not in holidays(d.year)


def is_early_close(d: date) -> bool:
    return d in early_closes(d.year)


def session_bounds(d: date):
    """(open_utc, close_utc) of the regular session, or None on non-trading days."""
    if not is_trading_day(d):
        return None
    close = EARLY_CLOSE if is_early_close(d) else REGULAR_CLOSE
    return et_to_utc(d, REGULAR_OPEN.hour, REGULAR_OPEN.minute), et_to_utc(d, close.hour, close.minute)


def next_trading_day(d: date) -> date:
    d += timedelta(days=1)
    while not is_trading_day(d):
        d += timedelta(days=1)
    return d


def prev_trading_day(d: date) -> date:
    d -= timedelta(days=1)
    while not is_trading_day(d):
        d -= timedelta(days=1)
    return d


def trading_days(end: date, n: int) -> list:
    """The last ``n`` trading days ending at ``end`` (inclusive), oldest first."""
    out = []
    d = end
    while len(out) < n:
        if is_trading_day(d):
            out.append(d)
        d -= timedelta(days=1)
    return out[::-1]


def market_status(now: datetime = None) -> dict:
    now = parse_iso(now) if now else now_utc()
    d = et_date(now)
    bounds = session_bounds(d)
    early = is_early_close(d)
    if bounds:
        open_utc, close_utc = bounds
        pre = et_to_utc(d, PRE_MARKET_OPEN.hour)
        after_end = et_to_utc(d, 17 if early else AFTER_HOURS_CLOSE.hour)
        if now < pre:
            state = "closed"
        elif now < open_utc:
            state = "pre-market"
        elif now < close_utc:
            state = "open"
        elif now < after_end:
            state = "after-hours"
        else:
            state = "closed"
    else:
        state = "closed"
        open_utc = close_utc = None
    if state in ("open",):
        next_open = None
    elif bounds and now < bounds[0]:
        next_open = bounds[0]
    else:
        next_open = session_bounds(next_trading_day(d))[0]
    return {
        "state": state,
        "session_date": d.isoformat(),
        "trading_day": bounds is not None,
        "holiday": holiday_name(d) if d.weekday() < 5 else None,
        "early_close": early,
        "opens_at": iso(open_utc) if open_utc else None,
        "closes_at": iso(close_utc) if close_utc else None,
        "next_open": iso(next_open) if next_open else None,
        "minutes_to_close": int((close_utc - now).total_seconds() // 60) if state == "open" else None,
        "calendar": calendar_source(d.year),
    }


def stock_bucket(t) -> str:
    """Time-of-day bucket used by the Time Machine: morning / midday / power hour."""
    e = to_et(from_ts(t) if isinstance(t, (int, float)) else t)
    minutes = e.hour * 60 + e.minute
    if minutes < 11 * 60 + 30:
        return "morning"
    if minutes < 15 * 60:
        return "midday"
    return "power_hour"


def session_close_time(d: date) -> datetime:
    b = session_bounds(d)
    return b[1] if b else None


def flat_by(d: date, minutes_before_close: int = 5) -> datetime:
    """Stock time stop: 3:55 p.m. ET (12:55 on early-close days)."""
    close = session_close_time(d)
    return close - timedelta(minutes=minutes_before_close) if close else None


# --- 24/7 windows (crypto & meme) --------------------------------------------------

def utc_day_start(dt) -> datetime:
    dt = parse_iso(dt)
    return datetime(dt.year, dt.month, dt.day, tzinfo=UTC)


def us_open_utc(d: date) -> datetime:
    """When the US cash session opens on date ``d`` (9:30 ET), even on weekends — used as context."""
    return et_to_utc(d, 9, 30)


def crypto_ranges(d: date) -> dict:
    """Named ranges for crypto range-breakout setups on UTC date ``d``."""
    start = datetime(d.year, d.month, d.day, tzinfo=UTC)
    us = us_open_utc(d)
    return {
        "asia": (start, start + timedelta(hours=8)),
        "utc_open": (start, start + timedelta(hours=1)),
        "us_open": (us, us + timedelta(minutes=30)),
    }


def crypto_bucket(t) -> str:
    """asia 00:00–08:00 UTC · europe 08:00–US open · us US open–24:00."""
    dt = from_ts(t) if isinstance(t, (int, float)) else parse_iso(t)
    if dt.hour < 8:
        return "asia"
    us = us_open_utc(dt.date())
    return "europe" if dt < us else "us"


def crypto_context(dt=None) -> dict:
    dt = parse_iso(dt) if dt else now_utc()
    us = us_open_utc(dt.date())
    if dt >= us:
        us = us_open_utc(dt.date() + timedelta(days=1))
    return {
        "session": crypto_bucket(dt),
        "weekend": dt.weekday() >= 5,
        "minutes_to_us_open": int((us - dt).total_seconds() // 60),
        "us_market": market_status(dt)["state"],
    }


_HORIZON = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([mhd])\s*$", re.I)


def parse_horizon(value) -> int:
    """'1h' / '4h' / '24h' / '90m' / '1d' → seconds."""
    if isinstance(value, (int, float)):
        return int(value)
    m = _HORIZON.match(str(value or ""))
    if not m:
        raise ValueError("horizon must look like 1h, 4h, 24h or 90m (got %r)" % value)
    n, unit = float(m.group(1)), m.group(2).lower()
    return int(n * {"m": 60, "h": 3600, "d": 86400}[unit])


def interval_seconds(interval: str) -> int:
    return parse_horizon(interval)
