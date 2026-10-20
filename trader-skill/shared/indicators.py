"""Indicators and series helpers on lists of Candle(t, o, h, l, c, v)."""
from __future__ import annotations

import math
from collections import namedtuple

Candle = namedtuple("Candle", "t o h l c v")


def closes(candles) -> list:
    return [c.c for c in candles]


def vwap(candles) -> list:
    """Anchored VWAP from the first candle, using the typical price (H+L+C)/3."""
    out, pv, vol = [], 0.0, 0.0
    for c in candles:
        tp = (c.h + c.l + c.c) / 3.0
        pv += tp * max(c.v, 0.0)
        vol += max(c.v, 0.0)
        out.append(pv / vol if vol > 0 else tp)
    return out


def true_ranges(candles) -> list:
    out = []
    prev = None
    for c in candles:
        tr = c.h - c.l if prev is None else max(c.h - c.l, abs(c.h - prev), abs(c.l - prev))
        out.append(tr)
        prev = c.c
    return out


def atr(candles, n: int = 14) -> list:
    """Wilder ATR; the first n-1 values are a running average so the list is never empty-headed."""
    trs = true_ranges(candles)
    out = []
    value = None
    for i, tr in enumerate(trs):
        if i < n:
            value = sum(trs[: i + 1]) / (i + 1)
        else:
            value = (value * (n - 1) + tr) / n
        out.append(value)
    return out


def last_atr(candles, n: int = 14) -> float:
    a = atr(candles, n)
    return a[-1] if a else 0.0


def sma(values, n: int) -> list:
    out, s = [], 0.0
    for i, v in enumerate(values):
        s += v
        if i >= n:
            s -= values[i - n]
        out.append(s / min(i + 1, n))
    return out


def median(values):
    v = sorted(values)
    if not v:
        return None
    mid = len(v) // 2
    return v[mid] if len(v) % 2 else (v[mid - 1] + v[mid]) / 2.0


def percentile(sorted_values, p: float):
    """Linear-interpolated percentile of an already sorted list, p in [0, 100]."""
    if not sorted_values:
        return None
    if len(sorted_values) == 1:
        return sorted_values[0]
    k = (len(sorted_values) - 1) * (p / 100.0)
    lo = int(math.floor(k))
    hi = min(lo + 1, len(sorted_values) - 1)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (k - lo)


def log_returns(candles) -> list:
    out = []
    for prev, cur in zip(candles, candles[1:]):
        if prev.c > 0 and cur.c > 0:
            out.append(math.log(cur.c / prev.c))
    return out


def stdev(values) -> float:
    n = len(values)
    if n < 2:
        return 0.0
    m = sum(values) / n
    return math.sqrt(sum((x - m) ** 2 for x in values) / (n - 1))


def realized_vol(candles) -> float:
    """Standard deviation of bar-to-bar log returns (per bar, not annualised)."""
    return stdev(log_returns(candles))


def highest(candles, attr: str = "h"):
    return max(getattr(c, attr) for c in candles) if candles else None


def lowest(candles, attr: str = "l"):
    return min(getattr(c, attr) for c in candles) if candles else None


def cumulative_volume(candles) -> list:
    out, s = [], 0.0
    for c in candles:
        s += c.v
        out.append(s)
    return out


def relative_volume(today, history_sessions) -> float:
    """Cumulative volume so far today ÷ average cumulative volume at the same bar in past sessions."""
    if not today or not history_sessions:
        return None
    k = len(today)
    past = []
    for sess in history_sessions:
        if len(sess) >= k:
            past.append(sum(c.v for c in sess[:k]))
    if not past:
        return None
    avg = sum(past) / len(past)
    return (sum(c.v for c in today) / avg) if avg > 0 else None


def volume_spike(candles, lookback: int = 48) -> float:
    """Last bar's volume ÷ median volume of the previous ``lookback`` bars."""
    if len(candles) < 6:
        return None
    base = median([c.v for c in candles[-lookback - 1:-1]])
    return (candles[-1].v / base) if base else None


def pct_change(a, b):
    if a in (None, 0) or b is None:
        return None
    return (b / a - 1.0) * 100.0
