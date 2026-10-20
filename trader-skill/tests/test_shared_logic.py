"""Setup rules, trade simulation, indicators, formatting and HTML escaping."""
from __future__ import annotations

import unittest

from tests.helpers import DEMOS, MEME_PASS, TraderTestCase
from shared import data, fmt, html, indicators, market_clock as mc, setups, trade_sim
from shared.indicators import Candle


def bars(prices, start=0, step=300, spread=0.2, vol=100):
    out = []
    prev = prices[0]
    for i, p in enumerate(prices):
        out.append(Candle(start + i * step, prev, max(prev, p) + spread, min(prev, p) - spread, p, vol))
        prev = p
    return out


class Indicators(unittest.TestCase):
    def test_vwap_atr_relvol(self):
        b = [Candle(0, 10, 11, 9, 10, 100), Candle(300, 10, 13, 10, 12, 300)]
        vw = indicators.vwap(b)
        self.assertAlmostEqual(vw[0], 10.0)
        self.assertAlmostEqual(vw[1], (10 * 100 + (35 / 3.0) * 300) / 400)
        self.assertAlmostEqual(indicators.atr(b, 14)[1], (2 + 3) / 2.0)
        self.assertAlmostEqual(indicators.relative_volume(b[:1], [[Candle(0, 1, 1, 1, 1, 50)]]), 2.0)
        self.assertEqual(indicators.percentile([1, 2, 3, 4], 50), 2.5)
        self.assertEqual(indicators.median([3, 1, 2]), 2)


class TradeSim(unittest.TestCase):
    def test_target_stop_time(self):
        up = bars([101, 102, 103, 104, 105, 106], start=300)
        r = trade_sim.walk(up, 100, 98, 104, end_ts=10 ** 9)
        self.assertEqual((r["outcome"], r["exit_price"]), ("target", 104))
        self.assertAlmostEqual(r["r_multiple"], 2.0)
        down = bars([99.5, 98.5, 97], start=300)
        self.assertEqual(trade_sim.walk(down, 100, 98, 104)["outcome"], "stop")
        flat = bars([100.5, 100.2, 100.4], start=300)
        r = trade_sim.walk(flat, 100, 98, 104, end_ts=300 + 3 * 300)
        self.assertEqual((r["outcome"], r["bars_held"]), ("time", 3))
        self.assertEqual(trade_sim.walk(flat, 100, 98, 104)["outcome"], "open")

    def test_same_bar_is_stop_first_and_gap_fills_at_open(self):
        both = [Candle(300, 100, 105, 97, 101, 1)]
        self.assertEqual(trade_sim.walk(both, 100, 98, 104)["outcome"], "stop")
        gap = [Candle(300, 95, 96, 94, 95, 1)]
        r = trade_sim.walk(gap, 100, 98, 104)
        self.assertEqual((r["outcome"], r["exit_price"]), ("stop", 95))
        self.assertAlmostEqual(r["r_multiple"], -2.5)

    def test_trailing_and_scale_out(self):
        path = bars([101, 102.5, 102.0, 99.5], start=300, spread=0.1)
        r = trade_sim.walk(path, 100, 98, 110, trailing={"type": "breakeven_at_r", "value": 1})
        self.assertEqual((r["outcome"], r["stopped_by"]), ("stop", "trailing"))
        self.assertAlmostEqual(r["exit_price"], 100.0)
        r = trade_sim.walk(bars([150, 210, 70], start=300, spread=0), 100, 80, 400,
                           scale_out=[{"fraction": 0.5, "price": 200}])
        self.assertAlmostEqual(r["exit_price"], 0.5 * 200 + 0.5 * 80)
        with self.assertRaises(ValueError):
            trade_sim.walk([], 100, 101, 110)

    def test_costs_and_slippage(self):
        self.assertAlmostEqual(trade_sim.net_r(100, 104, 2, 0.0), 2.0)
        self.assertLess(trade_sim.net_r(100, 104, 2, 0.1), 2.0)
        self.assertAlmostEqual(trade_sim.estimate_slippage_pct(1000, 400000), 0.5)
        self.assertAlmostEqual(trade_sim.max_size_for_slippage(400000, 0.5), 1000)
        self.assertIsNone(trade_sim.estimate_slippage_pct(1000, 0))
        self.assertAlmostEqual(trade_sim.cost_pct(10, 3), 0.13)


class SetupRules(TraderTestCase):
    NOW = DEMOS["tsla"]["now"]

    def _window(self, sym, now):
        s = data.get_candles(sym)
        return setups.window_at(s.candles, s.symbol.asset, "5m", mc.ts(now) - 1)

    def test_tsla_orb_watching_then_triggered(self):
        w = self._window("TSLA", self.NOW)
        early = setups.evaluate("orb15", w, mc.ts("2026-10-20T14:05:00Z"))
        self.assertEqual(early["status"], "watching")
        r = setups.evaluate("orb15", w, mc.ts(self.NOW))
        self.assertEqual(r["status"], "triggered")
        self.assertEqual((r["levels"]["range_high"], r["levels"]["range_low"]), (362.18, 358.32))
        self.assertEqual((mc.fmt_et(r["trigger"]["t"]), r["trigger"]["price"]), ("10:10", 364.18))
        self.assertEqual(r["rule"], "5-min close above opening range high $362.18 (9:30–9:45 ET)")
        forming = setups.evaluate("orb15", w, mc.ts("2026-10-20T13:40:00Z"))
        self.assertEqual(forming["status"], "forming")

    def test_other_stock_setups(self):
        self.assertEqual(setups.evaluate("gap_and_go", self._window("NVDA", self.NOW), mc.ts(self.NOW))["status"],
                         "triggered")
        self.assertEqual(setups.evaluate("bull_flag", self._window("PLTR", self.NOW), mc.ts(self.NOW))["status"],
                         "triggered")
        self.assertEqual(setups.evaluate("vwap_reclaim", self._window("AMD", self.NOW), mc.ts(self.NOW))["status"],
                         "triggered")

    def test_btc_asia_range(self):
        now = DEMOS["btc"]["now"]
        self.set_now(now)
        r = setups.evaluate("asia_range", self._window("BTC-USD", now), mc.ts(now))
        self.assertEqual((r["status"], r["levels"]["range_high"], r["trigger"]["time"]),
                         ("triggered", 67420.0, "2026-10-20T14:35:00Z"))

    def test_meme_momentum_pick_last(self):
        now = DEMOS["meme"]["now"]
        self.set_now(now)
        w = self._window(MEME_PASS, now)
        r = setups.evaluate("momentum", w, mc.ts(now), {"pick": "last"})
        self.assertEqual(r["trigger"]["time"], "2026-10-20T15:50:00Z")
        since = setups.evaluate("momentum", w, mc.ts(now), since_ts=mc.ts("2026-10-20T15:50:00Z"))
        self.assertEqual(since["trigger"]["time"], "2026-10-20T15:50:00Z")

    def test_asset_checks_and_windows(self):
        with self.assertRaises(setups.SetupError):
            setups.check("orb15", "crypto")
        with self.assertRaises(setups.SetupError):
            setups.check("nope", "stock")
        s = data.get_candles("TSLA")
        ws = setups.windows(s.candles, "stock")
        self.assertEqual(len(ws), 60)
        self.assertIsNone(ws[0].prev_close)
        self.assertAlmostEqual(ws[-1].prev_close, 359.40)
        self.assertEqual(setups.setup_id("TSLA", ws[-1].key, "orb15"), "TSLA-20261020-orb15")


class FormattingAndHtml(unittest.TestCase):
    def test_fmt(self):
        self.assertEqual(fmt.price(67420), "$67,420.00")
        self.assertEqual(fmt.price(364.18), "$364.18")
        self.assertEqual(fmt.price(0.4213), "$0.4213")
        self.assertEqual(fmt.price(0.004712), "$0.004712")
        self.assertEqual(fmt.pct(1.94, 1, True), "+1.9%")
        self.assertEqual(fmt.qty(17), "17")
        self.assertEqual(fmt.qty(0.015, "BTC"), "0.015 BTC")
        self.assertEqual(fmt.compact_usd(412350), "$412.4k")
        self.assertEqual(fmt.r(0.134), "+0.13R")

    def test_html_escapes_untrusted_text(self):
        evil = "<script>alert(1)</script>"
        page = html.page(evil, html.table(["name"], [[evil]]) + html.tiles([(evil, evil)]), evil, asset="meme")
        self.assertNotIn("<script>alert", page)
        self.assertIn("&lt;script&gt;", page)
        self.assertEqual(html.safe_url("javascript:alert(1)"), "")
        self.assertNotIn("javascript:", html.link("javascript:alert(1)", "x"))
        self.assertIn("Most go to zero".lower(), page.lower())

    def test_charts_render(self):
        b = bars([100, 101, 102, 101.5, 103])
        svg = html.candle_chart(b, lines=[{"price": 102, "label": "Entry", "color": "blue"}],
                                markers=[{"t": b[2].t, "price": 102, "label": "in"}], shades=[{"t0": 0, "t1": 600}])
        self.assertTrue(svg.startswith("<svg") and svg.endswith("</svg>"))
        self.assertIn("Entry $102.00", svg)
        self.assertIn("<svg", html.histogram([1, 2, 2, 3], 4, [{"price": 2, "label": "x"}]))
        fan = html.fan_chart([{"prices": [1, 2, 3], "outcome": "target"}], counter_total=10000)
        self.assertIn("10,000 simulated sessions", fan)
        self.assertIn("<polyline", html.line_chart([0, 1, -1]))


if __name__ == "__main__":
    unittest.main()
