"""Backtest lab: the exit grid matches the backtester's fills, pooled train/test validation, the playbook,
and the autopilot trading crypto only from it."""
from __future__ import annotations

import json
import math
import random

from tests.helpers import TraderTestCase, load
from shared import config, data, market_clock as mc, setups, state, symbols, trade_sim
from shared.indicators import Candle


def lab():
    return load("trader-backtest", "lab")


def ap():
    return load("trader-autopilot", "autopilot")


def synthetic(seed: int, bars: int = 3000, step: int = 3600, start: int = 1767225600) -> list:
    """An uptrend with a sharp one-bar dip every 30 bars that is always bought back — oversold_bounce wins."""
    rng = random.Random(seed)
    out, px = [], 100.0
    for i in range(bars):
        k = i % 30
        if k == 20:
            move = -0.025
        elif k in (21, 22, 23):
            move = 0.012
        else:
            move = 0.0008 + rng.uniform(-0.002, 0.002)
        o = px
        c = px * (1 + move)
        h, l = max(o, c) * 1.001, min(o, c) * 0.999
        out.append(Candle(start + i * step, o, h, l, c, 1000.0 + rng.random() * 100))
        px = c
    return out


class Grid(TraderTestCase):
    def test_grid_matches_the_backtester_walk(self):
        candles = synthetic(3, bars=900)
        exit_mod = load("trader-exit", "exit")
        trigs = lab().triggers(candles, "oversold_bounce", "1h", candles[-1].t + 3600)
        self.assertGreater(len(trigs), 10)
        cost = trade_sim.cost_pct(10, 3)
        for t in trigs[:5]:
            grid = lab().grid_outcomes(candles, t, "1h", exit_mod, 0.01, cost)
            hist = candles[max(0, t["gi"] - 300):t["gi"] + 1]
            for (stop, target, hours), r in list(grid.items())[::17]:
                kind, mult = ("atr", float(stop.split(":")[1])) if stop.startswith("atr") else ("auto", 1.5)
                lv = exit_mod.plan_levels(t["entry"], t["entry_ts"], "crypto", hist, stop_ref=t["stop_ref"],
                                          trigger_level=t["trigger_level"], stop=kind, atr_mult=mult,
                                          target_r=target, tick=0.01, horizon_s=hours * 3600)
                end = mc.ts(lv["time_stop"]["at"])
                bars = [c for c in candles[t["gi"] + 1:] if c.t < end]
                w = trade_sim.walk(bars, t["entry"], lv["stop"]["price"], lv["target"]["price"], end, 3600)
                self.assertAlmostEqual(r, trade_sim.net_r(t["entry"], w["exit_price"], lv["risk_per_unit"], cost),
                                       places=6, msg=(stop, target, hours))

    def test_series_setups_refuse_day_windows(self):
        w = setups.windows(synthetic(1, bars=48), "crypto", "1h")[0]
        with self.assertRaises(setups.SetupError):
            setups.evaluate("trend_pullback", w)
        self.assertEqual(set(setups.for_asset("crypto", "series")),
                         {"trend_pullback", "oversold_bounce", "band_bounce", "breakout_24", "dip_in_uptrend",
                          "trend_breakout", "trend_ema", "breakout_volume"})


class Validation(TraderTestCase):
    def _args(self, *extra):
        return lab().build_parser().parse_args(["--min-pooled", "40", "--min-pooled-test", "20", "--fee-bps", "0",
                                                "--slippage-bps", "0"] + list(extra))

    def test_a_real_edge_is_validated_on_every_coin(self):
        coins = [(symbols.parse(s, asset="crypto"), synthetic(i, bars=5000), 0.01)
                 for i, s in enumerate(("AAAUSDT", "BBBUSDT"))]
        now = coins[0][1][-1].t + 3600
        fam, rows, picks = lab().study_family("oversold_bounce", "1h", coins, now, self._args("--swing-days", "208"),
                                              load("trader-exit", "exit"), 0.0)
        self.assertEqual(len(fam["folds"]), 3)
        self.assertTrue(all(f["test"]["expectancy_r"] > 0 for f in fam["folds"]))
        self.assertTrue(fam["validated"], fam["verdict"])
        self.assertGreater(fam["test"]["expectancy_r"], 0.05)
        self.assertGreaterEqual(fam["test"]["win_rate"], 0.6)
        self.assertEqual(sorted(fam["validated_coins"]), ["AAA/USDT", "BBB/USDT"])
        self.assertTrue(all(r["validated"] for r in rows))
        self.assertIsNotNone(fam["highest_win"])

    def test_noise_is_not_validated(self):
        rng = random.Random(11)

        def walk(seed):
            px, out = 100.0, []
            r = random.Random(seed)
            for i in range(3000):
                c = px * math.exp(r.gauss(0.0002, 0.01))
                out.append(Candle(1767225600 + i * 3600, px, max(px, c) * 1.002, min(px, c) * 0.998, c, 1000.0))
                px = c
            return out
        coins = [(symbols.parse(s, asset="crypto"), walk(rng.random()), 0.01) for s in ("CCCUSDT", "DDDUSDT")]
        now = coins[0][1][-1].t + 3600
        args = lab().build_parser().parse_args(["--swing-days", "125"])  # real costs, default rules
        for setup in ("oversold_bounce", "breakout_24", "trend_pullback"):
            fam, rows, _ = lab().study_family(setup, "1h", coins, now, args, load("trader-exit", "exit"),
                                              trade_sim.cost_pct(10, 3))
            self.assertFalse(any(r["validated"] for r in rows), (setup, fam["verdict"]))


class OfflineRun(TraderTestCase):
    NOW = "2026-10-20T20:00:00Z"

    def test_cli_writes_lab_playbook_and_report(self):
        code, out, err = self.run_tool("trader-backtest", "lab", [
            "--symbols", "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT", "--days", "30", "--swing-days", "30",
            "--min-pooled", "5", "--min-pooled-test", "3"])
        self.assertEqual(code, 0, out + err)
        self.assertIn("BACKTEST LAB", out)
        self.assertIn("Highest win chance", out)
        doc = state.read_json("backtests/lab-crypto.json")
        self.assertEqual(doc["timeframes"], ["5m", "1h", "4h", "1d"])
        self.assertEqual(doc["costs"]["round_trip_pct"], 0.26)
        self.assertEqual(len(doc["families"]), 6 + 4 + 4 + 4)
        pb = state.read_json("backtests/playbook.json")
        self.assertEqual(pb["entries"], {})  # 30 days of fixtures prove nothing
        self.assertTrue(all(not f["validated"] for f in doc["families"]))
        self.assertTrue((self.home / "reports" / "lab-crypto.html").exists())
        self.assertTrue((self.home / "cache" / "lab" / "BTCUSDT-1h.json").exists())
        # a second run reuses the local candles
        code, out, err = self.run_tool("trader-backtest", "lab", ["--symbols", "BTCUSDT", "--timeframes", "1h",
                                                                  "--swing-days", "30", "--no-playbook"])
        self.assertEqual(code, 0, out + err)

    def test_playbook_freshness(self):
        self.assertEqual(lab().load_playbook()[0], None)
        self.write_state("backtests/playbook.json", {"generated_at": "2026-10-01T00:00:00Z", "entries": {}})
        pb, problem = lab().load_playbook()
        self.assertIsNone(pb)
        self.assertIn("days old", problem)
        self.write_state("backtests/playbook.json", {"generated_at": "2026-10-19T00:00:00Z", "entries": {}})
        self.assertIsNotNone(lab().load_playbook()[0])


def entry(symbol, setup, interval, stop="atr", atr_mult=3.0, target_r=0.5, horizon="4h"):
    return {"symbol": symbol, "display": symbol, "setup": setup, "interval": interval, "stop": stop,
            "atr_mult": atr_mult, "target_r": target_r, "horizon": horizon, "exit_text": "test",
            "test": {"n": 40, "win_rate": 0.7, "expectancy_r": 0.12, "profit_chance": 0.8, "profit_factor": 1.5},
            "train": {"n": 80, "win_rate": 0.68, "expectancy_r": 0.1}}


class Autopilot(TraderTestCase):
    NOW = "2026-10-20T14:30:00Z"

    def setUp(self):
        super().setUp()
        config.ensure_home()
        doc = json.loads((self.home / "config.json").read_text())
        doc["autopilot"] = {"universe": {"mode": "watchlist"}}
        (self.home / "config.json").write_text(json.dumps(doc))

    def decisions(self):
        return state.read_jsonl("autopilot/decisions.jsonl")

    def test_no_playbook_no_crypto(self):
        res = ap().run_cycle("2026-10-20T14:40:00Z", approved=True)
        self.assertNotEqual(res["status"], "error", res)
        self.assertFalse([d for d in self.decisions() if d["asset"] == "crypto"])
        st = state.read_json("autopilot/state.json")
        self.assertTrue(any("no backtest-lab playbook" in n for n in st["notes"]))
        self.assertEqual(st["playbook"]["entries"], 0)

    def test_playbook_exits_are_used(self):
        self.write_state("backtests/playbook.json", {
            "generated_at": "2026-10-20T00:00:00Z", "valid_until": "2026-11-03T00:00:00Z",
            "entries": {"BTCUSDT:asia_range@5m": entry("BTCUSDT", "asia_range", "5m")}})
        ap().run_cycle("2026-10-20T14:40:00Z", approved=True)
        btc = [d for d in self.decisions() if d["id"] == "BTCUSDT-20261020-asia_range"]
        self.assertEqual(len(btc), 1, self.decisions())
        plan = state.read_json("plan.json")["plans"]["BTCUSDT-20261020-asia_range"]
        risk = plan["entry"]["price"] - plan["stop"]["price"]
        self.assertAlmostEqual(plan["target"]["price"], plan["entry"]["price"] + 0.5 * risk, delta=0.02)
        self.assertEqual(plan["stop"]["method"], "atr")
        self.assertEqual(plan["horizon"]["label"], "next 4h")
        self.assertEqual(plan["playbook"], "BTCUSDT:asia_range@5m")
        bt = state.read_json("backtests/BTCUSDT-asia_range.json")
        self.assertEqual((bt["source"], bt["triggers"], bt["expectancy_r"]), ("backtest lab", 40, 0.12))
        # coins that are not in the playbook are never looked at
        self.assertFalse([d for d in self.decisions() if d["symbol"] in ("ETH/USDT", "SOL/USDT")])

    def test_validated_swing_setup_is_traded_on_its_own_bars(self):
        # find an hour in the fixtures where oversold_bounce fired on the newest closed 1h bar
        btc = symbols.parse("BTCUSDT", asset="crypto")
        found = None
        for hours_back in range(6, 240):
            t = mc.ts("2026-10-20T20:00:00Z") - hours_back * 3600
            s = data.get_candles(btc, "1h", days=12, asset="crypto", end=mc.iso(t))
            sig = setups.series_signals("oversold_bounce", s.candles, "1h", start_ts=s.candles[-1].t)
            if sig and s.candles[-1].t + 3600 <= t:
                found = (t, sig[0])
                break
        self.assertIsNotNone(found, "the fixtures have no oversold_bounce signal to test with")
        t, sig = found
        self.write_state("backtests/playbook.json", {
            "generated_at": mc.iso(t - 86400), "valid_until": mc.iso(t + 13 * 86400),
            "entries": {"BTCUSDT:oversold_bounce@1h": entry("BTCUSDT", "oversold_bounce", "1h", horizon="24h")}})
        res = ap().run_cycle(mc.iso(t + 60), approved=True)
        self.assertNotEqual(res["status"], "error", res)
        did = setups.setup_id("BTCUSDT", sig["window"], "oversold_bounce")
        d = [x for x in self.decisions() if x["id"] == did]
        self.assertEqual(len(d), 1, [x["id"] for x in self.decisions()])
        plan = state.read_json("plan.json")["plans"][did]
        self.assertEqual((plan["interval"], plan["horizon"]["label"]), ("1h", "next 24h"))
        self.assertEqual(plan["entry"]["price"], sig["trigger"]["price"])
        # the next minute does not judge the same signal again
        ap().run_cycle(mc.iso(t + 120), approved=True)
        self.assertEqual(len([x for x in self.decisions() if x["id"] == did]), 1)

    def test_confidence_sizing_is_applied_and_shown(self):
        doc = json.loads((self.home / "config.json").read_text())
        doc["autopilot"]["news_gate"] = {"enabled": False}  # the fixture day has a market-wide delisting headline
        (self.home / "config.json").write_text(json.dumps(doc))
        e = entry("BTCUSDT", "asia_range", "5m")
        e["test"].update(profit_chance=0.95, n=60)
        self.write_state("backtests/playbook.json", {
            "generated_at": "2026-10-20T00:00:00Z", "valid_until": "2026-11-03T00:00:00Z",
            "entries": {"BTCUSDT:asia_range@5m": e}})
        ap().run_cycle("2026-10-20T14:40:00Z", approved=True)
        d = [x for x in self.decisions() if x["id"] == "BTCUSDT-20261020-asia_range"][0]
        self.assertEqual(d["desk"]["status"], "GO", d["reasons"])
        g = [g for g in d["gates"] if g["name"] == "confidence sizing"]
        self.assertEqual(len(g), 1)
        self.assertIn("risk × 2", g[0]["detail"])
        self.assertIn("limits.json still caps it", g[0]["detail"])
        self.assertEqual(d["action"], "taken")
        order = [o for o in state.read_json("orders.json")["orders"] if o["id"] == d["order_id"]][0]
        self.assertLessEqual(order["risk_usd"], config.load_limits()["crypto"]["max_risk_per_trade_usd"] + 1e-6)

    def test_validated_coins_outside_the_universe_are_watched(self):
        self.write_state("backtests/playbook.json", {
            "generated_at": "2026-10-20T00:00:00Z", "valid_until": "2026-11-03T00:00:00Z",
            "entries": {"XRPUSDT:asia_range@5m": entry("XRPUSDT", "asia_range", "5m"),
                        "DOGEUSDT:asia_range@5m": entry("DOGEUSDT", "asia_range", "5m")}})
        doc = json.loads((self.home / "config.json").read_text())
        doc["autopilot"]["universe"]["exclude"] = ["DOGE"]
        (self.home / "config.json").write_text(json.dumps(doc))
        ap().run_cycle("2026-10-20T14:40:00Z", approved=True)
        st = state.read_json("autopilot/state.json")
        self.assertTrue(any("also watching XRPUSDT" in n for n in st["notes"]), st["notes"])
        self.assertFalse(any("DOGE" in n for n in st["notes"] if "also watching" in n))
        self.assertEqual(state.read_json("autopilot/scan.json")["crypto"]["total"], 1)  # only validated coins are scanned

    def test_status_shows_the_playbook(self):
        ap().run_cycle("2026-10-20T14:40:00Z", approved=True)
        code, out, _ = self.run_tool("trader-autopilot", "autopilot", ["status"])
        self.assertEqual(code, 0)
        self.assertIn("Crypto playbook: no backtest-lab playbook yet", out)


class ConfidenceSizing(TraderTestCase):
    def test_tiers_and_caps(self):
        cfg = config.load_config()
        cm = ap().confidence_mult
        e = entry("BTCUSDT", "asia_range", "5m")
        e["test"].update(profit_chance=0.93, n=40)
        self.assertEqual(cm(e, cfg)[0], 2.0)
        e["test"].update(profit_chance=0.84)
        self.assertEqual(cm(e, cfg)[0], 1.5)
        e["test"].update(profit_chance=0.72)
        self.assertEqual(cm(e, cfg)[0], 1.0)
        e["test"].update(profit_chance=0.55)
        self.assertEqual(cm(e, cfg)[0], 0.5)
        e["test"].update(profit_chance=0.95, n=12)  # sure-looking, but too few unseen trades to size up
        mult, why = cm(e, cfg)
        self.assertEqual(mult, 1.0)
        self.assertIn("too few", why)
        self.assertEqual(cm(None, cfg), (1.0, None))
        cfg["autopilot"]["playbook"]["max_risk_mult"] = 1.25
        e["test"].update(n=50)
        self.assertEqual(cm(e, cfg)[0], 1.25)

    def test_bigger_size_never_lifts_the_hard_cap(self):
        cfg, limits = config.load_config(), config.load_limits()
        c2, l2 = ap()._scaled(cfg, limits, "crypto", 2.0)
        self.assertEqual(c2["risk_per_trade_pct"], 2 * cfg["risk_per_trade_pct"])
        self.assertEqual(l2["crypto"]["max_risk_per_trade_usd"], limits["crypto"]["max_risk_per_trade_usd"])
        c3, l3 = ap()._scaled(cfg, limits, "crypto", 0.5)
        self.assertEqual(l3["crypto"]["max_risk_per_trade_usd"], 0.5 * limits["crypto"]["max_risk_per_trade_usd"])

    def test_min_target_r_keeps_only_big_targets(self):
        coins = [(symbols.parse("AAAUSDT", asset="crypto"), synthetic(5), 0.01)]
        now = coins[0][1][-1].t + 3600
        args = lab().build_parser().parse_args(["--min-pooled", "20", "--min-pooled-test", "10", "--fee-bps", "0",
                                                "--slippage-bps", "0", "--swing-days", "125", "--min-target-r", "3",
                                                "--objective", "profit"])
        fam, rows, _ = lab().study_family("oversold_bounce", "1h", coins, now, args, load("trader-exit", "exit"), 0.0)
        for pick in (fam["exit"], (fam["highest_win"] or {}).get("exit")):
            if pick:
                self.assertGreaterEqual(pick["target_r"], 3)


def daily_uptrend(seed: int, days: int = 1500, start: int = 1577836800) -> list:
    """Daily bars: a steady uptrend with a 3-day dip every 20 days that recovers within two days."""
    rng = random.Random(seed)
    out, px = [], 100.0
    for i in range(days):
        k = i % 20
        move = -0.03 if k in (14, 15, 16) else (0.05 if k in (17, 18) else 0.004 + rng.uniform(-0.01, 0.01))
        o, c = px, px * (1 + move)
        out.append(Candle(start + i * 86400, o, max(o, c) * 1.01, min(o, c) * 0.99, c, 1000.0))
        px = c
    return out


class DailyDip(TraderTestCase):
    def test_signal_needs_bitcoin_above_its_200_day_average(self):
        coin = daily_uptrend(1)
        up = {"btc_up": setups.regime_map(daily_uptrend(9))}
        down = {"btc_up": {c.t: False for c in coin}}
        self.assertGreater(len(setups.series_signals("dip_in_uptrend", coin, "1d", context=up)), 20)
        self.assertEqual(setups.series_signals("dip_in_uptrend", coin, "1d", context=down), [])
        self.assertEqual(setups.series_signals("dip_in_uptrend", coin, "1d"), [])  # no context = no regime = no trade

    def test_rule_exit_trades_one_at_a_time(self):
        coin = daily_uptrend(2)
        ctx = {"btc_up": setups.regime_map(daily_uptrend(9))}
        trades = lab().rule_trades(coin, "dip_in_uptrend", "1d", 0.0, ctx)
        self.assertGreater(len(trades), 20)
        rs = [t[1][lab().RULE_KEY] for t in trades]
        self.assertGreater(sum(1 for r in rs if r > 0) / float(len(rs)), 0.8)
        times = [t[0] for t in trades]
        self.assertEqual(times, sorted(set(times)))

    def test_lab_validates_the_daily_rule_and_writes_the_exit_rule(self):
        coins = [(symbols.parse(s, asset="crypto"), daily_uptrend(i, days=2400), 0.01)
                 for i, s in enumerate(("AAAUSDT", "BBBUSDT"))]
        now = coins[0][1][-1].t + 86400
        args = lab().build_parser().parse_args(["--daily-days", "2400", "--fee-bps", "0", "--slippage-bps", "0",
                                                "--min-target-r", "3"])  # a target filter must not hide a rule exit
        ctx = {"btc_up": setups.regime_map(daily_uptrend(9, days=2400))}
        fam, rows, picks = lab().study_family("dip_in_uptrend", "1d", coins, now, args, load("trader-exit", "exit"),
                                              0.0, ctx)
        self.assertTrue(fam["validated"], fam["verdict"])
        self.assertEqual(fam["exit"]["exit_rule"]["n"], 5)
        self.assertIsNone(fam["exit"]["target_r"])
        self.assertEqual((fam["exit"]["stop"], fam["exit"]["horizon"]), ("rule", "10d"))
        self.assertIn("3×ATR stop", fam["exit"]["text"])
        self.assertIsNone(fam["highest_win"])
        self.assertEqual(picks, [])
        pb = lab().write_playbook({"generated_at": "2026-10-20T00:00:00Z", "objective": "profit", "costs": {},
                                   "days": {}, "summary": {"families_validated": 1}, "validated": rows}, now)
        e = pb["entries"]["AAAUSDT:dip_in_uptrend@1d"]
        self.assertEqual((e["interval"], e["exit_rule"]["type"]), ("1d", "close_above_sma"))


class DailyAutopilot(TraderTestCase):
    NOW = "2026-10-20T00:01:00Z"
    END = 1792454400  # 2026-10-20T00:00:00Z — the daily bar of Oct 19 has just closed

    def setUp(self):
        super().setUp()
        config.ensure_home()
        doc = json.loads((self.home / "config.json").read_text())
        doc["autopilot"] = {"universe": {"mode": "watchlist"}, "news_gate": {"enabled": False}}
        (self.home / "config.json").write_text(json.dumps(doc))
        days = 20 * 20 + 17  # the last closed bar is the third down day of a dip
        self.daily = {"ETHUSDT": daily_uptrend(4, days=days, start=self.END - days * 86400),
                      "BTCUSDT": daily_uptrend(8, days=days, start=self.END - days * 86400)}
        real = data.get_candles

        def fake(symbol, interval="5m", days=None, asset=None, end=None, quote=None):
            sym = data.as_symbol(symbol, asset)
            if interval == "1d" and sym.key in self.daily:
                now = mc.ts(mc.now_utc())
                bars = [c for c in self.daily[sym.key] if c.t + 86400 <= now]
                return data.Series(sym, "1d", bars, "test", [], {})
            return real(symbol, interval, days=days, asset=asset, end=end, quote=quote)
        data.get_candles = fake
        self.addCleanup(setattr, data, "get_candles", real)
        e = entry("ETHUSDT", "dip_in_uptrend", "1d", stop="atr", atr_mult=3.0, target_r=None, horizon="10d")
        e["exit_rule"] = dict(setups.exit_rule("dip_in_uptrend"))
        self.write_state("backtests/playbook.json", {
            "generated_at": "2026-10-19T00:00:00Z", "valid_until": "2026-11-02T00:00:00Z",
            "entries": {"ETHUSDT:dip_in_uptrend@1d": e}})

    def test_daily_signal_becomes_a_rule_exit_plan(self):
        sig = setups.series_signals("dip_in_uptrend", self.daily["ETHUSDT"], "1d",
                                    context={"btc_up": setups.regime_map(self.daily["BTCUSDT"])})
        self.assertEqual(sig[-1]["trigger"]["t"], self.END - 86400)
        res = ap().run_cycle(self.NOW, approved=True)
        self.assertNotEqual(res["status"], "error", res)
        did = setups.setup_id("ETHUSDT", sig[-1]["window"], "dip_in_uptrend")
        d = [x for x in state.read_jsonl("autopilot/decisions.jsonl") if x["id"] == did]
        self.assertEqual(len(d), 1, state.read_jsonl("autopilot/decisions.jsonl"))
        plan = state.read_json("plan.json")["plans"][did]
        self.assertEqual((plan["interval"], plan["exit_rule"]["n"], plan["stop"]["method"]), ("1d", 5, "rule"))
        self.assertIn("3×ATR", plan["stop"]["note"])
        self.assertEqual(mc.ts(plan["time_stop"]["at"]) - mc.ts(plan["entry"]["time"]), 10 * 86400)
        self.assertIn("exit rule decides", plan["target"]["note"])
        self.assertFalse(list((self.home / "timemachine").glob("ETHUSDT-*")))  # no replay for a rule exit
        desk = state.read_json("desk/%s/desk.json" % did)
        tm = [g for g in desk["gates"] if g["name"] == "Time Machine"][0]
        self.assertTrue(tm["ok"])
        self.assertIn("not applicable", tm["detail"])
        self.assertEqual(desk["status"], "GO", desk.get("headline"))

    def test_bitcoin_below_its_200_day_average_switches_it_off(self):
        self.daily["BTCUSDT"] = [Candle(c.t, c.o, c.h, c.l, 50.0 if i == len(self.daily["BTCUSDT"]) - 1 else c.c, c.v)
                                 for i, c in enumerate(self.daily["BTCUSDT"])]
        ap().run_cycle(self.NOW, approved=True)
        self.assertFalse([x for x in state.read_jsonl("autopilot/decisions.jsonl") if "dip_in_uptrend" in x["id"]])


class RuleExit(TraderTestCase):
    NOW = "2026-10-20T00:02:00Z"

    def item(self, filled_at="2026-10-17T00:01:00Z"):
        return {"plan_id": "p", "order_id": "o", "symbol": "ETH/USD", "data_key": "ETHUSDT", "asset": "crypto",
                "qty": 1.0, "stop": 1.0, "target": 1e9, "time_stop": "2026-10-27T00:00:00Z", "status": "open",
                "placed_at": "2026-10-17T00:00:30Z", "filled_at": filled_at, "broker": "alpaca", "mode": "paper",
                "exit_rule": {"type": "close_above_sma", "n": 5, "interval": "1d", "text": "x"}}

    def closes(self, closes):
        real = data.get_candles
        start = 1792454400 - len(closes) * 86400

        def fake(symbol, interval="5m", days=None, asset=None, end=None, quote=None):
            bars = [Candle(start + i * 86400, c, c, c, c, 1.0) for i, c in enumerate(closes)]
            return data.Series(data.as_symbol(symbol, asset), interval, bars, "test", [], {})
        data.get_candles = fake
        self.addCleanup(setattr, data, "get_candles", real)

    def test_closes_when_the_daily_close_is_back_above_the_5_day_average(self):
        from tests.test_autopilot import FakeBroker
        self.closes([100, 98, 96, 94, 92, 99])
        b = FakeBroker()
        b.pos = [{"symbol": "ETH/USD", "asset": "crypto", "qty": 1.0, "last": 99.0}]
        book = {"items": {"p": self.item()}, "handled": {}}
        acts = ap().manage_exits(b, book, b.pos, [])
        self.assertEqual(book["items"]["p"]["exit_reason"], "rule")
        self.assertIn("above the 5-bar average", book["items"]["p"]["exit_note"])
        self.assertEqual(b.calls[-1], ("close", "ETH/USD"))
        self.assertTrue(acts)

    def test_waits_while_below_and_ignores_bars_before_the_fill(self):
        from tests.test_autopilot import FakeBroker
        self.closes([100, 98, 96, 94, 92, 91])
        b = FakeBroker()
        b.pos = [{"symbol": "ETH/USD", "asset": "crypto", "qty": 1.0, "last": 91.0}]
        book = {"items": {"p": self.item()}, "handled": {}}
        self.assertEqual(ap().manage_exits(b, book, b.pos, []), [])
        self.closes([100, 98, 96, 94, 92, 99])
        book = {"items": {"p": self.item(filled_at="2026-10-20T00:01:00Z")}, "handled": {}}
        self.assertEqual(ap().manage_exits(b, book, b.pos, []), [])  # that close happened before we owned it


class TrendBreakout(TraderTestCase):
    def test_breakout_signal_and_rule_exit(self):
        coin = daily_uptrend(3, days=600)
        ctx = {"btc_up": setups.regime_map(daily_uptrend(9, days=600))}
        sigs = setups.series_signals("trend_breakout", coin, "1d", context=ctx)
        self.assertGreater(len(sigs), 5)
        for s in sigs[:5]:
            i = s["trigger"]["index"]
            self.assertGreater(coin[i].c, max(c.c for c in coin[i - 20:i]))
        self.assertEqual(setups.series_signals("trend_breakout", coin, "1d", context={"btc_up": {}}), [])
        trades = lab().rule_trades(coin, "trend_breakout", "1d", 0.0, ctx)
        self.assertTrue(trades)

    def test_rule_says_exit(self):
        below = {"type": "close_below_low", "n": 3}
        self.assertTrue(setups.rule_says_exit(below, [10, 11, 12, 9], 3))
        self.assertFalse(setups.rule_says_exit(below, [10, 11, 12, 10.5], 3))
        above = {"type": "close_above_sma", "n": 3}
        self.assertTrue(setups.rule_says_exit(above, [10, 9, 8, 10], 3))
        self.assertFalse(setups.rule_says_exit(above, [10, 9, 8, 8.5], 3))

    def test_autopilot_closes_a_trend_trade_below_the_10_day_low(self):
        from tests.test_autopilot import FakeBroker
        rx = RuleExit("test_closes_when_the_daily_close_is_back_above_the_5_day_average")
        rx.addCleanup = self.addCleanup
        rx.closes([100 + i for i in range(12)] + [95])
        it = rx.item()
        it["exit_rule"] = {"type": "close_below_low", "n": 10, "interval": "1d", "text": "x"}
        b = FakeBroker()
        b.pos = [{"symbol": "ETH/USD", "asset": "crypto", "qty": 1.0, "last": 95.0}]
        book = {"items": {"p": it}, "handled": {}}
        ap().manage_exits(b, book, b.pos, [])
        self.assertEqual(book["items"]["p"]["exit_reason"], "rule")
        self.assertIn("below the lowest close of the previous 10 bars", book["items"]["p"]["exit_note"])



class UserStrategies(TraderTestCase):
    def test_stop_rules(self):
        bars = [Candle(i, 100, 101, 99 - (i == 5) * 4, 100, 1) for i in range(12)]
        self.assertEqual(setups.rule_stop("trend_ema", bars, 11, {}, 2.0), 95)       # the swing low 95 is lower
        self.assertEqual(setups.rule_stop("trend_ema", bars[6:], 5, {}, 2.0), 98)    # swing low 99 → at least 1 ATR
        self.assertEqual(setups.rule_stop("breakout_volume", bars, 11, {"trigger_level": 104}, 2.0), 102)
        self.assertEqual(setups.rule_stop("trend_breakout", bars, 11, {}, 2.0), 94)  # 3 × ATR

    def test_close_below_ema_exit_with_and_without_cache(self):
        from shared import indicators
        closes = [100 + i for i in range(60)] + [120]
        rule = {"type": "close_below_ema", "n": 50}
        cache = {("ema", 50): indicators.ema(closes, 50)}
        self.assertTrue(setups.rule_says_exit(rule, closes, 60, cache))
        self.assertEqual(setups.rule_says_exit(rule, closes, 60), setups.rule_says_exit(rule, closes, 60, cache))
        self.assertFalse(setups.rule_says_exit(rule, closes, 59, cache))

    def test_trend_ema_fires_once_when_the_trend_is_confirmed(self):
        coin = daily_uptrend(5, days=700)
        ctx = {"btc_up": setups.regime_map(daily_uptrend(9, days=700))}
        sigs = setups.series_signals("trend_ema", coin, "1d", context=ctx)
        idx = [s["trigger"]["index"] for s in sigs]
        self.assertTrue(idx)
        self.assertEqual(len(idx), len(set(idx)))
        trades = lab().rule_trades(coin, "trend_ema", "1d", 0.0, ctx)
        self.assertTrue(all(len(t[1]) == 1 for t in trades))
