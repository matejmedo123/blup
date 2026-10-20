"""Human formatting for prices, money, percentages and quantities."""
from __future__ import annotations

import math


def price(x, currency: str = "$") -> str:
    """Adaptive precision: $67,420.00 · $364.18 · $0.4213 · $0.000004213."""
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "n/a"
    x = float(x)
    sign = "-" if x < 0 else ""
    a = abs(x)
    if a >= 1:
        body = "{:,.2f}".format(a)
    elif a >= 0.01:
        body = "{:.4f}".format(a)
    elif a == 0:
        body = "0.00"
    else:
        digits = max(4, -int(math.floor(math.log10(a))) + 3)
        body = ("{:.%df}" % min(digits, 12)).format(a)
    return sign + currency + body


def money(x, currency: str = "$", decimals: int = 2) -> str:
    if x is None:
        return "n/a"
    x = float(x)
    sign = "-" if x < 0 else ""
    return sign + currency + ("{:,.%df}" % decimals).format(abs(x))


def compact_usd(x) -> str:
    if x is None:
        return "n/a"
    x = float(x)
    for div, suffix in ((1e9, "B"), (1e6, "M"), (1e3, "k")):
        if abs(x) >= div:
            return "$%.1f%s" % (x / div, suffix)
    return "$%.0f" % x


def pct(x, decimals: int = 1, signed: bool = False) -> str:
    if x is None:
        return "n/a"
    spec = "{:+.%df}%%" if signed else "{:.%df}%%"
    return (spec % decimals).format(float(x))


def r(x, decimals: int = 2) -> str:
    if x is None:
        return "n/a"
    return ("%+." + str(decimals) + "fR") % float(x)


def qty(x, unit: str = "") -> str:
    if x is None:
        return "n/a"
    x = float(x)
    if x == int(x) and abs(x) < 1e12:
        s = "{:,}".format(int(x))
    elif abs(x) >= 1:
        s = ("{:,.4f}".format(x)).rstrip("0").rstrip(".")
    else:
        s = ("{:.8f}".format(x)).rstrip("0").rstrip(".")
    return (s + " " + unit).strip()


def count(n) -> str:
    return "{:,}".format(int(n))


def prob(p) -> str:
    return "%.0f%%" % (100.0 * float(p)) if p is not None else "n/a"
