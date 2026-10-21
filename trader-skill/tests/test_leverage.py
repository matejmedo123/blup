"""Leverage (opt-in, capped at 2×), borrowing cost, %-of-equity limits, the confidence cap and the trend profile."""
from __future__ import annotations

import json
import unittest

from shared import config, state
from shared.brokers.base import BrokerError
from shared.brokers.simulator import SimBroker
from tests.helpers import TraderTestCase, load
from tests import test_lab
from tests.test_lab import ap, entry
from tests.test_sizer import BTC_ID, plans, write_plans


def allow(limits: dict, asset: str = "crypto", max_lev: float = 2.0) -> dict:
    limits[asset]["allow_leverage" if asset == "crypto" else "allow_margin"] = True
    limits[asset]["max_leverage"] = max_lev
    return limits


class LeverageRule(TraderTestCase):
    def test_off_unless_config_and_limits_both_say_so(self):
        cfg, limits = config.load_config(), config.load_limits()
        self.assertEqual(config.leverage(cfg, limits, "crypto"), (1.0, None))
        cfg["leverage"]["crypto"] = 1.5
        lev, why = config.leverage(cfg, limits, "crypto")
        self.assertEqual(lev, 1.0)
        self.assertIn("allow_leverage is false", why)
        lev, why = config.leverage(cfg, allow(limits), "crypto")
        self.assertEqual(lev, 1.5)
        limits["crypto"]["max_leverage"] = 1.2
        self.assertEqual(config.leverage(cfg, limits, "crypto")[0], 1.2)

    def test_hard_cap_meme_and_alpaca_crypto(self):
        cfg, limits = config.load_config(), allow(allow(config.load_limits()), "stock", 5.0)
        limits["crypto"]["max_leverage"] = 5.0
        cfg["leverage"] = {"crypto": 4.0, "stock": 1.5, "meme": 3.0}
        self.assertEqual(config.leverage(cfg, limits, "crypto", "simulator")[0], config.LEVERAGE_HARD_CAP)
        self.assertEqual(config.leverage(cfg, limits, "meme")[0], 1.0)
        lev, why = config.leverage(cfg, limits, "crypto", "alpaca")
        self.assertEqual(lev, 1.0)
        self.assertIn("no crypto margin", why)
        self.assertEqual(config.leverage(cfg, limits, "stock", "alpaca")[0], 1.5)


class LeverageSizing(TraderTestCase):
    def setUp(self):
        super().setUp()
        write_plans(self, BTC_ID)
        self.plan = plans()[BTC_ID]
        self.sizer = load("trader-sizer", "size")

    def test_leverage_lifts_the_position_cap_not_the_risk(self):
        cfg, limits = config.load_config(), config.load_limits()
        plain = self.sizer.size_order(self.plan, cfg, limits, account=25000)
        lev = self.sizer.size_order(self.plan, cfg, limits, account=25000, leverage=1.5)
        self.assertEqual(plain["leverage"], 1.0)
        self.assertLessEqual(plain["notional_usd"], 25000 * 0.15 + 1)
        self.assertGreater(lev["notional_usd"], plain["notional_usd"] * 1.4)
        self.assertLessEqual(lev["notional_usd"], 25000 * 0.15 * 1.5 + 1)
        self.assertLessEqual(lev["risk_usd"], 25000 * 0.005 + 0.01)  # still at most 0.5 % of the account
        self.assertTrue(any("× 1.5 leverage" in c for c in lev["sizing"]["caps"]))
        huge = self.sizer.size_order(self.plan, cfg, limits, account=25000, leverage=9)
        self.assertEqual(huge["leverage"], config.LEVERAGE_HARD_CAP)

    def test_percent_risk_cap(self):
        cfg, limits = config.load_config(), config.load_limits()
        cfg["risk_per_trade_pct"] = 4
        limits["crypto"].update(max_risk_per_trade_pct=2, max_position_pct=100)
        order = self.sizer.size_order(self.plan, cfg, limits, account=1000)
        self.assertLessEqual(order["risk_usd"], 20.0 + 1e-9)
        self.assertTrue(any("max_risk_per_trade_pct" in c for c in order["sizing"]["caps"]))


class LeverageRisk(TraderTestCase):
    def setUp(self):
        super().setUp()
        write_plans(self, BTC_ID)
        self.sizer, self.risk = load("trader-sizer", "size"), load("trader-risk", "risk")

    def checks(self, order, cfg, limits):
        res = self.risk.evaluate(order, cfg, limits)
        return {c["name"]: c for c in res["checks"]}, res

    def test_allowed_leverage_stretches_position_and_exposure_caps(self):
        cfg, limits = config.load_config(), allow(config.load_limits(), max_lev=1.5)
        order = self.sizer.size_order(plans()[BTC_ID], cfg, limits, account=25000, leverage=1.5)
        ch, _ = self.checks(order, cfg, limits)
        self.assertTrue(ch["no_leverage"]["ok"], ch["no_leverage"])
        self.assertTrue(ch["max_position_pct"]["ok"], ch["max_position_pct"])
        self.assertIn("1.5× leverage", ch["max_position_pct"]["detail"])
        self.assertTrue(ch["max_total_exposure"]["ok"])
        # the same order without the opt-in is blocked twice: leverage and the plain position cap
        ch, res = self.checks(order, cfg, config.load_limits())
        self.assertEqual(res["result"], "BLOCK")
        self.assertFalse(ch["no_leverage"]["ok"])
        self.assertFalse(ch["max_position_pct"]["ok"])

    def test_above_max_leverage_blocks(self):
        cfg, limits = config.load_config(), allow(config.load_limits(), max_lev=1.2)
        order = self.sizer.size_order(plans()[BTC_ID], cfg, limits, account=25000, leverage=1.5)
        ch, _ = self.checks(order, cfg, limits)
        self.assertFalse(ch["no_leverage"]["ok"])
        self.assertIn("over the 1.2× maximum", ch["no_leverage"]["detail"])

    def test_percent_limits_follow_the_account(self):
        cfg, limits = config.load_config(), config.load_limits()
        limits["crypto"]["max_position_pct"] = 100
        order = self.sizer.size_order(plans()[BTC_ID], cfg, limits, account=25000, risk_pct=0.5)
        limits["crypto"]["max_risk_per_trade_pct"] = 0.2  # 0.5 % sized, 0.2 % allowed
        limits["global"]["max_daily_loss_pct"] = 0.1
        ch, res = self.checks(order, cfg, limits)
        self.assertEqual(res["result"], "BLOCK")
        self.assertFalse(ch["max_risk_per_trade_pct"]["ok"])
        self.assertFalse(ch["max_daily_loss_global_pct"]["ok"])
        self.assertTrue(ch["max_risk_per_trade"]["ok"])  # the dollar cap alone would have let it through


class BorrowingInTheSimulator(TraderTestCase):
    def setUp(self):
        super().setUp()
        config.ensure_home()
        cfg = config.load_config()
        cfg["leverage"]["crypto"] = 1.5
        cfg["autopilot"]["sim_starting_cash"] = 1000
        self.cfg = cfg
        config.update_file("limits.json", {"crypto": {"allow_leverage": True, "max_leverage": 1.5}})

    def order(self, notional, lev=1.5):
        return {"client_order_id": "o1", "symbol": "BTC/USD", "asset": "crypto", "qty": notional / 50000.0,
                "limit_price": 50000.0, "stop_price": 45000.0, "target_price": 60000.0, "leverage": lev}

    def test_buying_power_stretches_only_as_far_as_allowed(self):
        b = SimBroker(self.cfg)
        self.assertAlmostEqual(b.account()["buying_power"], 1500.0)
        with self.assertRaises(BrokerError):
            b.place_entry(self.order(1400, lev=1.0))  # the order did not ask for leverage
        b.place_entry(self.order(1400))
        self.assertAlmostEqual(SimBroker(self.cfg).account()["buying_power"], 100.0)  # the waiting buy holds its cash
        with self.assertRaises(BrokerError):   # two waiting buys can't spend the same dollars
            SimBroker(self.cfg).place_entry(dict(self.order(200), client_order_id="o2"))
        again = SimBroker(self.cfg).place_entry(self.order(1400))   # the same order sent twice is one order
        self.assertEqual(len(SimBroker(self.cfg).open_orders()), 1)
        self.assertEqual(again["client_order_id"], "o1")
        config.update_file("limits.json", {"crypto": {"allow_leverage": False}})
        self.assertAlmostEqual(SimBroker(self.cfg).account()["buying_power"], 0.0)
        b = SimBroker(self.cfg)
        b.cancel(b.open_orders()[0]["id"])
        self.assertAlmostEqual(SimBroker(self.cfg).account()["buying_power"], 1000.0)

    def test_borrowed_cash_costs_interest(self):
        b = SimBroker(self.cfg)
        b.book["cash"] = -500.0
        b.book["interest_at"] = 0
        b._charge_interest(365 * 86400)
        self.assertAlmostEqual(b.book["cash"], -550.0, places=6)  # 10 % a year on 500 borrowed
        self.assertAlmostEqual(b.book["interest_paid"], 50.0, places=4)
        b._charge_interest(366 * 86400)
        self.assertLess(b.book["cash"], -550.0)
        b.book["cash"] = 100.0
        before = b.book["interest_paid"]
        b._charge_interest(400 * 86400)
        self.assertEqual(b.book["interest_paid"], before)  # nothing borrowed, nothing owed
        acct = b.account()
        self.assertEqual(acct["borrowed"], 0.0)
        self.assertGreater(acct["interest_paid"], 50.0)


class ConfidenceCap(TraderTestCase):
    def test_bigger_size_stops_at_max_risk_pct(self):
        cfg = config.load_config()
        cfg["risk_per_trade_pct"] = 2.0
        cfg["autopilot"]["playbook"]["max_risk_pct"] = 2.0
        e = entry("BTCUSDT", "trend_ema", "1d")
        e["test"].update(profit_chance=0.93, n=60)
        mult, why = ap().confidence_mult(e, cfg)
        self.assertEqual(mult, 1.0)
        self.assertIn("capped at 2% per trade", why)
        e["test"].update(profit_chance=0.55)
        self.assertEqual(ap().confidence_mult(e, cfg)[0], 0.5)  # less sure → 1 %


class PlaybookFilter(TraderTestCase):
    def test_only_the_chosen_setups_and_timeframes(self):
        config.ensure_home()
        self.write_state("backtests/playbook.json", {
            "generated_at": "2026-10-19T00:00:00Z", "valid_until": "2026-11-02T00:00:00Z",
            "entries": {"ETHUSDT:trend_ema@1d": entry("ETHUSDT", "trend_ema", "1d"),
                        "BTCUSDT:asia_range@5m": entry("BTCUSDT", "asia_range", "5m"),
                        "SOLUSDT:trend_breakout@1d": entry("SOLUSDT", "trend_breakout", "1d")}})
        cfg = config.load_config()
        self.assertEqual(len(ap().playbook_state(cfg)["by_coin"]), 3)
        cfg["autopilot"]["playbook"].update(setups=["trend_ema", "trend_breakout"], timeframes=["1d"])
        self.assertEqual(sorted(ap().playbook_state(cfg)["by_coin"]), ["ETHUSDT", "SOLUSDT"])


class TrendProfile(TraderTestCase):
    def test_dry_run_changes_nothing(self):
        config.ensure_home()
        before = (self.home / "config.json").read_text(), (self.home / "limits.json").read_text()
        code, out, _ = self.run_tool("trader-autopilot", "autopilot", ["profile", "--risk", "2", "--leverage", "1.5",
                                                                       "--capital", "1000"])
        self.assertEqual(code, 0)
        self.assertIn("Dry run", out)
        self.assertIn("(was 0.5)", out)
        self.assertEqual(before, ((self.home / "config.json").read_text(), (self.home / "limits.json").read_text()))

    def test_write_sets_the_backtested_numbers_and_nothing_live(self):
        config.ensure_home()
        config.update_file("config.json", {"autopilot": {"broker": "simulator", "mode": "paper"}, "paper": True})
        res = self.run_json("trader-autopilot", "autopilot", ["profile", "--risk", "2", "--leverage", "1.5",
                                                              "--capital", "1000", "--write"])
        self.assertTrue(res["written"])
        cfg, limits = config.load_config(), config.load_limits()
        self.assertEqual(cfg["risk_per_trade_pct"], 2.0)
        self.assertEqual(cfg["leverage"], {"crypto": 1.5, "stock": 1.0})
        self.assertEqual(cfg["autopilot"]["playbook"]["setups"], ["trend_ema", "trend_breakout"])
        self.assertEqual(cfg["autopilot"]["playbook"]["max_risk_pct"], 2.0)
        self.assertEqual(cfg["autopilot"]["adapt"]["max_drawdown_pct"], 35)
        self.assertEqual((cfg["autopilot"]["broker"], cfg["autopilot"]["mode"], cfg["paper"]),
                         ("simulator", "paper", True))
        self.assertFalse(cfg["autopilot"]["enabled"])
        self.assertEqual(cfg["autopilot"]["live_confirmation"], "")
        self.assertTrue(limits["crypto"]["allow_leverage"])
        self.assertEqual(limits["crypto"]["max_leverage"], 1.5)
        self.assertFalse(limits["stock"]["allow_margin"])
        self.assertEqual(limits["crypto"]["max_daily_loss_pct"], 10.0)
        self.assertEqual(config.leverage(cfg, limits, "crypto")[0], 1.5)
        self.assertEqual(config.leverage(cfg, limits, "stock")[0], 1.0)

    def test_refuses_more_than_the_hard_cap(self):
        for argv in (["--leverage", "2.5"], ["--risk", "10"], ["--stock-leverage", "0.5"]):
            code, _, err = self.run_tool("trader-autopilot", "autopilot", ["profile", "--write"] + argv)
            self.assertNotEqual(code, 0, argv)
        self.assertFalse(config.load_limits()["crypto"]["allow_leverage"])


class LeveragedDailyTrade(test_lab.DailyAutopilot):
    """The daily strategy end to end with 1.5× allowed: the order and the book carry the leverage."""

    def setUp(self):
        super().setUp()
        config.update_file("config.json", {"leverage": {"crypto": 1.5}})
        config.update_file("limits.json", {"crypto": {"allow_leverage": True, "max_leverage": 1.5}})

    def test_bitcoin_below_its_200_day_average_switches_it_off(self):
        pass  # covered by the unleveraged parent

    def test_daily_signal_becomes_a_rule_exit_plan(self):
        ap().run_cycle(self.NOW, approved=True)
        d = [x for x in state.read_jsonl("autopilot/decisions.jsonl") if "dip_in_uptrend" in x["id"]]
        self.assertEqual(len(d), 1)
        gates = {g["name"]: g for g in d[0].get("gates") or []}
        self.assertIn("leverage", gates, d[0])
        self.assertIn("1.5×", gates["leverage"]["detail"])
        orders = (state.read_json("orders.json") or {}).get("orders") or []
        self.assertTrue(orders and orders[-1]["leverage"] == 1.5, orders[-1:] if orders else None)
        if d[0]["action"] == "taken":
            item = list(state.read_json("autopilot/book.json")["items"].values())[0]
            self.assertEqual(item["leverage"], 1.5)


if __name__ == "__main__":
    unittest.main()
