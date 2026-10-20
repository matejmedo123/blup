"""Backtester: replays a setup over past sessions/days with the exit planner's levels and costs."""
from __future__ import annotations

import re
import unittest

from tests.helpers import MEME_PASS, TraderTestCase

from shared import market_clock

SUMMARY = re.compile(r"^Last \d+ (sessions?|days?): \d+ triggers?, \d+ hit target, \d+ hit stop, \d+ neither\.$")


class BacktestTests(TraderTestCase):
    def check_consistency(self, bt):
        self.assertEqual(bt["target"] + bt["stop"] + bt["neither"], bt["triggers"])
        self.assertEqual(len(bt["trades"]), bt["triggers"])
        if bt["triggers"]:
            self.assertAlmostEqual(bt["p_target"] + bt["p_stop"] + bt["p_neither"], 1.0, places=3)
            self.assertAlmostEqual(bt["total_r"], sum(t["r_net"] for t in bt["trades"]), places=3)
        self.assertRegex(bt["summary"], SUMMARY)
        self.assertLessEqual(bt["max_drawdown_r"], 0.0)

    def test_help(self):
        code, out, _ = self.run_tool("trader-backtest", "backtest", ["--help"])
        self.assertEqual(code, 0)
        self.assertIn("--sessions", out)
        self.assertIn("--fee-bps", out)

    def test_tsla_orb15(self):
        out = self.run_json("trader-backtest", "backtest", ["TSLA", "--setup", "orb15"])
        bt = out["backtest"]
        self.assertEqual(bt["windows"], 59)
        self.assertTrue(bt["summary"].startswith("Last 59 sessions: "))
        self.check_consistency(bt)
        self.assertGreater(bt["triggers"], 10)
        saved = self.read_state("backtests/TSLA-orb15.json")
        self.assertEqual(saved["summary"], bt["summary"])
        self.assertTrue((self.home / saved["report"]).exists())
        for t in bt["trades"]:  # every stock trade is flat by 3:55 p.m. ET of its own session
            d = market_clock.et_date(t["entry_time"])
            flat = market_clock.iso(market_clock.flat_by(d))
            self.assertLessEqual(t["exit_time"], flat)
            self.assertLess(t["stop"], t["entry"])
            self.assertGreater(t["target"], t["entry"])

    def test_include_current_and_determinism(self):
        a = self.run_json("trader-backtest", "backtest", ["TSLA", "--setup", "orb15", "--no-html"])["backtest"]
        b = self.run_json("trader-backtest", "backtest", ["TSLA", "--setup", "orb15", "--no-html"])["backtest"]
        self.assertEqual(a, b)
        c = self.run_json("trader-backtest", "backtest", ["TSLA", "--setup", "orb15", "--no-html",
                                                          "--include-current"])["backtest"]
        self.assertEqual(c["windows"], 60)
        self.check_consistency(c)

    def test_costs_reduce_net_r(self):
        free = self.run_json("trader-backtest", "backtest", ["TSLA", "--setup", "orb15", "--no-html",
                                                             "--fee-bps", "0", "--slippage-bps", "0"])["backtest"]
        dear = self.run_json("trader-backtest", "backtest", ["TSLA", "--setup", "orb15", "--no-html",
                                                             "--fee-bps", "20", "--slippage-bps", "20"])["backtest"]
        self.assertEqual(free["triggers"], dear["triggers"])
        self.assertLess(dear["avg_r"], free["avg_r"])

    def test_btc_asia_range_horizon(self):
        bt = self.run_json("trader-backtest", "backtest", ["BTCUSDT", "--setup", "asia_range", "--horizon", "4h",
                                                           "--no-html"])["backtest"]
        self.assertTrue(25 <= bt["windows"] <= 30)
        self.assertTrue(bt["summary"].startswith("Last %d days: " % bt["windows"]))
        self.assertEqual(bt["params"]["horizon"], "4h")
        self.check_consistency(bt)
        for t in bt["trades"]:
            self.assertLessEqual(market_clock.ts(t["exit_time"]) - market_clock.ts(t["entry_time"]), 4 * 3600)
        self.assertIsNotNone(self.read_state("backtests/BTCUSDT-asia_range.json"))

    def test_meme_thin_sample_warning(self):
        bt = self.run_json("trader-backtest", "backtest", [MEME_PASS, "--setup", "momentum",
                                                           "--no-html"])["backtest"]
        self.check_consistency(bt)
        self.assertTrue(any("thin sample" in w for w in bt["warnings"]))
        self.assertTrue(any("price impact" in w for w in bt["warnings"]))

    def test_setup_must_fit_asset(self):
        code, _, err = self.run_tool("trader-backtest", "backtest", ["TSLA", "--setup", "asia_range"])
        self.assertEqual(code, 2)
        self.assertIn("not defined for stock", err)

    def test_summary_line_grammar(self):
        from tests.helpers import load
        bt = load("trader-backtest", "backtest")
        line = bt.summary_line({"windows": 1, "triggers": 1, "target": 1, "stop": 0, "neither": 0}, "stock")
        self.assertEqual(line, "Last 1 session: 1 trigger, 1 hit target, 0 hit stop, 0 neither.")
        line = bt.summary_line({"windows": 59, "triggers": 33, "target": 13, "stop": 15, "neither": 5}, "stock")
        self.assertEqual(line, "Last 59 sessions: 33 triggers, 13 hit target, 15 hit stop, 5 neither.")


if __name__ == "__main__":
    unittest.main()
