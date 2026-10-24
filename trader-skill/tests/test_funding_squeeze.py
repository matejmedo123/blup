"""funding_squeeze: shorts crowded into an uptrend — the rule, its exit, the funding source and its plumbing."""
from __future__ import annotations

import io
import json
import os
import zipfile
from unittest import mock

from shared import funding, setups
from shared.indicators import Candle
from tests.helpers import TraderTestCase, load

DAY = 86400
T0 = 1767225600  # 2026-01-01


def series(n=260, start=100.0, step=0.4):
    """A steady uptrend: every close above its 50-day average."""
    out, px = [], start
    for k in range(n):
        px += step
        out.append(Candle(T0 + k * DAY, px - 0.2, px + 1.0, px - 1.0, px, 1000.0))
    return out


class TheRule(TraderTestCase):
    def test_fires_only_when_three_days_of_funding_average_below_minus_ten_percent(self):
        c = series()
        last = c[-1].t // DAY
        hot = {last: -0.20, last - 1: -0.12, last - 2: -0.05}         # mean −12.3 %
        mild = {last: -0.08, last - 1: -0.09, last - 2: -0.10}        # mean −9 %
        hit = [s for s in setups.series_signals("funding_squeeze", c, "1d", context={"funding": hot})
               if s["trigger"]["index"] == len(c) - 1]
        self.assertEqual(len(hit), 1)
        self.assertIn("-12 %/yr", hit[0]["rule"])
        self.assertAlmostEqual(hit[0]["levels"]["funding3"], (-0.20 - 0.12 - 0.05) / 3)
        for ctx in ({"funding": mild}, {"funding": {last: -0.5, last - 1: -0.5}}, {}, None):
            self.assertFalse([s for s in setups.series_signals("funding_squeeze", c, "1d", context=ctx)
                              if s["trigger"]["index"] == len(c) - 1], ctx)

    def test_never_below_the_fifty_day_average(self):
        c = series()
        c = c[:-1] + [Candle(c[-1].t, 50.0, 51.0, 49.0, 50.0, 1000.0)]  # a crash below the 50-day average
        last = c[-1].t // DAY
        ctx = {"funding": {last - k: -0.5 for k in range(3)}}
        self.assertFalse([s for s in setups.series_signals("funding_squeeze", c, "1d", context=ctx)
                          if s["trigger"]["index"] == len(c) - 1])

    def test_exit_is_a_close_below_the_twenty_day_average_and_the_stop_three_atr(self):
        rule = setups.exit_rule("funding_squeeze")
        self.assertEqual((rule["type"], rule["n"], rule["max_bars"]), ("close_below_sma", 20, 20))
        closes = [100.0] * 25 + [99.0]
        self.assertTrue(setups.rule_says_exit(rule, closes, len(closes) - 1))
        self.assertFalse(setups.rule_says_exit(rule, [100.0] * 25 + [101.0], 25))
        c = series()
        self.assertAlmostEqual(setups.rule_stop("funding_squeeze", c, len(c) - 1, {}, 2.0), c[-1].c - 6.0)
        self.assertFalse(setups.SETUPS["funding_squeeze"].get("needs_btc"), "no Bitcoin regime: it trades bears too")


def _archive(rows) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("X.csv", "calc_time,funding_interval_hours,last_funding_rate\n" +
                   "".join("%d,%d,%s\n" % r for r in rows))
    return buf.getvalue()


class TheSource(TraderTestCase):
    def setUp(self):
        super().setUp()
        os.environ.pop("TRADER_OFFLINE", None)  # the downloads are faked below
        funding._memo.clear()

    def test_archive_months_annualised_by_their_interval_and_cached_for_good(self):
        now = T0 + 40 * DAY  # 10 Feb 2026: January is a complete month
        jan = [(int((T0 + h * 3600) * 1000), 8, "0.0001") for h in (0, 8, 16)] + \
              [(int((T0 + DAY + h * 3600) * 1000), 4, "-0.0002") for h in (0, 4)]
        calls = []

        def fake_download(url):
            calls.append(url)
            return _archive(jan) if "2026-01" in url and "/BTCUSDT/" in url else None
        with mock.patch.object(funding, "_download", side_effect=fake_download), \
                mock.patch.object(funding, "_recent_binance", return_value={}), \
                mock.patch.object(funding, "_recent_kraken", return_value={str(now // DAY - 1): -0.3}):
            d = funding.daily("BTC", days=45, now_ts=now)
            self.assertAlmostEqual(d[T0 // DAY], 0.0001 * 3 * 365)
            self.assertAlmostEqual(d[T0 // DAY + 1], -0.0002 * 8760 / 4)
            self.assertEqual(d[now // DAY - 1], -0.3)
            self.assertEqual(funding.source_of("BTC"), "kraken")
            n = len(calls)
            funding._memo.clear()
            funding.daily("BTC", days=45, now_ts=now)
            self.assertEqual(len(calls), n, "a month in the cache is never downloaded again")

    def test_binance_first_kraken_only_when_binance_does_not_answer(self):
        now = T0 + 10 * DAY
        with mock.patch.object(funding, "_download", return_value=None), \
                mock.patch.object(funding, "_recent_binance", return_value={str(now // DAY): 0.05}), \
                mock.patch.object(funding, "_recent_kraken", side_effect=AssertionError("not needed")):
            self.assertEqual(funding.daily("ETH", days=20, now_ts=now)[now // DAY], 0.05)
            self.assertEqual(funding.source_of("ETH"), "binance")

    def test_offline_and_unknown_coins_have_no_funding(self):
        os.environ["TRADER_OFFLINE"] = "1"
        self.assertEqual(funding.daily("BTC", days=30), {})
        self.assertEqual(funding.daily("", days=30), {})

    def test_mean_needs_all_three_days(self):
        t = T0 + 5 * DAY
        d = {t // DAY: -0.3, t // DAY - 1: -0.3, t // DAY - 2: 0.0}
        self.assertAlmostEqual(funding.mean(d, t), -0.2)
        self.assertIsNone(funding.mean({t // DAY: -0.3}, t))


class ThePlumbing(TraderTestCase):
    def test_the_lab_hands_each_coin_its_own_funding(self):
        lab = load("trader-backtest", "lab")
        sym = type("S", (), {"base": "SOL"})()
        ctx = lab.coin_context({"btc_up": {}, "funding_all": {"SOL": {1: -0.2}, "BTC": {1: 0.1}}}, sym)
        self.assertEqual(ctx["funding"], {1: -0.2})
        self.assertEqual(lab.coin_context({"btc_up": {}}, sym), {"btc_up": {}})

    def test_the_profile_lets_the_lab_judge_it_after_the_trend_rules(self):
        ap = load("trader-autopilot", "autopilot")
        self.assertEqual(ap.TREND_SETUPS, ["trend_ema", "trend_breakout", "funding_squeeze"])
        cfg, _ = ap.trend_profile(2, 1, 1, 1000.0)
        self.assertEqual(cfg["autopilot"]["playbook"]["setups"][-1], "funding_squeeze")


class TheWalkForwardStartsWithTheFunding(TraderTestCase):
    def test_a_funding_rule_is_judged_only_on_the_years_funding_exists(self):
        lab = load("trader-backtest", "lab")
        seen = {}
        real = lab.fold_bounds

        def spy(now_ts, days, folds):
            seen["days"] = days
            return real(now_ts, days, folds)
        args = type("A", (), {"folds": 3, "days": 30, "swing_days": 365, "daily_days": 3000, "min_pooled": 40})()
        now = T0 + 3000 * DAY
        with mock.patch.object(lab, "fold_bounds", side_effect=spy):
            try:
                lab.study_family("funding_squeeze", "1d", [], now, args, None, 0.26,
                                 {"funding_first_ts": now - 2000 * DAY})
            except Exception:
                pass  # no coins: only the window matters here
        self.assertAlmostEqual(seen["days"], 2000)
        with mock.patch.object(lab, "fold_bounds", side_effect=spy):
            try:
                lab.study_family("trend_breakout", "1d", [], now, args, None, 0.26,
                                 {"funding_first_ts": now - 2000 * DAY})
            except Exception:
                pass
        self.assertAlmostEqual(seen["days"], 3000, msg="other rules keep the whole history")
