"""Let winners ride: the lab's check, the plan, the partial sale, the ride and its end — in the simulator."""
from __future__ import annotations

import unittest

from shared import config, data, setups, state
from shared.brokers.simulator import SimBroker
from shared.indicators import Candle
from tests.helpers import TraderTestCase, load
from tests.test_lab import ap, entry, lab

DAY = 86400
END = 1792454400  # 2026-10-20T00:00:00Z


def fake_closes(case, closes, end=END):
    """Every price request (daily rules, the simulator's last price) sees these daily closes, the last one just closed."""
    real = data.get_candles
    start = end - len(closes) * DAY

    def fake(symbol, interval="5m", days=None, asset=None, end=None, quote=None):
        bars = [Candle(start + i * DAY, c, c, c, c, 1.0) for i, c in enumerate(closes)]
        return data.Series(data.as_symbol(symbol, asset), interval, bars, "test", [], {})
    data.get_candles = fake
    case.addCleanup(setattr, data, "get_candles", real)


RIDE = {"keep": 0.67, "min_sma": 200, "status": "planned",
        "exit_rule": dict(setups.runner("trend_breakout")["exit_rule"], interval="1d")}


class LabChecksTheRide(TraderTestCase):
    def test_runner_r_beats_selling_everything_in_a_steady_trend(self):
        coin, px = [], 100.0  # 30 days up 1 % a day, then a 4-day pullback that breaks the 10-day low, not the trend
        for i in range(900):
            o, px = px, px * (0.985 if i % 34 >= 30 else 1.01)
            coin.append(Candle(END - (900 - i) * DAY, o, max(o, px) * 1.005, min(o, px) * 0.995, px, 1000.0))
        ctx = {"btc_up": setups.regime_map(coin)}
        trades = lab().rule_trades(coin, "trend_breakout", "1d", 0.0026, ctx)
        both = [res for _, res in trades if lab().RUNNER_KEY in res]
        self.assertTrue(both)
        rule = sum(r[lab().RULE_KEY] for r in both) / len(both)
        ride = sum(r[lab().RUNNER_KEY] for r in both) / len(both)
        self.assertGreater(ride, rule)
        for r in both:  # a loser never rides: its result is the same either way
            if r[lab().RULE_KEY] <= 0:
                self.assertEqual(r[lab().RUNNER_KEY], r[lab().RULE_KEY])
        self.assertEqual([res for _, res in lab().rule_trades(coin, "trend_ema", "1d", 0.0, ctx)
                          if lab().RUNNER_KEY in res], [])  # no runner rule, no runner

    def test_verdict(self):
        base = {"expectancy_r": 0.5, "profit_chance": 0.9, "n": 50, "win_rate": 0.4}
        good = lab().runner_verdict("trend_breakout", base, [1.0, -0.2, 2.0, 0.4] * 15, [(0.5, 0.9)])
        self.assertTrue(good["helps"], good["why"])
        self.assertIn("two thirds", good["why"])
        bad = lab().runner_verdict("trend_breakout", base, [0.1, -0.5, 0.2, 0.3] * 15, [(0.5, 0.0)])
        self.assertFalse(bad["helps"])
        self.assertIn("sells everything", bad["why"])

    def test_playbook_carries_the_verdict(self):
        verdict = lab().runner_verdict("trend_breakout", {"expectancy_r": 0.5, "profit_chance": 0.9},
                                       [1.0, 0.4, 2.0, -0.2] * 15, [(0.5, 0.9)])
        row = {"symbol": "ETHUSDT", "display": "ETH/USDT", "setup": "trend_breakout", "timeframe": "1d",
               "exit": lab().exit_label(lab().RULE_KEY, "trend_breakout"),
               "test": {"n": 30, "win_rate": 0.4, "expectancy_r": 0.6, "profit_chance": 0.9, "profit_factor": 2},
               "train": {"n": 60, "win_rate": 0.4, "expectancy_r": 0.5}}
        pb = lab().write_playbook({"generated_at": "2026-10-20T00:00:00Z", "objective": "profit", "costs": {},
                                   "days": {}, "summary": {"families_validated": 1}, "validated": [row],
                                   "families": [{"setup": "trend_breakout", "timeframe": "1d", "runner": verdict}]},
                                  END)
        r = pb["entries"]["ETHUSDT:trend_breakout@1d"]["runner"]
        self.assertTrue(r["helps"])
        self.assertEqual(r["exit_rule"]["type"], "close_below_ema")


class RunnerPlan(TraderTestCase):
    def cand(self, verdict=None):
        e = entry("ETHUSDT", "trend_breakout", "1d")
        if verdict is not None:
            e["runner"] = {"helps": verdict, "why": "lab says so" if verdict else "it did not pay"}
        return {"setup": "trend_breakout", "playbook": e}

    def test_off_unless_turned_on_and_the_lab_agrees(self):
        cfg = config.load_config()
        r, note = ap().runner_plan(self.cand(True), cfg)
        self.assertIsNone(r)
        self.assertIn("off", note)
        cfg["autopilot"]["runner"]["enabled"] = True
        r, note = ap().runner_plan(self.cand(None), cfg)
        self.assertIsNone(r)
        self.assertIn("has not checked", note)
        r, note = ap().runner_plan(self.cand(False), cfg)
        self.assertIsNone(r)
        self.assertIn("it did not pay", note)
        r, note = ap().runner_plan(self.cand(True), cfg)
        self.assertEqual((r["keep"], r["status"], r["exit_rule"]["n"]), (0.67, "planned", 50))
        self.assertIn("sell a third, two thirds ride on", note)
        cfg["autopilot"]["runner"]["require_lab"] = False
        self.assertIsNotNone(ap().runner_plan(self.cand(None), cfg)[0])
        self.assertEqual(ap().runner_plan({"setup": "trend_ema", "playbook": {}}, cfg), (None, None))

    def test_profile_turns_it_on(self):
        res = self.run_json("trader-autopilot", "autopilot", ["profile", "--capital", "1000"])
        self.assertTrue(res["config"]["autopilot"]["runner"]["enabled"])
        res = self.run_json("trader-autopilot", "autopilot", ["profile", "--capital", "1000", "--no-runner"])
        self.assertFalse(res["config"]["autopilot"]["runner"]["enabled"])


class RideInTheSimulator(TraderTestCase):
    NOW = "2026-10-20T00:02:00Z"
    RISING = [60 + 0.3 * i for i in range(240)]  # ends near 131.7; the 200-day average is near 102

    def setUp(self):
        super().setUp()
        config.ensure_home()
        self.cfg = config.load_config()
        self.cfg["autopilot"]["runner"]["enabled"] = True
        self.broker = SimBroker(self.cfg)
        self.broker.book["positions"]["ETH/USD"] = {"symbol": "ETH/USD", "asset": "crypto", "qty": 3.0,
                                                    "avg_entry": 100.0, "opened_at": "2026-10-10T00:01:00Z"}
        self.broker.book["cash"] -= 300.0
        self.broker._save()
        journal = load("trader-journal", "journal")
        journal.save_trade({"id": "trd-p", "plan_id": "p", "symbol": "ETH/USD", "symbol_key": "ETHUSDT",
                            "display": "ETH/USD", "asset": "crypto", "setup": "trend_breakout", "status": "open",
                            "qty": 3.0, "qty_unit": "coins", "entry": {"time": "2026-10-10T00:01:00Z", "price": 100.0},
                            "exit": None, "stop": 90.0, "target": 200.0, "risk_per_unit": 10.0, "fees_usd": 0.0,
                            "slippage_usd": 0.0, "pnl_usd": None, "r_multiple": None, "paper": True, "notes": "",
                            "source": "autopilot", "broker": "simulator"})
        self.book = {"handled": {}, "items": {"p": {
            "plan_id": "p", "order_id": "ord-p", "symbol": "ETH/USD", "data_key": "ETHUSDT", "asset": "crypto",
            "qty": 3.0, "qty_unit": "coins", "stop": 90.0, "target": 200.0, "time_stop": "2026-12-01T00:00:00Z",
            "status": "open", "placed_at": "2026-10-10T00:00:30Z", "filled_at": "2026-10-10T00:01:00Z",
            "broker": "simulator", "mode": "simulator", "entry_fill": 100.0, "trade_id": "trd-p",
            "setup": "trend_breakout", "exit_rule": dict(setups.exit_rule("trend_breakout"), interval="1d"),
            "runner": dict(RIDE)}}}

    def cycle(self):
        b = self.broker
        b.sync()
        acts = ap().manage_exits(b, self.book, b.positions(), b.orders(), self.cfg)
        b.sync()
        acts += ap().reconcile(b, self.book, b.positions(), b.orders(), self.cfg, config.load_limits())
        return acts

    def test_sells_a_third_rides_two_thirds_then_leaves_when_the_trend_breaks(self):
        it = self.book["items"]["p"]
        self.assertIn("sells only a third and lets two thirds ride", ap().position_story(it))
        fake_closes(self, self.RISING + [118.0])  # below the 10-day low, in profit, above the 200-day average
        acts = self.cycle()
        self.assertTrue(any("sold 0.99" in a for a in acts), acts)
        self.assertEqual(it["runner"]["status"], "riding")
        self.assertAlmostEqual(it["qty"], 2.01)
        self.assertEqual(it["stop"], 100.0)  # the stop moved to the buy price
        self.assertEqual(it["exit_rule"]["type"], "close_below_ema")
        self.assertEqual(it["status"], "open")
        journal = load("trader-journal", "journal")
        sold, rest = journal.get_trade("trd-p"), journal.get_trade("trd-p-ride")
        self.assertEqual((sold["status"], sold["qty"], sold["exit"]["reason"]), ("closed", 0.99, "rule"))
        self.assertGreater(sold["r_multiple"], 1.5)
        self.assertEqual((rest["status"], rest["qty"], rest["stop"]), ("open", 2.01, 100.0))
        stops = [o for o in self.broker.open_orders() if o["leg"] == "stop"]
        self.assertEqual([(o["qty"], o["stop_price"]) for o in stops], [(2.01, 100.0)])
        self.assertAlmostEqual(self.broker.positions()[0]["qty"], 2.01)
        story = ap().position_story(it)
        self.assertIn("rides the trend", story)
        self.assertIn("can no longer turn into a loss", story)
        # the same bar does not end the ride; a later close below the 50-day EMA does
        self.assertEqual([a for a in self.cycle() if "exit" in a], [])
        self.set_now("2026-10-21T00:02:00Z")
        fake_closes(self, self.RISING + [118.0, 112.0], end=END + DAY)
        self.cycle()
        self.assertEqual(it["status"], "closed", it)
        self.assertEqual(it["exit_reason"], "rule")
        rest = journal.get_trade("trd-p-ride")
        self.assertEqual((rest["status"], rest["exit"]["reason"]), ("closed", "rule"))
        self.assertGreater(rest["pnl_usd"], 0)
        self.assertEqual(self.broker.positions(), [])
        from shared import adapt
        rows = adapt._closed_trades(1e12)  # the ride is judged with the trade it came from, as in the backtest
        self.assertEqual([t["key"] for t in rows], ["ETHUSDT"])

    def test_a_loser_or_a_broken_trend_sells_everything(self):
        it = self.book["items"]["p"]
        fake_closes(self, self.RISING[:20] + [99.0] * 230 + [98.0])  # below the buy price
        self.cycle()
        self.assertEqual(it["runner"]["status"], "skipped")
        self.assertIn("not in profit", it.get("exit_note") or load("trader-journal", "journal")
                      .get_trade("trd-p")["notes"])
        self.assertEqual(it["status"], "closed")

    def test_below_the_200_day_average_there_is_no_trend_to_ride(self):
        it = self.book["items"]["p"]
        fake_closes(self, [200.0] * 200 + [130 - i for i in range(10)] + [110.0])
        self.cycle()
        self.assertEqual(it["runner"]["status"], "skipped")
        self.assertEqual(it["status"], "closed")
        trade = load("trader-journal", "journal").get_trade("trd-p")
        self.assertIn("below its 200-day average", trade["notes"])



class RideAtARealBroker(RideInTheSimulator):
    """A broker that fills later: the sale is picked up by reconcile; a rejected one sells everything at once."""

    def broker_that_waits(self):
        from tests.test_autopilot import FakeBroker

        class Later(FakeBroker):
            def place_exit(self, symbol, qty, kind="market", limit_price=None, client_order_id=None, asset="crypto"):
                self.calls.append(("exit", symbol, qty))
                o = {"id": "part-1", "symbol": symbol, "side": "sell", "status": "new", "leg": "exit", "qty": qty}
                self.ords.append(o)
                return dict(o)
        b = Later()
        b.pos = [{"symbol": "ETH/USD", "asset": "crypto", "qty": 3.0, "last": 118.0}]
        return b

    def test_sells_a_third_rides_two_thirds_then_leaves_when_the_trend_breaks(self):
        b = self.broker_that_waits()
        it = self.book["items"]["p"]
        fake_closes(self, self.RISING + [118.0])
        ap().manage_exits(b, self.book, b.pos, b.ords, self.cfg)
        self.assertEqual(it["runner"]["status"], "selling")
        self.assertEqual(ap().manage_exits(b, self.book, b.pos, b.ords, self.cfg), [])  # waits for the fill
        b.ords[-1].update(status="filled", filled_qty=0.99, filled_avg_price=118.0, filled_at="2026-10-20T00:03:00Z")
        b.pos[0]["qty"] = 2.01
        acts = ap().reconcile(b, self.book, b.pos, b.ords, self.cfg, config.load_limits())
        self.assertTrue(any("sold 0.99" in a for a in acts), acts)
        self.assertEqual((it["runner"]["status"], it["stop"]), ("riding", 100.0))
        self.assertIn(("stop", "ETH/USD", 2.01, 100.0), b.calls)

    def test_a_loser_or_a_broken_trend_sells_everything(self):
        b = self.broker_that_waits()
        it = self.book["items"]["p"]
        fake_closes(self, self.RISING + [118.0])
        ap().manage_exits(b, self.book, b.pos, b.ords, self.cfg)
        b.ords[-1]["status"] = "rejected"
        acts = ap().reconcile(b, self.book, b.pos, b.ords, self.cfg, config.load_limits())
        self.assertEqual(it["runner"]["status"], "failed")
        self.assertEqual(b.calls[-1], ("close", "ETH/USD"))
        self.assertTrue(any("sold everything instead" in a for a in acts), acts)

    def test_below_the_200_day_average_there_is_no_trend_to_ride(self):
        pass  # same rule as in the simulator


if __name__ == "__main__":
    unittest.main()
