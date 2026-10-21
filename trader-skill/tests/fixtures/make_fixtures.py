#!/usr/bin/env python3
"""Regenerate the offline fixtures (deterministic — same seed, same bytes).

    python3 tests/fixtures/make_fixtures.py

Everything here is SYNTHETIC test data in the raw format of each public API.
Prices, headlines, tokens and addresses are made up for the demos; the token
addresses are random strings, not real contracts.

Demo moments (all 2026-10-20):
  TSLA  opening range 9:30–9:45 ET high $362.18 / low $358.32; the 10:10 candle
        closes above it at $364.18 (now = 14:15Z)
  BTC   Asia range 00:00–08:00 UTC high $67,420; the 14:35 UTC candle closes
        above it with rising open interest (now = 14:40Z)
  PUPKIN (Solana) momentum breakout on the 15:50 UTC candle (now = 15:55Z);
        passes rugcheck. MLAMBO (Solana) fails: LP unlocked + 40 % top holder.
"""
from __future__ import annotations

import hashlib
import json
import math
import random
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent))

from shared import market_clock as mc  # noqa: E402

OUT = HERE / "http"
UTC = timezone.utc
DEMO = date(2026, 10, 20)
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58(seed: str, n: int = 44, suffix: str = "") -> str:
    h = hashlib.sha256(seed.encode()).digest()
    num = int.from_bytes(h + hashlib.sha256(h).digest(), "big")
    s = ""
    while len(s) < n - len(suffix):
        num, r = divmod(num, 58)
        s += B58[r]
    return s + suffix


def evm(seed: str) -> str:
    return "0x" + hashlib.sha256(seed.encode()).hexdigest()[:40]


TOKENS = {
    "PUPKIN": {"chain": "solana", "address": b58("pumpkin-pup-mint", 44, "pump"), "pool": b58("pumpkin-pup-pool", 44),
               "pool2": b58("pumpkin-pup-pool-2", 44), "name": "Pumpkin Pup"},
    "MLAMBO": {"chain": "solana", "address": b58("moon-lambo-mint", 44, "pump"), "pool": b58("moon-lambo-pool", 44),
               "name": "Moon Lambo"},
    "NEWT": {"chain": "base", "address": evm("newt-base-token"), "pool": evm("newt-base-pool"), "name": "Newt Coin"},
    "OLDFROG": {"chain": "ethereum", "address": evm("old-frog-eth"), "pool": evm("old-frog-pool"), "name": "Old Frog"},
}
CREATOR_MLAMBO = b58("moon-lambo-creator", 44)
WHALE_MLAMBO = b58("moon-lambo-whale", 44)


def ts(dt: datetime) -> int:
    return int(dt.timestamp())


def utc(y, m, d, hh=0, mm=0) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=UTC)


def write(rel: str, obj) -> None:
    p = OUT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(obj, str):
        p.write_text(obj, encoding="utf-8")
    else:
        p.write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")


def student_t(rng: random.Random, df: float = 4.0) -> float:
    z = rng.gauss(0, 1)
    chi = sum(rng.gauss(0, 1) ** 2 for _ in range(int(df)))
    return z / math.sqrt(chi / df) / math.sqrt(df / (df - 2))


def ohlc_from(rng, o, c, sigma, wick=0.45):
    h = max(o, c) * math.exp(abs(rng.gauss(0, wick * sigma)))
    l = min(o, c) * math.exp(-abs(rng.gauss(0, wick * sigma)))
    return o, h, l, c


def rnd(x, dp):
    return round(x, dp)


def fix_bar(o, h, l, c, dp):
    o, h, l, c = (rnd(v, dp) for v in (o, h, l, c))
    return o, max(h, o, c), min(l, o, c), c


# --- stocks ----------------------------------------------------------------------------

def vol_profile(k: int, n: int) -> float:
    return 0.55 + 1.7 * math.exp(-k / 6.0) + 0.75 * math.exp(-(n - 1 - k) / 8.0)


def sigma_profile(k: int, n: int) -> float:
    return 0.72 + 1.45 * math.exp(-k / 8.0) + 0.45 * math.exp(-(n - 1 - k) / 10.0)


def random_session(rng, d, open_px, sigma_bar, base_vol, orb_follow=0.0):
    """One regular session. ``orb_follow`` > 0 builds in an opening-range follow-through: after the first
    5-min close above the 15-min opening range, the next bars drift up with that probability — a
    synthetic edge so the demo has one setup whose history genuinely supports it."""
    o_t, c_t = mc.session_bounds(d)
    n = (ts(c_t) - ts(o_t)) // 300
    day_sig = sigma_bar * math.exp(rng.gauss(0, 0.25))
    drift = rng.gauss(0, 0.6 * day_sig)
    bars, px = [], open_px
    broke, boost = False, 0
    for k in range(n):
        s = day_sig * sigma_profile(k, n)
        r = drift / n * 3 + s * student_t(rng) + (0.3 * s if boost > 0 else 0.0)
        boost = max(0, boost - 1)
        o = px
        c = o * math.exp(r)
        o, h, l, c = ohlc_from(rng, o, c, s)
        v = base_vol * vol_profile(k, n) * math.exp(rng.gauss(0, 0.35)) * (1 + 18 * abs(r))
        bars.append([ts(o_t) + 300 * k, o, h, l, c, v])
        px = c
        if orb_follow and k >= 3 and not broke and c > max(b[2] for b in bars[:3]):
            broke = True
            if k < 24 and rng.random() < orb_follow:
                boost = 24
    return bars


def scripted_after(rng, start_t, end_t, start_px, waypoints, sigma, base_vol, n_total, k0):
    """Noisy path from start_px through (t, price) waypoints until end_t."""
    pts = [(start_t, start_px)] + waypoints
    bars, px = [], start_px
    t = start_t
    k = k0
    while t < end_t:
        for (t0, p0), (t1, p1) in zip(pts, pts[1:]):
            if t0 <= t < t1:
                goal = p0 + (p1 - p0) * (t + 300 - t0) / float(t1 - t0)
                break
        else:
            goal = pts[-1][1]
        c = goal * math.exp(rng.gauss(0, sigma))
        o = px
        o, h, l, c = ohlc_from(rng, o, c, sigma)
        v = base_vol * vol_profile(k, n_total) * math.exp(rng.gauss(0, 0.3)) * (1 + 12 * abs(math.log(c / o)))
        bars.append([t, o, h, l, c, v])
        px = c
        t += 300
        k += 1
    return bars


def scale_bars(bars, factor):
    return [[b[0], b[1] * factor, b[2] * factor, b[3] * factor, b[4] * factor, b[5]] for b in bars]


def make_stock(ticker, sessions, rng, start_px, sigma_bar, base_vol, prev_close_target, today_bars_fn,
               orb_follow=0.0):
    days = mc.trading_days(DEMO, sessions + 1)
    hist_days, today = days[:-1], days[-1]
    bars, px = [], start_px
    for d in hist_days:
        gap = math.exp(rng.gauss(0, 0.011))
        sess = random_session(rng, d, px * gap, sigma_bar, base_vol, orb_follow)
        bars.extend(sess)
        px = sess[-1][4]
    bars = scale_bars(bars, prev_close_target / bars[-1][4])
    bars.extend(today_bars_fn(rng, today, prev_close_target))
    return [list(b[:1]) + list(fix_bar(b[1], b[2], b[3], b[4], 2)) + [int(b[5])] for b in bars]


def yahoo_chart(ticker, name, bars, prev_close):
    return {"chart": {"result": [{
        "meta": {"currency": "USD", "symbol": ticker, "exchangeName": "NMS", "fullExchangeName": "NasdaqGS",
                 "instrumentType": "EQUITY", "regularMarketPrice": bars[-1][4], "chartPreviousClose": prev_close,
                 "shortName": name, "longName": name, "dataGranularity": "5m", "range": "60d",
                 "exchangeTimezoneName": "America/New_York"},
        "timestamp": [b[0] for b in bars],
        "indicators": {"quote": [{"open": [b[1] for b in bars], "high": [b[2] for b in bars],
                                  "low": [b[3] for b in bars], "close": [b[4] for b in bars],
                                  "volume": [b[5] for b in bars]}]}}], "error": None}}


def et(d, hh, mm):
    return ts(mc.et_to_utc(d, hh, mm))


def tsla_today(rng, d, prev_close):
    o_t, c_t = mc.session_bounds(d)
    n = (ts(c_t) - ts(o_t)) // 300
    base = 1.15e6 * 2.6
    scripted = [  # 9:30 … 10:10 — the opening range and the breakout
        (9, 30, 360.10, 362.18, 358.90, 361.40), (9, 35, 361.40, 361.95, 358.32, 359.20),
        (9, 40, 359.20, 361.10, 358.75, 360.85), (9, 45, 360.85, 361.80, 359.90, 361.20),
        (9, 50, 361.20, 362.05, 360.40, 361.75), (9, 55, 361.75, 362.10, 360.95, 361.05),
        (10, 0, 361.05, 361.60, 360.20, 360.80), (10, 5, 360.80, 362.00, 360.55, 361.90),
        (10, 10, 361.90, 364.60, 361.70, 364.18),
    ]
    bars = []
    for k, (hh, mm, o, h, l, c) in enumerate(scripted):
        mult = 2.4 if (hh, mm) == (10, 10) else 1.0
        bars.append([et(d, hh, mm), o, h, l, c, base * vol_profile(k, n) * mult * math.exp(rng.gauss(0, 0.15))])
    way = [(et(d, 11, 0), 368.4), (et(d, 11, 45), 371.0), (et(d, 12, 40), 367.2), (et(d, 13, 40), 369.6),
           (et(d, 14, 35), 375.2), (et(d, 14, 50), 376.6), (et(d, 15, 30), 373.8), (et(d, 16, 0), 374.5)]
    bars += scripted_after(rng, et(d, 10, 15), ts(c_t), 364.18, way, 0.0016, 1.15e6 * 1.8, n, len(scripted))
    return bars


def nvda_today(rng, d, prev_close):
    o_t, c_t = mc.session_bounds(d)
    n = 78
    base = 2.2e6 * 2.2
    scripted = [(9, 30, 191.80, 193.10, 190.90, 192.60), (9, 35, 192.60, 193.05, 191.70, 192.20),
                (9, 40, 192.20, 193.80, 192.05, 193.45)]
    bars = [[et(d, hh, mm), o, h, l, c, base * vol_profile(k, n)] for k, (hh, mm, o, h, l, c) in enumerate(scripted)]
    way = [(et(d, 10, 30), 195.1), (et(d, 12, 0), 194.0), (et(d, 16, 0), 196.2)]
    return bars + scripted_after(rng, et(d, 9, 45), ts(c_t), 193.45, way, 0.0018, 2.2e6 * 1.4, n, 3)


def amd_today(rng, d, prev_close):
    o_t, c_t = mc.session_bounds(d)
    n = 78
    base = 0.9e6 * 1.6
    seq = [(9, 30, 238.40, 239.90, 237.80, 239.60, 1.0), (9, 35, 239.60, 241.20, 239.30, 240.95, 1.0),
           (9, 40, 240.95, 241.05, 238.10, 238.30, 1.0), (9, 45, 238.30, 238.70, 237.20, 237.55, 0.9),
           (9, 50, 237.55, 238.20, 236.90, 237.10, 0.8), (9, 55, 237.10, 237.90, 236.70, 237.40, 0.7),
           (10, 0, 237.40, 238.10, 237.00, 237.85, 0.7), (10, 5, 237.85, 240.30, 237.70, 240.05, 2.6)]
    bars = [[et(d, hh, mm), o, h, l, c, base * vol_profile(k, n) * m]
            for k, (hh, mm, o, h, l, c, m) in enumerate(seq)]
    way = [(et(d, 11, 0), 241.3), (et(d, 13, 0), 239.4), (et(d, 16, 0), 242.0)]
    return bars + scripted_after(rng, et(d, 10, 10), ts(c_t), 240.05, way, 0.0017, 0.9e6, n, len(seq))


def pltr_today(rng, d, prev_close):
    o_t, c_t = mc.session_bounds(d)
    n = 78
    base = 1.6e6 * 1.5
    seq = [(9, 30, 182.20, 183.40, 181.90, 183.10), (9, 35, 183.10, 184.90, 182.90, 184.70),
           (9, 40, 184.70, 186.80, 184.50, 186.55), (9, 45, 186.55, 188.20, 186.30, 188.05),
           (9, 50, 188.05, 188.60, 187.50, 188.30),  # pole top
           (9, 55, 188.30, 188.45, 187.40, 187.70), (10, 0, 187.70, 188.20, 187.35, 187.95),
           (10, 5, 187.95, 188.40, 187.60, 188.10),  # flag
           (10, 10, 188.10, 189.60, 188.00, 189.30)]  # breakout
    vols = [1.0, 1.3, 1.5, 1.6, 1.1, 0.6, 0.5, 0.5, 1.9]
    bars = [[et(d, hh, mm), o, h, l, c, base * vol_profile(k, n) * vols[k]]
            for k, (hh, mm, o, h, l, c) in enumerate(seq)]
    way = [(et(d, 11, 0), 190.6), (et(d, 13, 0), 188.9), (et(d, 16, 0), 190.1)]
    return bars + scripted_after(rng, et(d, 10, 15), ts(c_t), 189.30, way, 0.0019, 1.6e6, n, len(seq))


def plain_today(sigma, base_vol):
    def fn(rng, d, prev_close):
        return random_session(rng, d, prev_close * math.exp(rng.gauss(0, 0.004)), sigma, base_vol)
    return fn


def stooq_csv(bars):
    lines = ["Date,Time,Open,High,Low,Close,Volume"]
    for t, o, h, l, c, v in bars:
        u = datetime.fromtimestamp(t, UTC)
        local = u + mc.warsaw_offset(u)
        lines.append("%s,%s,%.2f,%.2f,%.2f,%.2f,%d" % (local.strftime("%Y-%m-%d"), local.strftime("%H:%M:%S"),
                                                       o, h, l, c, v))
    return "\n".join(lines) + "\n"


def build_stocks():
    specs = [
        ("TSLA", "Tesla, Inc.", 60, 11, 318.0, 0.0031, 1.15e6, 359.40, tsla_today),
        ("NVDA", "NVIDIA Corporation", 60, 12, 168.0, 0.0024, 2.2e6, 182.40, nvda_today),
        ("PLTR", "Palantir Technologies Inc.", 5, 13, 178.0, 0.0029, 1.6e6, 181.70, pltr_today),
        ("AAPL", "Apple Inc.", 5, 14, 246.0, 0.0016, 0.8e6, 248.90, plain_today(0.0016, 0.8e6)),
        ("META", "Meta Platforms, Inc.", 5, 15, 702.0, 0.0019, 0.25e6, 707.30, plain_today(0.0019, 0.25e6)),
        ("AMD", "Advanced Micro Devices, Inc.", 5, 16, 233.0, 0.0026, 0.9e6, 236.80, amd_today),
    ]
    spark = {}
    for ticker, name, sessions, seed, start, sig, vol, prev, today_fn in specs:
        rng = random.Random(seed)
        # NVDA's history carries a synthetic opening-range follow-through (the demo's one GO case)
        bars = make_stock(ticker, sessions, rng, start, sig, vol, prev, today_fn,
                          orb_follow=0.6 if ticker == "NVDA" else 0.0)
        prev_close = [b for b in bars if mc.et_date(b[0]) < DEMO][-1][4]
        if ticker == "AMD":  # AMD is only on Stooq in the fixtures → exercises the fallback
            write("stooq/amd.us_5.csv", stooq_csv(bars))
        else:
            write("yahoo/chart/%s.json" % ticker, yahoo_chart(ticker, name, bars, prev_close))
        today = [b for b in bars if mc.et_date(b[0]) == DEMO]
        spark[ticker] = {"timestamp": [b[0] for b in today], "symbol": ticker, "dataGranularity": 300,
                         "close": [b[4] for b in today], "chartPreviousClose": prev_close,
                         "previousClose": prev_close}
    write("yahoo/spark.json", spark)


# --- crypto ---------------------------------------------------------------------------

def crypto_sigma(t):
    b = mc.crypto_bucket(t)
    s = {"asia": 0.00105, "europe": 0.00125, "us": 0.0016}[b]
    if datetime.fromtimestamp(t, UTC).weekday() >= 5:
        s *= 0.7
    return s


def gen_crypto(rng, start_t, end_t, start_px, base_vol, jump_p=0.002):
    bars, px, t = [], start_px, start_t
    while t < end_t:
        s = crypto_sigma(t)
        r = s * student_t(rng, 4)
        if rng.random() < jump_p:
            r += rng.gauss(0, 0.006)
        o = px
        c = o * math.exp(r)
        o, h, l, c = ohlc_from(rng, o, c, s)
        sess = {"asia": 0.8, "europe": 1.0, "us": 1.4}[mc.crypto_bucket(t)]
        v = base_vol * sess * math.exp(rng.gauss(0, 0.4)) * (1 + 40 * abs(r))
        bars.append([t, o, h, l, c, v])
        px = c
        t += 300
    return bars


def bounded_walk(rng, start_t, end_t, start_px, lo, hi, sigma, base_vol, cap_high=None):
    bars, px, t = [], start_px, start_t
    while t < end_t:
        c = px * math.exp(rng.gauss(0, sigma))
        if c > hi:
            c = hi - abs(rng.gauss(0, sigma * hi))
        if c < lo:
            c = lo + abs(rng.gauss(0, sigma * lo))
        o, h, l, c = ohlc_from(rng, px, c, sigma)
        if cap_high:
            h = min(h, cap_high - rng.uniform(5, 30))
            h = max(h, o, c)
        l = max(l, lo - 20) if lo else l
        sess = {"asia": 0.8, "europe": 1.0, "us": 1.4}[mc.crypto_bucket(t)]
        bars.append([t, o, h, l, c, base_vol * sess * math.exp(rng.gauss(0, 0.35))])
        px = c
        t += 300
    return bars


def binance_rows(bars, dp=2):
    rows = []
    for t, o, h, l, c, v in bars:
        o, h, l, c = fix_bar(o, h, l, c, dp)
        f = "%%.%df" % dp
        rows.append([t * 1000, f % o, f % h, f % l, f % c, "%.5f" % v, t * 1000 + 299999,
                     "%.2f" % (v * c), int(v * 30) + 1, "%.5f" % (v * 0.52), "%.2f" % (v * c * 0.52), "0"])
    return rows


def build_btc():
    rng = random.Random(21)
    start = utc(2026, 9, 21)
    day = utc(2026, 10, 20)
    hist = gen_crypto(rng, ts(start), ts(day), 61200.0, 85.0)
    hist = scale_bars(hist, 66950.0 / hist[-1][4])
    t0 = ts(day)
    # Asia 00:00–08:00: a bounded range, then pin the exact high and low
    asia = bounded_walk(rng, t0, t0 + 8 * 3600, 66950.0, 66640.0, 67380.0, 0.0010, 70.0)
    hi_i, lo_i = 39, 68  # 03:15 and 05:40 UTC
    asia[hi_i][2] = 67420.00
    asia[hi_i][4] = min(asia[hi_i][4], 67395.0)
    asia[lo_i][3] = 66612.40
    for i, b in enumerate(asia):
        if i != hi_i:
            b[2] = min(b[2], 67405.0)
        if i != lo_i:
            b[3] = max(b[3], 66630.0)
        b[2] = max(b[2], b[1], b[4])
        b[3] = min(b[3], b[1], b[4])
    # 08:00–14:35: below the Asia high
    mid = bounded_walk(rng, t0 + 8 * 3600, t0 + 14 * 3600 + 35 * 60, asia[-1][4], 66900.0, 67360.0, 0.0011, 85.0,
                       cap_high=67418.0)
    for b in mid[-10:]:
        b[5] *= 1.6
    last = mid[-1][4]
    trigger = [[t0 + 14 * 3600 + 35 * 60, last, 67489.00, min(last, 67330.50) - 4, 67448.60, 410.0]]
    tail_way = [(t0 + 16 * 3600 + 30 * 60, 67910.0), (t0 + 19 * 3600, 67640.0), (t0 + 22 * 3600, 68120.0),
                (t0 + 24 * 3600, 67980.0)]
    tail = scripted_after(rng, t0 + 14 * 3600 + 40 * 60, t0 + 86400, 67448.60, tail_way, 0.0011, 95.0, 288, 180)
    for b in tail:
        b[5] = 95.0 * math.exp(rng.gauss(0, 0.35))
    bars = hist + asia + mid + trigger + tail
    write("binance/klines/BTCUSDT_5m.json", binance_rows(bars))
    return bars


def build_alt(symbol, seed, start_px, base_vol, special=None):
    rng = random.Random(seed)
    start = utc(2026, 10, 17)
    end = utc(2026, 10, 21)
    bars = gen_crypto(rng, ts(start), ts(end), start_px, base_vol, 0.003)
    if special == "spike":  # ETH: volume spike on the 14:35 candle
        for b in bars:
            if b[0] == ts(utc(2026, 10, 20, 14, 35)):
                b[5] *= 7.5
                b[4] = b[1] * 1.006
                b[2] = max(b[2], b[4] * 1.001)
    if special == "vwap":  # SOL: lose UTC-day VWAP late morning, reclaim at 14:20 UTC
        day = [b for b in bars if utc(2026, 10, 20) <= datetime.fromtimestamp(b[0], UTC) < utc(2026, 10, 21)]
        for b in day:
            hm = datetime.fromtimestamp(b[0], UTC)
            if utc(2026, 10, 20, 12, 0) <= hm < utc(2026, 10, 20, 14, 20):
                k = (b[0] - ts(utc(2026, 10, 20, 12))) / 300.0
                factor = 1 - 0.0009 * min(k, 14)
                for j in (1, 2, 3, 4):
                    b[j] *= factor
            if hm == utc(2026, 10, 20, 14, 20):
                b[4] = b[1] * 1.012
                b[2] = b[4] * 1.002
                b[5] *= 3.0
    dp = 4 if start_px < 10 else 2
    write("binance/klines/%s_5m.json" % symbol, binance_rows(bars, dp))
    return bars


def build_crypto_misc(btc):
    last = {b[0]: b for b in btc}
    now_bar = last[ts(utc(2026, 10, 20, 14, 35))]
    tickers = []
    for sym, px, chg, vol in (("BTCUSDT", now_bar[4], 0.74, 18400.5), ("ETHUSDT", 2412.55, 1.9, 410233.2),
                              ("SOLUSDT", 152.31, 3.1, 2900110.0), ("XRPUSDT", 2.1844, -0.6, 98700221.0)):
        tickers.append({"symbol": sym, "priceChange": "%.2f" % (px * chg / 100), "priceChangePercent": "%.3f" % chg,
                        "lastPrice": "%.4f" % px, "openPrice": "%.4f" % (px / (1 + chg / 100)),
                        "highPrice": "%.4f" % (px * 1.012), "lowPrice": "%.4f" % (px * 0.985),
                        "volume": "%.4f" % vol, "quoteVolume": "%.2f" % (vol * px),
                        "openTime": ts(utc(2026, 10, 19, 14, 40)) * 1000, "closeTime": ts(utc(2026, 10, 20, 14, 40)) * 1000})
    write("binance/ticker24hr.json", tickers)
    filt = lambda tick, step, mn: [  # noqa: E731
        {"filterType": "PRICE_FILTER", "minPrice": tick, "maxPrice": "1000000.00000000", "tickSize": tick},
        {"filterType": "LOT_SIZE", "minQty": step, "maxQty": "9000.00000000", "stepSize": step},
        {"filterType": "NOTIONAL", "minNotional": mn, "applyMinToMarket": True}]
    write("binance/exchangeInfo.json", {"timezone": "UTC", "symbols": [
        {"symbol": "BTCUSDT", "status": "TRADING", "baseAsset": "BTC", "quoteAsset": "USDT",
         "filters": filt("0.01000000", "0.00001000", "5.00000000")},
        {"symbol": "ETHUSDT", "status": "TRADING", "baseAsset": "ETH", "quoteAsset": "USDT",
         "filters": filt("0.01000000", "0.00010000", "5.00000000")},
        {"symbol": "SOLUSDT", "status": "TRADING", "baseAsset": "SOL", "quoteAsset": "USDT",
         "filters": filt("0.01000000", "0.00100000", "5.00000000")},
        {"symbol": "XRPUSDT", "status": "TRADING", "baseAsset": "XRP", "quoteAsset": "USDT",
         "filters": filt("0.00010000", "0.10000000", "5.00000000")}]})
    write("binance_futures/premiumIndex.json", [
        {"symbol": "BTCUSDT", "markPrice": "67452.10", "indexPrice": "67449.80", "lastFundingRate": "0.00012000",
         "nextFundingTime": ts(utc(2026, 10, 20, 16)) * 1000, "interestRate": "0.00010000", "time": 0},
        {"symbol": "ETHUSDT", "markPrice": "2412.90", "indexPrice": "2412.10", "lastFundingRate": "0.00094000",
         "nextFundingTime": ts(utc(2026, 10, 20, 16)) * 1000, "interestRate": "0.00010000", "time": 0},
        {"symbol": "SOLUSDT", "markPrice": "152.33", "indexPrice": "152.30", "lastFundingRate": "-0.00061000",
         "nextFundingTime": ts(utc(2026, 10, 20, 16)) * 1000, "interestRate": "0.00010000", "time": 0}])
    rows = []
    t = ts(utc(2026, 10, 20, 8))
    oi = 81250.0
    rng = random.Random(5)
    while t <= ts(utc(2026, 10, 20, 22)):
        hm = datetime.fromtimestamp(t, UTC)
        growth = 0.0035 if utc(2026, 10, 20, 13, 30) <= hm <= utc(2026, 10, 20, 14, 40) else 0.0002
        oi *= 1 + growth + rng.gauss(0, 0.0004)
        rows.append({"symbol": "BTCUSDT", "sumOpenInterest": "%.3f" % oi,
                     "sumOpenInterestValue": "%.2f" % (oi * 67300), "timestamp": t * 1000})
        t += 300
    write("binance_futures/openInterestHist_BTCUSDT.json", rows)
    # Coinbase / Kraken fallbacks: the last 2 days of BTC in their own formats
    recent = [b for b in btc if b[0] >= ts(utc(2026, 10, 19))]
    write("coinbase/candles_BTC-USD_300.json",
          [[b[0], round(b[3], 2), round(b[2], 2), round(b[1], 2), round(b[4], 2), round(b[5] * 0.4, 6)]
           for b in reversed(recent)])
    write("coinbase/product_BTC-USD.json", {"id": "BTC-USD", "base_currency": "BTC", "quote_currency": "USD",
                                            "quote_increment": "0.01", "base_increment": "0.00000001",
                                            "min_market_funds": "1", "status": "online"})
    # venue prices differ a little, like they do in real life (used by the arbitrage gap monitor)
    write("coinbase/ticker_BTC-USD.json", {"price": "%.2f" % (now_bar[4] * 1.0007), "volume": "8123.4",
                                           "time": "2026-10-20T14:40:00Z"})
    write("coinbase/stats_BTC-USD.json", {"open": "66980.10", "high": "67600.00", "low": "66500.00",
                                          "last": "%.2f" % now_bar[4], "volume": "8123.4"})
    kr = [[b[0], "%.1f" % b[1], "%.1f" % b[2], "%.1f" % b[3], "%.1f" % b[4], "%.1f" % b[4], "%.8f" % (b[5] * 0.2), 120]
          for b in btc[-720:]]
    write("kraken/ohlc_XBTUSDT_5.json", {"error": [], "result": {"XBTUSDT": kr, "last": btc[-1][0]}})
    write("kraken/ticker_XBTUSDT.json", {"error": [], "result": {"XBTUSDT": {
        "c": ["%.1f" % (now_bar[4] * 0.99955), "0.01"], "o": "66980.1", "v": ["1200.1", "3100.4"]}}})
    write("kraken/ticker_USDTUSD.json", {"error": [], "result": {"USDTZUSD": {
        "c": ["0.99970", "120.0"], "o": "0.99980", "v": ["9100000.0", "21000000.0"]}}})
    coins = [("tether", "usdt", "Tether", 1.0, 183e9, 51e9), ("bitcoin", "btc", "Bitcoin", now_bar[4], 1.33e12, 38e9),
             ("ethereum", "eth", "Ethereum", 2412.55, 290e9, 21e9), ("usd-coin", "usdc", "USDC", 1.0, 74e9, 9e9),
             ("solana", "sol", "Solana", 152.31, 82e9, 6.1e9), ("ripple", "xrp", "XRP", 2.1844, 128e9, 4.4e9),
             ("dogecoin", "doge", "Dogecoin", 0.1931, 28e9, 2.1e9), ("binancecoin", "bnb", "BNB", 1012.4, 141e9, 1.9e9),
             ("wrapped-bitcoin", "wbtc", "Wrapped Bitcoin", now_bar[4], 9e9, 0.4e9),
             ("cardano", "ada", "Cardano", 0.6123, 22e9, 0.9e9)]
    write("coingecko/markets.json", [
        {"id": i, "symbol": s, "name": n, "current_price": p, "market_cap": mcap, "total_volume": vol,
         "price_change_percentage_24h": 1.1, "market_cap_rank": k + 1}
        for k, (i, s, n, p, mcap, vol) in enumerate(coins)])


# --- meme coins ----------------------------------------------------------------------------

def build_pupkin():
    rng = random.Random(31)
    tok = TOKENS["PUPKIN"]
    t0 = ts(utc(2026, 10, 18, 4, 10))
    t_end = ts(utc(2026, 10, 20, 20, 0))
    trigger_t = ts(utc(2026, 10, 20, 15, 50))
    way = [(t0 + 6 * 3600, 0.0061), (t0 + 20 * 3600, 0.0033), (ts(utc(2026, 10, 19, 12)), 0.0039),
           (ts(utc(2026, 10, 20, 0)), 0.0036), (ts(utc(2026, 10, 20, 9)), 0.0042), (trigger_t, 0.00438)]
    bars, px, t = [], 0.00041, t0
    while t < trigger_t:
        age_h = (t - t0) / 3600.0
        sigma = 0.012 + 0.05 * math.exp(-age_h / 5.0)
        for (a, pa), (b, pb) in zip([(t0, 0.00041)] + way, way):
            if a <= t < b:
                goal = pa * (pb / pa) ** ((t + 300 - a) / float(b - a))
                break
        c = goal * math.exp(sigma * student_t(rng, 3) * 0.6)
        if t >= ts(utc(2026, 10, 20, 14, 50)):  # tight coil just under 0.00452 before the breakout
            c = min(max(c, 0.00428), 0.00446)
        o, h, l, c = ohlc_from(rng, px, c, sigma * 0.5)
        if t >= ts(utc(2026, 10, 20, 14, 50)):
            h = min(h, 0.004515)
        v = (9000 + 160000 * math.exp(-age_h / 6.0)) * math.exp(rng.gauss(0, 0.45))
        bars.append([t, o, h, l, c, v])
        px = c
        t += 300
    bars.append([trigger_t, px, 0.004801, px * 0.998, 0.004712, 36500.0])
    tail = scripted_after(rng, trigger_t + 300, t_end, 0.004712, [(t_end, 0.00489)], 0.012, 11000, 288, 200)
    for b in tail:
        b[5] = 11000 * math.exp(rng.gauss(0, 0.4))
    bars += tail
    rows = [[b[0]] + [float("%.9g" % x) for x in (b[1], max(b[2], b[1], b[4]), min(b[3], b[1], b[4]), b[4])]
            + [round(b[5], 2)] for b in bars]
    rows.sort(key=lambda r: -r[0])  # GeckoTerminal is newest first
    meta = {"base": {"name": tok["name"], "symbol": "PUPKIN", "coingecko_coin_id": None, "address": tok["address"]},
            "quote": {"name": "Wrapped SOL", "symbol": "SOL", "coingecko_coin_id": "wrapped-solana",
                      "address": "So11111111111111111111111111111111111111112"}}
    write("geckoterminal/ohlcv_solana_%s_minute5.json" % tok["pool"],
          {"data": {"id": "fixture", "type": "ohlcv_request_response", "attributes": {"ohlcv_list": rows}},
           "meta": meta})
    return bars


def ds_pair(chain, dex, tok_key, pool, price, liq, vol, txns, change, created, fdv, boosts=0, socials=True,
            quote=("So11111111111111111111111111111111111111112", "Wrapped SOL", "SOL")):
    tok = TOKENS[tok_key]
    info = {"imageUrl": "https://cdn.dexscreener.com/cms/images/fixture-%s" % tok_key.lower()}
    if socials:
        info["websites"] = [{"url": "https://%s.example" % tok_key.lower(), "label": "Website"}]
        info["socials"] = [{"type": "twitter", "url": "https://x.com/%s_fixture" % tok_key.lower()},
                           {"type": "telegram", "url": "https://t.me/%s_fixture" % tok_key.lower()}]
    return {"chainId": chain, "dexId": dex, "url": "https://dexscreener.com/%s/%s" % (chain, pool.lower()),
            "pairAddress": pool, "labels": [],
            "baseToken": {"address": tok["address"], "name": tok["name"], "symbol": tok_key},
            "quoteToken": {"address": quote[0], "name": quote[1], "symbol": quote[2]},
            "priceNative": "%.9g" % (price / 152.3), "priceUsd": "%.9g" % price,
            "txns": {k: {"buys": b, "sells": s} for k, (b, s) in txns.items()},
            "volume": vol, "priceChange": change,
            "liquidity": {"usd": liq, "base": round(liq / 2 / price), "quote": round(liq / 2 / 152.3, 4)},
            "fdv": fdv, "marketCap": fdv, "pairCreatedAt": created * 1000, "info": info,
            "boosts": {"active": boosts}}


def build_dex():
    p, m, n, f = TOKENS["PUPKIN"], TOKENS["MLAMBO"], TOKENS["NEWT"], TOKENS["OLDFROG"]
    weth = ("0x4200000000000000000000000000000000000006", "Wrapped Ether", "WETH")
    pairs = [
        ds_pair("solana", "raydium", "PUPKIN", p["pool"], 0.004712, 412350.0,
                {"h24": 3104220.5, "h6": 690110.2, "h1": 121004.3, "m5": 36500.0},
                {"m5": (140, 51), "h1": (1310, 702), "h6": (6120, 4410), "h24": (24110, 17920)},
                {"m5": 5.4, "h1": 6.2, "h6": 9.8, "h24": 18.4}, ts(utc(2026, 10, 18, 4, 10)), 4712000, 500),
        ds_pair("solana", "meteora", "PUPKIN", p["pool2"], 0.004705, 18120.0,
                {"h24": 120330.0, "h6": 22100.0, "h1": 3100.0, "m5": 410.0},
                {"m5": (4, 3), "h1": (40, 31), "h6": (210, 190), "h24": (900, 840)},
                {"m5": 5.0, "h1": 6.0, "h6": 9.1, "h24": 18.0}, ts(utc(2026, 10, 18, 9, 0)), 4705000),
        ds_pair("solana", "pumpswap", "MLAMBO", m["pool"], 0.000918, 61200.0,
                {"h24": 2894100.0, "h6": 2401000.0, "h1": 801220.0, "m5": 71200.0},
                {"m5": (260, 41), "h1": (2210, 380), "h6": (9800, 2100), "h24": (11200, 2600)},
                {"m5": 7.9, "h1": 48.0, "h6": 410.0, "h24": 912.0}, ts(utc(2026, 10, 20, 9, 20)), 918000, 1200),
        ds_pair("base", "aerodrome", "NEWT", n["pool"], 0.0000412, 38500.0,
                {"h24": 210400.0, "h6": 210400.0, "h1": 188300.0, "m5": 12100.0},
                {"m5": (61, 22), "h1": (640, 210), "h6": (700, 230), "h24": (700, 230)},
                {"m5": 3.1, "h1": 240.0, "h6": 260.0, "h24": 260.0}, ts(utc(2026, 10, 20, 15, 20)), 412000, 0,
                socials=False, quote=weth),
        ds_pair("ethereum", "uniswap", "OLDFROG", f["pool"], 0.00000071, 1910000.0,
                {"h24": 880000.0, "h6": 120000.0, "h1": 20100.0, "m5": 900.0},
                {"m5": (3, 2), "h1": (88, 70), "h6": (420, 380), "h24": (1900, 1700)},
                {"m5": 0.1, "h1": -0.5, "h6": 1.2, "h24": -2.1}, ts(utc(2024, 3, 1)), 298000000, 0,
                quote=("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "Wrapped Ether", "WETH")),
    ]
    write("dexscreener/pairs.json", pairs)

    def entry(tk, amount=None, desc=""):
        t = TOKENS[tk]
        d = {"url": "https://dexscreener.com/%s/%s" % (t["chain"], t["address"].lower()), "chainId": t["chain"],
             "tokenAddress": t["address"], "description": desc,
             "icon": "fixture-%s" % tk.lower(), "links": [{"type": "twitter", "url": "https://x.com/%s_fixture" % tk.lower()}]}
        if amount is not None:
            d.update(amount=amount, totalAmount=amount)
        return d
    write("dexscreener/token_boosts_top.json", [entry("MLAMBO", 1200, "to the moon"), entry("PUPKIN", 500, "a very good pup"),
                                                entry("OLDFROG", 300, "the original")])
    write("dexscreener/token_boosts_latest.json", [entry("PUPKIN", 100)])
    write("dexscreener/token_profiles_latest.json", [entry("NEWT", None, "just launched on Base"),
                                                     entry("PUPKIN", None, "a very good pup")])


def rugcheck_report(tok_key, holders, lp_locked_pct, risks, score_norm, liquidity, creator, creator_balance=0,
                    mint=None, freeze=None, total_holders=1000):
    t = TOKENS[tok_key]
    supply = 1_000_000_000 * 10 ** 6
    top = []
    for addr, owner, pct, insider in holders:
        amt = int(supply * pct / 100)
        top.append({"address": addr, "amount": amt, "decimals": 6, "pct": pct, "uiAmount": amt / 1e6,
                    "uiAmountString": "%.6f" % (amt / 1e6), "owner": owner, "insider": insider})
    return {
        "mint": t["address"], "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "creator": creator,
        "creatorBalance": creator_balance,
        "token": {"mintAuthority": mint, "supply": supply, "decimals": 6, "isInitialized": True, "freezeAuthority": freeze},
        "tokenMeta": {"name": t["name"], "symbol": tok_key, "uri": "", "mutable": False,
                      "updateAuthority": "11111111111111111111111111111111"},
        "topHolders": top, "freezeAuthority": freeze, "mintAuthority": mint, "risks": risks,
        "score": int(score_norm * 120), "score_normalised": score_norm,
        "knownAccounts": {t["pool"]: {"name": "Raydium AMM" if tok_key == "PUPKIN" else "Pump Fun AMM", "type": "AMM"},
                          creator: {"name": "Creator", "type": "CREATOR"}},
        "markets": [{"pubkey": t["pool"], "marketType": "raydium" if tok_key == "PUPKIN" else "pump_amm",
                     "mintA": t["address"], "mintB": "So11111111111111111111111111111111111111112",
                     "lp": {"baseMint": t["address"], "quoteMint": "So11111111111111111111111111111111111111112",
                            "quoteUSD": liquidity / 2, "baseUSD": liquidity / 2, "lpLockedPct": lp_locked_pct,
                            "lpLockedUSD": liquidity * lp_locked_pct / 100.0}}],
        "totalMarketLiquidity": liquidity, "totalHolders": total_holders, "rugged": False,
        "transferFee": {"pct": 0, "maxAmount": 0, "authority": "11111111111111111111111111111111"},
        "detectedAt": "2026-10-18T04:11:02Z",
    }


def build_safety():
    p, m, n = TOKENS["PUPKIN"], TOKENS["MLAMBO"], TOKENS["NEWT"]
    wallets = [b58("pupkin-holder-%d" % i, 44) for i in range(12)]
    pup_holders = [(b58("pupkin-pool-vault", 44), p["pool"], 9.8, False)] + [
        (wallets[i], b58("pupkin-owner-%d" % i, 44), pct, False)
        for i, pct in enumerate([3.1, 2.4, 2.2, 1.9, 1.7, 1.5, 1.4, 1.3, 1.2, 1.1])]
    write("rugcheck/%s.json" % p["address"], rugcheck_report(
        "PUPKIN", pup_holders, 100.0,
        [{"name": "Low amount of LP Providers", "value": "", "description": "Only a few users are providing liquidity",
          "score": 400, "level": "warn"}],
        3, 412350.0, b58("pupkin-creator", 44), 0, total_holders=8412))
    mw = [b58("mlambo-holder-%d" % i, 44) for i in range(12)]
    ml_holders = [(b58("mlambo-pool-vault", 44), m["pool"], 14.0, False), (WHALE_MLAMBO, WHALE_MLAMBO, 40.0, True)] + [
        (mw[i], mw[i], pct, False) for i, pct in enumerate([4.2, 3.1, 2.0, 1.4, 1.0, 0.9, 0.8, 0.7, 0.6])]
    write("rugcheck/%s.json" % m["address"], rugcheck_report(
        "MLAMBO", ml_holders, 0.0,
        [{"name": "Large Amount of LP Unlocked", "value": "100.00%",
          "description": "A large amount of LP tokens are unlocked, allowing the owner to remove liquidity at any point.",
          "score": 10999, "level": "danger"},
         {"name": "Single holder ownership", "value": "40.00%",
          "description": "One user holds a large amount of the token supply", "score": 4000, "level": "danger"}],
        78, 61200.0, CREATOR_MLAMBO, 0, total_holders=1290))
    write("honeypot/8453_%s.json" % n["address"].lower(), {
        "token": {"name": n["name"], "symbol": "NEWT", "decimals": 18, "address": n["address"], "totalHolders": 412},
        "withToken": {"name": "Wrapped Ether", "symbol": "WETH", "decimals": 18,
                      "address": "0x4200000000000000000000000000000000000006"},
        "summary": {"risk": "medium", "riskLevel": 2, "flags": [{"flag": "closed_source", "description": "contract not verified"}]},
        "simulationSuccess": True, "honeypotResult": {"isHoneypot": False},
        "simulationResult": {"buyTax": 0, "sellTax": 4.0, "transferTax": 0, "buyGas": "151216", "sellGas": "105214"},
        "contractCode": {"openSource": False, "rootOpenSource": False, "isProxy": False, "hasProxyCalls": False},
        "chain": {"id": "8453", "name": "Base", "shortName": "base", "currency": "ETH"},
        "pair": {"pair": {"name": "Aerodrome: NEWT-WETH", "address": n["pool"]}, "liquidity": 38500.0},
        "pairAddress": n["pool"]})
    supply = 10 ** 27
    holders = [(n["pool"], 22.0, True), (evm("newt-deployer"), 8.0, False)] + [
        (evm("newt-holder-%d" % i), pct, False) for i, pct in enumerate([3.5, 2.9, 2.6, 2.2, 2.0, 1.8, 1.6, 1.4, 1.2])]
    write("honeypot/topholders_8453_%s.json" % n["address"].lower(), {
        "totalSupply": str(supply),
        "holders": [{"address": a, "balance": str(int(supply * pct / 100)), "alias": "", "isContract": c}
                    for a, pct, c in holders]})


# --- news ----------------------------------------------------------------------------------

def rss(title, items):
    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<rss version="2.0"><channel>', "<title>%s</title>" % title]
    for t, link, when, desc in items:
        out.append("<item><title><![CDATA[%s]]></title><link>%s</link><guid isPermaLink=\"false\">%s</guid>"
                   "<pubDate>%s</pubDate><description><![CDATA[%s]]></description></item>"
                   % (t, link, hashlib.sha1(link.encode()).hexdigest()[:12], when, desc))
    out.append("</channel></rss>")
    return "\n".join(out)


def build_news():
    write("rss/yahoo_TSLA.xml", rss("Yahoo! Finance: TSLA News", [
        ("Tesla–SpaceX merger mania strikes Wall Street ahead of earnings",
         "https://finance.yahoo.com/news/fixture-tesla-spacex-merger-mania.html", "Tue, 20 Oct 2026 13:05:00 +0000",
         "Shares rise before the bell on reports the two companies are exploring a combination; Q3 results are due Wednesday after the close."),
        ("Tesla Q3 earnings preview: 3 key things to watch",
         "https://finance.yahoo.com/news/fixture-tesla-q3-preview.html", "Tue, 20 Oct 2026 11:40:00 +0000",
         "Deliveries, margins and robotaxi timelines are in focus into Wednesday's report."),
        ("Options traders brace for a big Tesla move into earnings",
         "https://finance.yahoo.com/news/fixture-tesla-options-implied-move.html", "Mon, 19 Oct 2026 21:10:00 +0000",
         "Implied volatility points to a move of roughly 8% either way after the report."),
        ("EV stocks mixed as investors weigh rate path",
         "https://finance.yahoo.com/news/fixture-ev-stocks-mixed.html", "Fri, 16 Oct 2026 14:00:00 +0000",
         "A quiet session for the group."),
    ]))
    write("rss/google_TSLA.xml", rss("TSLA stock - Google News", [
        ("Tesla–SpaceX merger mania strikes Wall Street ahead of earnings - Fixture Wire",
         "https://news.example/fixture-1", "Tue, 20 Oct 2026 13:12:00 +0000", ""),
        ("Tesla shares climb as SpaceX deal chatter builds - Fixture Markets",
         "https://news.example/fixture-2", "Tue, 20 Oct 2026 13:58:00 +0000", ""),
    ]))
    write("rss/coindesk.xml", rss("CoinDesk", [
        ("Bitcoin ETFs pull in $1.2B as BTC presses against $67K",
         "https://www.coindesk.com/markets/fixture-btc-etf-inflows", "Tue, 20 Oct 2026 13:50:00 +0000",
         "Spot bitcoin ETFs logged their biggest inflow day in a month as BTC tested its overnight high."),
        ("Large exchange to list SOL perpetual futures next week",
         "https://www.coindesk.com/markets/fixture-sol-perps-listing", "Tue, 20 Oct 2026 10:15:00 +0000",
         "The new listing goes live Monday."),
        ("DeFi lender drained of $41M in oracle exploit",
         "https://www.coindesk.com/tech/fixture-defi-exploit", "Tue, 20 Oct 2026 06:40:00 +0000",
         "An attacker manipulated a price feed to borrow against inflated collateral."),
    ]))
    write("rss/cointelegraph.xml", rss("Cointelegraph", [
        ("SEC delays decision on spot XRP ETF applications",
         "https://cointelegraph.com/news/fixture-sec-xrp-etf-delay", "Tue, 20 Oct 2026 12:30:00 +0000",
         "The agency extended its review window by 45 days."),
        ("Token unlock: 92M ARB enters circulation next week",
         "https://cointelegraph.com/news/fixture-arb-unlock", "Mon, 19 Oct 2026 18:00:00 +0000",
         "Scheduled unlock worth roughly 2% of supply."),
    ]))
    write("rss/theblock.xml", rss("The Block", [
        ("Exchange to delist three low-liquidity spot pairs",
         "https://www.theblock.co/post/fixture-delisting", "Tue, 20 Oct 2026 09:00:00 +0000",
         "Trading in the affected pairs ends on Friday."),
        ("Fed minutes show officials split on a December cut",
         "https://www.theblock.co/post/fixture-fed-minutes", "Tue, 20 Oct 2026 14:05:00 +0000",
         "Risk assets wobbled briefly on the release."),
    ]))
    write("sec/8k_0001318605.atom", """<?xml version="1.0" encoding="ISO-8859-1" ?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>TESLA, INC.  (0001318605)</title>
<entry>
<category label="form type" scheme="https://www.sec.gov/" term="8-K" />
<content type="text/xml">
<accession-number>0001628280-26-071111</accession-number>
<filing-date>2026-10-20</filing-date>
<filing-href>https://www.sec.gov/Archives/edgar/data/1318605/fixture-0001628280-26-071111-index.htm</filing-href>
<filing-type>8-K</filing-type>
<form-name>Current report</form-name>
<items-desc>items 7.01 and 9.01</items-desc>
</content>
<link href="https://www.sec.gov/Archives/edgar/data/1318605/fixture-0001628280-26-071111-index.htm" rel="alternate" type="text/html" />
<summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; 2026-10-20 &lt;b&gt;AccNo:&lt;/b&gt; 0001628280-26-071111 &lt;b&gt;Size:&lt;/b&gt; 210 KB</summary>
<title>8-K  - Current report</title>
<updated>2026-10-20T07:31:02-04:00</updated>
</entry>
<entry>
<category label="form type" scheme="https://www.sec.gov/" term="8-K" />
<content type="text/xml">
<accession-number>0001628280-26-064366</accession-number>
<filing-date>2026-10-02</filing-date>
<filing-href>https://www.sec.gov/Archives/edgar/data/1318605/fixture-0001628280-26-064366-index.htm</filing-href>
<filing-type>8-K</filing-type>
<form-name>Current report</form-name>
<items-desc>items 2.02 and 9.01</items-desc>
</content>
<link href="https://www.sec.gov/Archives/edgar/data/1318605/fixture-0001628280-26-064366-index.htm" rel="alternate" type="text/html" />
<title>8-K  - Current report</title>
<updated>2026-10-02T16:05:11-04:00</updated>
</entry>
</feed>
""")
    tickers = [(1318605, "Tesla, Inc.", "TSLA", "Nasdaq"), (1045810, "NVIDIA CORP", "NVDA", "Nasdaq"),
               (320193, "Apple Inc.", "AAPL", "Nasdaq"), (2488, "ADVANCED MICRO DEVICES INC", "AMD", "Nasdaq"),
               (1326801, "Meta Platforms, Inc.", "META", "Nasdaq"), (1321655, "Palantir Technologies Inc.", "PLTR", "Nasdaq"),
               (789019, "MICROSOFT CORP", "MSFT", "Nasdaq"), (1018724, "AMAZON COM INC", "AMZN", "Nasdaq"),
               (1652044, "Alphabet Inc.", "GOOGL", "Nasdaq"), (1065280, "NETFLIX INC", "NFLX", "Nasdaq"),
               (50863, "INTEL CORP", "INTC", "Nasdaq"), (1730168, "Broadcom Inc.", "AVGO", "Nasdaq"),
               (858877, "CISCO SYSTEMS, INC.", "CSCO", "Nasdaq"), (19617, "JPMORGAN CHASE & CO", "JPM", "NYSE"),
               (70858, "BANK OF AMERICA CORP", "BAC", "NYSE"), (34088, "EXXON MOBIL CORP", "XOM", "NYSE"),
               (104169, "Walmart Inc.", "WMT", "NYSE"), (200406, "JOHNSON & JOHNSON", "JNJ", "NYSE"),
               (1403161, "VISA INC.", "V", "NYSE"), (1141391, "Mastercard Inc", "MA", "NYSE"),
               (66740, "3M CO", "MMM", "NYSE"), (18230, "CATERPILLAR INC", "CAT", "NYSE"),
               (12927, "BOEING CO", "BA", "NYSE"), (40545, "GENERAL ELECTRIC CO", "GE", "NYSE"),
               (1679788, "Coinbase Global, Inc.", "COIN", "Nasdaq"), (1559720, "Airbnb, Inc.", "ABNB", "Nasdaq"),
               (1543151, "Uber Technologies, Inc.", "UBER", "NYSE"), (1467623, "Dropbox, Inc.", "DBX", "Nasdaq"),
               (1108524, "Salesforce, Inc.", "CRM", "NYSE"), (1373715, "ServiceNow, Inc.", "NOW", "NYSE"),
               (99999991, "SOME OTC CO", "OTCZ", "OTC")]
    write("sec/company_tickers_exchange.json", {"fields": ["cik", "name", "ticker", "exchange"],
                                                 "data": [list(t) for t in tickers]})
    write("nasdaq/nasdaqlisted.txt", "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares\n"
          "TSLA|Tesla, Inc. - Common Stock|Q|N|N|100|N|N\nNVDA|NVIDIA Corporation - Common Stock|Q|N|N|100|N|N\n"
          "QQQ|Invesco QQQ Trust|G|N|N|100|Y|N\nZZZT|Test Issue|Q|Y|N|100|N|N\n"
          "File Creation Time: 1020202608:01|||||||\n")
    write("nasdaq/otherlisted.txt", "ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol\n"
          "JPM|JPMorgan Chase & Co. Common Stock|N|JPM|N|100|N|JPM\nBRK.B|Berkshire Hathaway Class B|N|BRK.B|N|100|N|BRK=B\n"
          "File Creation Time: 1020202608:01|||||||\n")


def main():
    build_stocks()
    btc = build_btc()
    build_alt("ETHUSDT", 22, 2380.0, 1900.0, "spike")
    build_alt("SOLUSDT", 23, 149.0, 21000.0, "vwap")
    build_alt("XRPUSDT", 24, 2.19, 2.1e6)
    build_crypto_misc(btc)
    build_pupkin()
    build_dex()
    build_safety()
    build_news()
    manifest = {
        "about": "Synthetic offline fixtures for the Trader skill pack — not real market data.",
        "default_now": "2026-10-20T20:00:00Z",
        "demos": {
            "tsla": {"symbol": "TSLA", "now": "2026-10-20T14:15:00Z", "after_close": "2026-10-20T20:05:00Z"},
            "btc": {"symbol": "BTC-USD", "now": "2026-10-20T14:40:00Z", "later": "2026-10-20T18:45:00Z"},
            "meme": {"symbol": "SOL:" + TOKENS["PUPKIN"]["address"], "now": "2026-10-20T15:55:00Z",
                     "later": "2026-10-20T19:55:00Z"},
        },
        "tokens": {k: {"chain": v["chain"], "address": v["address"], "pool": v["pool"], "name": v["name"]}
                   for k, v in TOKENS.items()},
    }
    (HERE / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("fixtures written to", OUT)


if __name__ == "__main__":
    main()
