"""Per-coin risk: BTC and ETH at 3 % per trade (a position up to half the account), every other coin at 2 %."""
from __future__ import annotations

import json
import types
import unittest

from shared import config, symbols
from tests.helpers import DEMOS, TraderTestCase, load


def ap():
    return load("trader-autopilot", "autopilot")


def profile(core_risk=3.0, coins=("BTC", "ETH")) -> tuple:
    """config + limits as the €1,000 profile writes them over the defaults."""
    c_cfg, c_lim = ap().trend_profile(2, 1, 1, 1000.0, True, True, 4, False, core_risk, coins)
    return config.deep_merge(config.DEFAULT_CONFIG, c_cfg), config.deep_merge(config.DEFAULT_LIMITS, c_lim)


def plan(symbol: str, entry: float = 100.0, stop: float = 90.0) -> dict:
    return {"id": "%s-1" % symbol, "symbol": symbol, "asset": "crypto", "setup": "trend_breakout",
            "direction": "long", "entry": {"price": entry, "time": "2026-10-20T00:00:00Z"},
            "stop": {"price": stop, "method": "atr"}, "target": None, "interval": "1d"}


class TheConfigChecksEveryCoinEntry(unittest.TestCase):
    def check(self, name, doc):
        defaults = {"config.json": config.DEFAULT_CONFIG, "limits.json": config.DEFAULT_LIMITS}[name]
        return config.validate(name, config.deep_merge(defaults, doc), defaults)

    def test_a_risk_per_coin_is_a_number_above_zero_and_at_most_five(self):
        self.check("config.json", {"risk_by_symbol": {"BTC": 3, "ETH": 2.5}})
        for bad in (0, -1, 6, "3", True, None, [3]):
            with self.assertRaises(config.ConfigError, msg=repr(bad)):
                self.check("config.json", {"risk_by_symbol": {"BTC": bad}})
        with self.assertRaises(config.ConfigError):
            self.check("config.json", {"risk_by_symbol": [3]})

    def test_a_coins_own_limits_take_only_the_known_keys(self):
        self.check("limits.json", {"crypto": {"symbols": {"BTC": {"max_risk_per_trade_pct": 3, "max_position_pct": 50,
                                                                  "max_risk_per_trade_usd": 120}}}})
        for bad in ({"max_open_positions": 9}, {"max_position_pct": "50"}, {"max_risk_per_trade_pct": 7},
                    {"max_position_pct": -5}, 50):
            with self.assertRaises(config.ConfigError, msg=repr(bad)):
                self.check("limits.json", {"crypto": {"symbols": {"BTC": bad}}})

    def test_a_null_inside_a_coins_limits_is_refused_not_read_as_no_limit(self):
        for key in config.SYMBOL_LIMIT_KEYS:
            with self.assertRaises(config.ConfigError, msg=key):
                self.check("limits.json", {"crypto": {"symbols": {"BTC": {key: None}}}})

    def test_keys_in_lower_case_mean_the_coin(self):
        doc = self.check("config.json", {"risk_by_symbol": {"btc": 3, " eth ": 3}})
        self.assertEqual(doc["risk_by_symbol"], {"BTC": 3, "ETH": 3})
        doc = self.check("limits.json", {"crypto": {"symbols": {"btc": {"max_position_pct": 50}}}})
        self.assertEqual(doc["crypto"]["symbols"], {"BTC": {"max_position_pct": 50}})

    def test_null_reads_as_no_split(self):
        doc = self.check("config.json", {"risk_by_symbol": None})
        self.assertEqual(doc["risk_by_symbol"], {})


class TheRiskForEachCoin(unittest.TestCase):
    def test_core_coins_get_their_own_risk_the_rest_the_general_one(self):
        cfg, _ = profile()
        self.assertEqual(config.risk_pct_for(cfg, symbols.parse("BTC-USD", asset="crypto", quote="USDT")), 3.0)
        self.assertEqual(config.risk_pct_for(cfg, "eth"), 3.0)
        self.assertEqual(config.risk_pct_for(cfg, symbols.parse("SOLUSDT", asset="crypto", quote="USDT")), 2.0)

    def test_a_dex_token_called_btc_never_gets_the_core_risk(self):
        cfg = {"risk_per_trade_pct": 2.0, "risk_by_symbol": {"BTC": 3.0, "BTCADDR": 3.0}}
        fake = symbols.meme_symbol("solana", "BTCADDR", "BTC")
        self.assertEqual(config.risk_pct_for(cfg, fake), 2.0)

    def test_a_stock_ticker_btc_is_not_the_coin(self):
        cfg = {"risk_per_trade_pct": 2.0, "risk_by_symbol": {"BTC": 3.0}}
        self.assertEqual(config.risk_pct_for(cfg, symbols.parse("BTC", asset="stock", quote="USD")), 2.0)
        self.assertEqual(config.risk_pct_for(cfg, symbols.parse("BTC", asset="crypto", quote="USDT")), 3.0)

    def test_never_above_the_hard_cap_even_when_a_file_says_so(self):
        self.assertEqual(config.risk_pct_for({"risk_by_symbol": {"BTC": 50}}, "BTC"), config.SYMBOL_RISK_HARD_CAP)

    def test_limits_for_puts_the_coins_entry_on_top_of_its_asset_class(self):
        _, lim = profile()
        btc, sol = config.limits_for(lim, "crypto", "BTC"), config.limits_for(lim, "crypto", "SOL")
        self.assertEqual((btc["max_risk_per_trade_pct"], btc["max_position_pct"], btc["max_risk_per_trade_usd"]),
                         (3.0, 50, 120))
        self.assertEqual((sol["max_risk_per_trade_pct"], sol["max_position_pct"], sol["max_risk_per_trade_usd"]),
                         (2.0, 25, 80))
        self.assertNotIn("symbols", btc)
        self.assertEqual(btc["max_open_positions"], sol["max_open_positions"])
        self.assertIn("symbols", lim["crypto"], "the caller's limits are left as they were")


class TheSizerAndTheRiskGate(TraderTestCase):
    NOW = DEMOS["btc"]["now"]

    def size(self, symbol, **kw):
        cfg, lim = kw.pop("profile", None) or profile()
        return load("trader-sizer", "size").size_order(plan(symbol), cfg, lim, account=1000.0, **kw)

    def test_btc_risks_three_percent_sol_two(self):
        btc, sol = self.size("BTC-USD"), self.size("SOL-USD")
        self.assertAlmostEqual(btc["qty"] * 10, 30.0, delta=0.01)  # 3 % of €1,000 over a $10 stop
        self.assertAlmostEqual(sol["qty"] * 10, 20.0, delta=0.01)

    def test_a_tight_stop_fills_btc_up_to_half_the_account_and_sol_to_a_quarter(self):
        cfg, lim = profile()
        sizer = load("trader-sizer", "size")
        btc = sizer.size_order(plan("BTC-USD", 100, 95), cfg, lim, account=1000.0)
        sol = sizer.size_order(plan("SOL-USD", 100, 95), cfg, lim, account=1000.0)
        self.assertAlmostEqual(btc["qty"] * 100, 500.0, delta=0.5)  # 3 % / 5 % stop = 60 % → capped at 50 %
        self.assertAlmostEqual(sol["qty"] * 100, 250.0, delta=0.5)  # 2 % / 5 % stop = 40 % → capped at 25 %

    def test_without_the_split_everything_is_two_percent(self):
        flat = profile(core_risk=None)
        self.assertEqual(flat[0]["risk_by_symbol"], {})
        self.assertAlmostEqual(self.size("BTC-USD", profile=flat)["qty"] * 10, 20.0, delta=0.01)

    def test_the_gate_passes_btc_at_three_and_blocks_sol_at_three(self):
        cfg, lim = profile()
        risk = load("trader-risk", "risk")
        order = self.size("BTC-USD")
        res = risk.evaluate(order, cfg, lim)
        failed = {c["name"] for c in res["checks"] if not c["ok"]}
        self.assertFalse(failed & {"max_risk_per_trade", "max_risk_per_trade_pct", "max_position_pct"}, res["checks"])
        sol = json.loads(json.dumps(order).replace("BTC", "SOL"))
        res = risk.evaluate(sol, cfg, lim)
        failed = {c["name"] for c in res["checks"] if not c["ok"]}
        self.assertIn("max_risk_per_trade_pct", failed)  # $30 is under SOL's $80 backstop: the % cap catches it


class TheAutopilotKeepsTheSplit(TraderTestCase):
    def test_a_losing_streak_scales_the_core_coins_too(self):
        cfg, lim = profile()
        cfg2, lim2 = ap()._scaled(cfg, lim, "crypto", 0.5)
        self.assertEqual(cfg2["risk_by_symbol"], {"BTC": 1.5, "ETH": 1.5})
        self.assertEqual(cfg2["risk_per_trade_pct"], 1.0)
        self.assertEqual(lim2["crypto"]["symbols"]["BTC"]["max_risk_per_trade_usd"], 60)
        self.assertEqual(lim2["crypto"]["max_risk_per_trade_usd"], 40)
        self.assertEqual(cfg["risk_by_symbol"]["BTC"], 3.0, "the caller's config is left as it was")

    def test_a_bigger_size_never_lifts_limits(self):
        cfg, lim = profile()
        _, lim2 = ap()._scaled(cfg, lim, "crypto", 1.5)
        self.assertEqual(lim2, lim)

    def test_the_playbook_cap_never_cuts_btc_below_its_own_risk(self):
        cfg, _ = profile()
        sure = {"test": {"profit_chance": 0.85, "n": 60}}  # the 1.5× tier
        self.assertAlmostEqual(ap().confidence_mult(sure, cfg, "BTC")[0], 1.0)
        self.assertAlmostEqual(ap().confidence_mult(sure, cfg, "SOL")[0], 1.0)
        unsure = {"test": {"profit_chance": 0.55, "n": 60}}  # the 0.5× tier, the same for both
        self.assertAlmostEqual(ap().confidence_mult(unsure, cfg, "BTC")[0], 0.5)
        self.assertAlmostEqual(ap().confidence_mult(unsure, cfg, "SOL")[0], 0.5)

    def test_a_coins_dollar_cap_warns_once_the_account_outgrows_it(self):
        cfg, lim = profile()
        notes = ap().usd_limits_binding(cfg, lim, 5000)
        self.assertTrue(any("crypto.symbols.BTC.max_risk_per_trade_usd" in n for n in notes), notes)
        self.assertFalse(any("symbols" in n for n in ap().usd_limits_binding(cfg, lim, 1000)))


class TheProfile(TraderTestCase):
    def run_profile(self, *extra):
        code, out, err = self.run_tool("trader-autopilot", "autopilot",
                                       ["profile", "--risk", "2", "--capital", "1000", "--write"] + list(extra))
        self.assertEqual(code, 0, out + err)
        return out, self.read_state("config.json"), self.read_state("limits.json")

    def test_writes_the_split_and_shows_it(self):
        out, cfg, lim = self.run_profile("--core-risk", "3")
        self.assertIn("BTC + ETH 3%", out)
        self.assertEqual(cfg["risk_by_symbol"], {"BTC": 3.0, "ETH": 3.0})
        self.assertEqual(lim["crypto"]["symbols"]["ETH"], {"max_risk_per_trade_pct": 3.0,
                                                           "max_risk_per_trade_usd": 120, "max_position_pct": 50})
        self.assertEqual(lim["global"]["max_daily_loss_pct"], 15.0, "five full losses at the larger risk")
        self.assertEqual(lim["crypto"]["max_position_pct"], 25)
        config.load_config(), config.load_limits()  # the files it wrote are files every tool can read

    def test_a_rerun_replaces_the_split_instead_of_merging_into_it(self):
        self.run_profile("--core-risk", "3")
        _, cfg, lim = self.run_profile("--core-risk", "3", "--core-coins", "btc")
        self.assertEqual(cfg["risk_by_symbol"], {"BTC": 3.0})
        self.assertEqual(sorted(lim["crypto"]["symbols"]), ["BTC"])
        out, cfg, lim = self.run_profile()
        self.assertEqual((cfg["risk_by_symbol"], lim["crypto"]["symbols"]), ({}, {}))
        self.assertIn('risk_by_symbol', out)
        self.assertIn('(was {"BTC": 3.0})', out)

    def test_fixed_risk_switches_off_the_confidence_halving_and_a_rerun_restores_it(self):
        out, cfg, _ = self.run_profile("--core-risk", "3", "--fixed-risk")
        self.assertIs(cfg["autopilot"]["playbook"]["confidence_sizing"], False)
        self.assertIn("Fixed risk", out)
        unsure = {"test": {"profit_chance": 0.55, "n": 60}}
        self.assertEqual(ap().confidence_mult(unsure, config.load_config(), "BTC"), (1.0, None))
        _, cfg, _ = self.run_profile("--core-risk", "3")
        self.assertIs(cfg["autopilot"]["playbook"]["confidence_sizing"], True)

    def test_bad_values_are_refused(self):
        trend = ap().trend_profile
        for bad in (0, 6, float("nan")):
            with self.assertRaises(ValueError):
                trend(2, 1, 1, 1000.0, core_risk=bad)
        with self.assertRaises(ValueError):
            trend(2, 1, 1, 1000.0, core_risk=3, core_coins=["", " "])
        with self.assertRaises(ValueError):
            trend(2, 1, 1, 1000.0, core_risk=3, core_coins=["B-T C!"])

    def test_pair_names_mean_their_coin(self):
        cfg, lim = ap().trend_profile(2, 1, 1, 1000.0, core_risk=3, core_coins=["BTCUSDT", "eth/usd", "btc"])
        self.assertEqual(cfg["risk_by_symbol"], {"BTC": 3, "ETH": 3})
        self.assertEqual(sorted(lim["crypto"]["symbols"]), ["BTC", "ETH"])

    def test_the_profile_never_touches_the_live_switches(self):
        cfg, _ = ap().trend_profile(2, 1, 1, 1000.0, core_risk=3)
        for key in ("broker", "mode", "enabled"):
            self.assertNotIn(key, cfg["autopilot"])
        for key in ("paper", "live_confirmation"):
            self.assertNotIn(key, cfg)


class TheReplaySizesTheSameWay(TraderTestCase):
    def test_btc_at_three_percent_sol_at_two(self):
        replay = load("trader-timemachine", "replay")
        cfg, lim = profile()
        ctx = types.SimpleNamespace(cfg=dict(cfg, account_size=1000.0), limits=lim)
        lv = {"risk": 10.0, "entry": 100.0}
        btc = replay.position({"symbol": "BTC-USD"}, "crypto", lv, None, ctx, None)
        sol = replay.position({"symbol": "SOL-USD"}, "crypto", lv, None, ctx, None)
        self.assertAlmostEqual(btc["risk_usd"], 30.0, delta=0.01)
        self.assertAlmostEqual(sol["risk_usd"], 20.0, delta=0.01)
        tight = {"risk": 5.0, "entry": 100.0}
        self.assertAlmostEqual(replay.position({"symbol": "BTC-USD"}, "crypto", tight, None, ctx, None)["qty"], 5.0)


if __name__ == "__main__":
    unittest.main()


class MemeCoinsAreNeverLeveraged(TraderTestCase):
    """Exchange-listed meme coins (DOGE, PEPE…) — the autopilot's memes opt-in — stay at 1× like DEX tokens."""
    NOW = DEMOS["btc"]["now"]

    def lev_profile(self):
        c_cfg, c_lim = ap().trend_profile(2, 1.5, 1, 1000.0, True, True, 4, True, 3)
        return config.deep_merge(config.DEFAULT_CONFIG, c_cfg), config.deep_merge(config.DEFAULT_LIMITS, c_lim)

    def test_config_leverage_says_no_for_doge_and_yes_for_sol(self):
        cfg, lim = self.lev_profile()
        doge = config.leverage(cfg, lim, "crypto", "simulator", symbols.parse("DOGEUSDT", asset="crypto", quote="USDT"))
        self.assertEqual(doge[0], 1.0)
        self.assertIn("meme coin", doge[1])
        self.assertEqual(config.leverage(cfg, lim, "crypto", "simulator", "SOL")[0], 1.5)
        self.assertEqual(config.leverage(cfg, lim, "crypto", "simulator", "1000PEPE")[0], 1.0)

    def test_the_sizer_keeps_doge_at_one_times_and_the_gate_blocks_a_leveraged_doge(self):
        cfg, lim = self.lev_profile()
        cfg["connector"] = "simulator"
        sizer, risk = load("trader-sizer", "size"), load("trader-risk", "risk")
        doge = sizer.size_order(plan("DOGEUSDT", 0.20, 0.19), cfg, lim, account=1000.0)
        self.assertEqual(doge["leverage"], 1.0)
        self.assertLessEqual(doge["qty"] * 0.20, 250.0 + 1e-6)
        sol = sizer.size_order(plan("SOLUSDT", 100, 99), cfg, lim, account=1000.0)
        self.assertEqual(sol["leverage"], 1.5)
        forced = sizer.size_order(plan("DOGEUSDT", 0.20, 0.19), cfg, lim, account=1000.0, leverage=1.5)
        self.assertEqual(forced["leverage"], 1.0, "not even when asked")
        forced["leverage"] = 1.5  # an order written by hand
        res = risk.evaluate(forced, cfg, lim)
        self.assertIn("no_leverage", {c["name"] for c in res["checks"] if not c["ok"]})


class SecondSizingReview(TraderTestCase):
    def test_per_coin_keys_written_as_pairs_mean_the_coin(self):
        from shared import config as cfgmod
        cfgmod.ensure_home()
        cfgmod.update_file("config.json", {"risk_by_symbol": {"BTCUSDT": 1, "eth/usd": 2.5}})
        cfgmod.update_file("limits.json", {"crypto": {"symbols": {"SOL/USD": {"max_position_pct": 5}}}})
        cfg, lim = cfgmod.load_config(), cfgmod.load_limits()
        self.assertEqual(cfg["risk_by_symbol"], {"BTC": 1, "ETH": 2.5})
        self.assertEqual(cfgmod.risk_pct_for(cfg, "BTC"), 1.0)
        self.assertEqual(cfgmod.limits_for(lim, "crypto", "SOL")["max_position_pct"], 5)

    def test_two_spellings_of_one_coin_with_different_values_are_refused(self):
        from shared import config as cfgmod
        cfgmod.ensure_home()
        with self.assertRaises(cfgmod.ConfigError):
            cfgmod.update_file("config.json", {"risk_by_symbol": {"BTC": 3, "BTCUSDT": 1}})
            cfgmod.load_config()

    def test_the_daily_close_wake_up_is_still_today_just_after_midnight(self):
        ap = load("trader-autopilot", "autopilot")
        day = 1792800000 - 1792800000 % 86400
        self.assertEqual(ap.next_daily_close(day + 2), day + ap.DAILY_CLOSE_DELAY_SEC)
        self.assertEqual(ap.next_daily_close(day + ap.DAILY_CLOSE_DELAY_SEC), day + 86400 + ap.DAILY_CLOSE_DELAY_SEC)
        self.assertEqual(ap.next_daily_close(day - 10), day + ap.DAILY_CLOSE_DELAY_SEC)

    def test_an_order_capped_by_the_position_limit_is_never_refused_for_a_rounded_cent(self):
        import random
        from unittest import mock
        from shared import data
        config.ensure_home()
        ap, sizer, risk = load("trader-autopilot", "autopilot"), load("trader-sizer", "size"), load("trader-risk", "risk")
        c, l = ap.trend_profile(2.0, 1.0, 1.0, 1000.0, True, True, 4.0, False, 3.0, ("BTC", "ETH"), True, "bybit")
        cfg = config.validate("config.json", config.deep_merge(config.DEFAULT_CONFIG, c), config.DEFAULT_CONFIG)
        lim = config.validate("limits.json", config.deep_merge(config.DEFAULT_LIMITS, l), config.DEFAULT_LIMITS)
        stub = {"step": 0.000001, "tick": 0.01, "min_qty": None, "min_notional": None, "source": "stub"}
        rng, refused = random.Random(3), []
        with mock.patch.object(data, "lot_info", return_value=stub):
            for _ in range(300):
                eq, px = rng.uniform(900, 1100), 67000 * rng.uniform(0.95, 1.05)
                plan = {"id": "BTCUSDT-1", "symbol": "BTCUSDT", "asset": "crypto", "setup": "trend_breakout",
                        "direction": "long", "entry": {"price": px, "time": "2026-10-20T00:00:00Z"},
                        "stop": {"price": px * 0.96, "method": "atr"}, "target": None, "interval": "1d",
                        "entry_slack_pct": 1.0}
                o = sizer.size_order(plan, cfg, lim, account=eq, leverage=1.0)
                o["origin"] = "autopilot"
                refused += [ch["detail"] for ch in risk.evaluate(o, cfg, lim)["checks"] if not ch["ok"]]
        self.assertEqual(refused, [])
