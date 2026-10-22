"""Round six: a €1,000 account — limits that hold it back as it grows, a daily limit that sells nothing for a strategy
held for weeks, another account's equity, crypto quantities the broker can't sell to the last coin; a runner's part
sale and an order still working tomorrow; your own holdings across a split and across midnight; the simulator's
coarse bars."""
from __future__ import annotations

import gzip
import json
import os
import time
from unittest import mock

from shared import adapt, config, data, market_clock as mc, state
from shared.brokers import BrokerError
from shared.brokers.simulator import SimBroker
from shared.indicators import Candle
from tests import test_autopilot as _ta
from tests.helpers import TraderTestCase, load
from tests.test_autopilot import FakeBroker, Seller


def ap():
    return load("trader-autopilot", "autopilot")


def _only_own(cls, base):
    for name in dir(base):  # the parent's tests run in their own module
        if name.startswith("test") and name not in cls.__dict__:
            setattr(cls, name, None)


class ADailyLimitForAStrategyHeldForWeeks(_ta.Day):
    def test_stops_new_entries_and_sells_nothing(self):
        self.cfg(daily_loss_action="stop_entries")
        state.write_json("autopilot/day.json", {"day": "2026-10-20", "start_equity": 30000.0})  # sim has 25,000
        res = self.cycle("2026-10-20T13:50:00Z")
        self.assertNotEqual(res["status"], "killed")
        self.assertTrue(any(a.startswith("DAILY LIMIT") for a in res["actions"]), res["actions"])
        self.assertTrue(any("no new entries until tomorrow" in e for e in res["errors"]))
        self.assertFalse([d for d in _ta.decisions() if d["action"] == "taken"])
        control = ap().read_control()
        self.assertFalse(control["kill"] or control["paused"])

    def test_the_default_still_kills(self):
        state.write_json("autopilot/day.json", {"day": "2026-10-20", "start_equity": 30000.0})
        self.assertEqual(self.cycle("2026-10-20T13:50:00Z")["status"], "killed")


_only_own(ADailyLimitForAStrategyHeldForWeeks, _ta.Day)


class DollarLimitsWrittenForASmallerAccount(TraderTestCase):
    def test_say_so_once_they_hold_the_bot_back(self):
        cfg = {"risk_per_trade_pct": 2.0}
        limits = {"global": {"max_daily_loss_usd": 400, "max_daily_loss_pct": 10},
                  "crypto": {"max_risk_per_trade_usd": 80, "max_risk_per_trade_pct": 2}}
        self.assertEqual(ap().usd_limits_binding(cfg, limits, 1000.0), [])
        bound = ap().usd_limits_binding(cfg, limits, 10000.0)
        self.assertEqual(len(bound), 2)
        self.assertTrue(all("profile --capital 10000" in b for b in bound))

    def test_the_profile_refuses_a_capital_of_zero(self):
        for bad in (0.0, -5.0, float("inf"), float("nan")):
            with self.assertRaises(ValueError):
                ap().trend_profile(2, 1, 1, bad, True, True, 4)
        with self.assertRaises(ValueError):
            ap().trend_profile(2, 1, 1, 1000.0, True, True, 400)
        self.assertEqual(ap().trend_profile(2, 1, 1, 1000.0, True, True, 4)[0]["autopilot"]["daily_loss_action"],
                         "stop_entries")


class AnotherAccountsEquity(TraderTestCase):
    NOW = "2026-10-20T15:00:00Z"

    def test_is_no_daily_loss(self):
        config.ensure_home()
        now = mc.now_utc()
        self.assertEqual(ap()._day_loss(now, 25000.0, 0.0, "simulator/simulator/sim-A")[0], 0.0)
        self.assertEqual(ap()._day_loss(now, 24000.0, 0.0, "simulator/simulator/sim-A")[0], 1000.0)
        self.assertEqual(ap()._day_loss(now, 1000.0, 0.0, "simulator/simulator/sim-B"), (0.0, 1000.0))  # a reset sim
        self.assertEqual(ap()._day_loss(now, 900.0, 0.0, "simulator/simulator/sim-B")[0], 100.0)

    def test_is_no_drawdown(self):
        config.ensure_home()
        for at, eq, acct in (("2026-10-20T14:00:00Z", 25000.0, "simulator/simulator/sim-A"),
                             ("2026-10-20T14:30:00Z", 1000.0, "simulator/simulator/sim-B"),
                             ("2026-10-20T14:55:00Z", 950.0, "simulator/simulator/sim-B")):
            state.append_jsonl("broker/equity.jsonl", {"at": at, "equity": eq, "mode": "simulator", "account": acct})
        doc = adapt.evaluate(config.load_config(), "2026-10-20T15:00:00Z")
        self.assertEqual((doc["equity_peak"], doc["drawdown_pct"]), (1000.0, 5.0))

    def test_the_sim_and_alpaca_name_their_account(self):
        config.ensure_home()
        b = SimBroker(config.load_config())
        self.assertTrue(b.account()["account_id"].startswith("sim-"))
        self.assertEqual(ap().account_key(b, b.account()), "simulator/simulator/" + b.account()["account_id"])


class Stepped(Seller):
    """Alpaca BTC/USD: quantities in steps of 0.0001."""
    def qty_step(self, symbol, asset):
        return 0.0001 if asset == "crypto" else 0.0

    def place_exit(self, symbol, qty, kind="market", limit_price=None, client_order_id=None, asset="stock"):
        self.calls.append(("exit", symbol, qty))
        return {"id": "x-%d" % len(self.calls), "symbol": symbol, "side": "sell", "status": "new"}


class CryptoInTheBrokersSteps(_ta.OnlyWhatTheBotOwns):
    def setUp(self):
        super().setUp()
        self.it.update(symbol="BTC/USD", asset="crypto", qty=0.0023, stop=60000.0)

    def test_the_bots_quantity_is_what_the_broker_can_sell(self):
        b = Stepped()
        b.ords = [{"id": "e1", "client_order_id": "ord-p1", "symbol": "BTC/USD", "side": "buy", "status": "filled",
                   "filled_qty": 0.0023, "filled_avg_price": 65000.0, "filled_at": "2026-10-20T14:02:00Z"}]
        ap().reconcile(b, self.book, [], b.ords, self.cfg, self.limits)
        self.assertAlmostEqual(self.it["qty"], 0.0022)  # 0.0023 less the 0.25 % fee, in whole steps
        self.assertIn(("stop", "BTC/USD", 0.0022, 60000.0), b.calls)

    def test_the_dust_under_one_step_goes_with_the_sale(self):
        b = Stepped()
        self.it.update(status="open", qty=0.0022)
        ap()._sell_own(b, self.it, 0.00229425)
        self.assertEqual(b.calls, [("close", "BTC/USD")])
        b.calls = []
        ap()._sell_own(b, self.it, 1.00229425)  # a whole coin of yours as well: only the bot's part
        self.assertEqual(b.calls, [("exit", "BTC/USD", 0.0022)])


_only_own(CryptoInTheBrokersSteps, _ta.OnlyWhatTheBotOwns)


class OrdersStillWorking(_ta.OnlyWhatTheBotOwns):
    def setUp(self):
        super().setUp()
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z", stop_order_id="s1",
                       time_stop="2027-01-01T00:00:00Z")
        self.pos = [{"symbol": "NVDA", "asset": "stock", "qty": 10.0, "last": 101.0}]

    def test_a_stop_done_for_the_day_is_not_booked_yet(self):
        o = {"id": "s1", "symbol": "NVDA", "side": "sell", "type": "stop", "status": "done_for_day",
             "filled_qty": "4"}
        ap().reconcile(self.b, self.book, self.pos, [o], self.cfg, self.limits)
        self.assertEqual(self.it["qty"], 10.0)  # it may fill more tomorrow: booked when it ends

    def test_the_kill_cancels_a_runners_part_sale_before_it_sells(self):
        self.it["runner"] = {"status": "selling", "sell_order_id": "r1", "sell_qty": 3.3, "keep": 0.67}
        part = {"id": "r1", "client_order_id": "ord-p1-part", "symbol": "NVDA", "side": "sell", "type": "market",
                "status": "new"}
        self.b.ords = [part]
        ap().kill(self.b, self.book, self.cfg, "test", [part], self.pos)
        self.assertEqual(self.b.calls[0], ("cancel", "r1"))
        self.assertEqual(self.it["runner"]["status"], "failed")  # the reconcile won't sell it all a second time
        self.assertEqual(len([c for c in self.b.calls if c[0] in ("exit", "close")]), 1)


_only_own(OrdersStillWorking, _ta.OnlyWhatTheBotOwns)


class YourHoldingsAcrossASplitAndMidnight(TraderTestCase):
    NOW = "2026-10-20T15:00:00Z"

    def setUp(self):
        super().setUp()
        config.ensure_home()
        self.book = {"handled": {}, "items": {"p": {"symbol": "XYZ", "qty": 10.0, "status": "open",
                                                    "broker": "alpaca", "mode": "paper"}}}

    def yours(self, qty, last):
        return ap().yours_today(mc.now_utc(), [{"symbol": "XYZ", "qty": qty, "last": last}], self.book, [],
                                FakeBroker())

    def test_a_split_of_a_stock_you_both_hold_is_no_gain_or_loss(self):
        self.yours(110.0, 500.0)           # 100 yours, 10 the bot's
        self.assertEqual(self.yours(220.0, 250.0), 0.0)  # 2-for-1 (the bot's 10 rescaled only later this cycle)
        self.assertEqual(self.yours(22.0, 2500.0), 0.0)  # and a 1-for-10 back

    def test_midnight_carries_yesterdays_baseline(self):
        self.yours(110.0, 500.0)
        self.set_now("2026-10-21T00:30:00Z")  # your 100 shares rose 6 % while the machine slept
        self.assertEqual(self.yours(110.0, 530.0), 3000.0)


class SimulatorCoarseBars(TraderTestCase):
    NOW = "2026-10-20T15:25:00Z"

    def stop_order(self, b, symbol, asset, placed, stop):
        b.book["positions"][symbol] = {"symbol": symbol, "asset": asset, "qty": 10.0, "avg_entry": 100.0}
        b.book["orders"].append({"id": "s1", "symbol": symbol, "asset": asset, "side": "sell", "type": "stop",
                                 "qty": 10.0, "stop_price": stop, "status": "new", "leg": "stop",
                                 "time_in_force": "gtc", "submitted_at": mc.iso(placed), "active_from": placed})

    def test_marks_and_market_sales_stay_on_five_minute_prices(self):
        config.ensure_home()
        b = SimBroker(config.load_config())
        now = mc.ts(self.NOW)
        self.stop_order(b, "XYZ", "stock", now - 100 * 86400, 50.0)

        def candles(sym, interval, days=None, **kw):
            step = mc.interval_seconds(interval)
            first = now - 60 * 86400 if interval == "5m" else now - 101 * 86400
            last = 80.0 if interval == "5m" else 100.0  # the hour bar is older than the 5-minute close
            bars = [Candle(t, 100.0, 101.0, 99.0, 100.0, 1) for t in range(first, now - 2 * step, step)]
            bars.append(Candle(now - 2 * step, 100.0, 100.0, last, last, 1))
            return data.Series(data.as_symbol(sym, "stock"), interval, bars, "test", [], {})
        with mock.patch.object(data, "get_candles", side_effect=candles):
            b.sync()
            self.assertEqual(b.book["positions"]["XYZ"]["last"], 80.0)
            self.assertLess(b.place_exit("XYZ", 10.0, "market", asset="stock")["filled_avg_price"], 81.0)

    def test_a_failed_download_waits_a_cycle_instead_of_skipping_bars(self):
        config.ensure_home()
        b = SimBroker(config.load_config())
        self.stop_order(b, "BTC/USD", "crypto", mc.ts("2026-10-20T09:00:00Z"), 95.0)
        with mock.patch.object(data, "get_candles", side_effect=data.DataUnavailable("timeout")):
            b.sync()
        self.assertIn("BTC/USD", b.sync_errors)
        self.assertEqual(b.book["orders"][0]["status"], "new")


class AStrandedRotationPart(TraderTestCase):
    def test_is_archived_once_it_is_an_hour_old(self):
        config.ensure_home()
        dest = state.path("archive", "events-2026-10-20.jsonl.gz")
        dest.parent.mkdir(parents=True, exist_ok=True)
        stranded = dest.parent / (".%s.abc123.4242.claimed" % dest.name)
        with gzip.open(str(stranded), "wt") as fh:
            fh.write(json.dumps({"i": 1}) + "\n")
        old = time.time() - 7200
        os.utime(str(stranded), (old, old))
        state.append_jsonl("events.jsonl", {"i": 2})
        state.rotate_jsonl("events.jsonl", 10 ** 9, 0, dest)  # nothing to rotate — the leftover is picked up
        with gzip.open(str(dest), "rt") as fh:
            self.assertEqual([json.loads(x)["i"] for x in fh.read().splitlines()], [1])
        self.assertFalse(list(dest.parent.glob(".*.claimed")))


class BrokerStepDefault(TraderTestCase):
    def test_a_broker_without_steps_sells_as_before(self):
        self.assertEqual(FakeBroker().qty_step("BTC/USD", "crypto"), 0.0)
        self.assertIsNotNone(BrokerError)


def _trend_coin(n=900, end=1792454400):
    """30 days up 1 % a day, then a 4-day pullback — trend setups fire again and again."""
    coin, px = [], 100.0
    for i in range(n):
        o, px = px, px * (0.985 if i % 34 >= 30 else 1.01)
        coin.append(Candle(end - (n - i) * 86400, o, max(o, px) * 1.005, min(o, px) * 0.995, px, 1000.0))
    return coin


class TheLabScoresWhatTheBotCanTake(TraderTestCase):
    def lab(self):
        return load("trader-backtest", "lab")

    def test_two_trend_setups_share_one_position_per_coin(self):
        from shared import setups
        lab = self.lab()
        coin = _trend_coin()
        ctx = {"btc_up": setups.regime_map(coin)}
        sym = data.as_symbol("BTCUSDT", "crypto")
        both = ["trend_ema", "trend_breakout"]
        taken = lab.together(both, [(sym, coin, None)], "1d", 0.0026, ctx)
        held = []
        for st in both:
            ends = {}
            alone = lab.rule_trades(coin, st, "1d", 0.0026, ctx, ends)
            mine = taken[st].get(sym.key, set())
            self.assertTrue(mine <= {ts for ts, _ in alone})
            for ts, res in alone:
                if ts in mine:
                    end, ride_end = ends[ts]
                    held.append((ts, ride_end if lab.RUNNER_KEY in res else end))
        alone_n = sum(len(lab.rule_trades(coin, st, "1d", 0.0026, ctx)) for st in both)
        self.assertLess(len(held), alone_n)  # the bot can't take them all
        held.sort()
        for (_, until), (start, _) in zip(held, held[1:]):
            self.assertGreater(start, until)  # never two positions on the coin at once

    def test_a_handful_of_trades_never_reads_as_certain(self):
        rs = [1.2, -1.0, 0.8, -1.0, 2.5, -1.0, -1.0, 1.5, -1.0, 0.9, -1.0, 1.1, -1.0, 0.7, -1.0, 1.3]  # 16 trades
        chance = self.lab().bootstrap_profit_chance(rs)
        self.assertLess(chance, 0.99)
        # runs of 10 out of 16 trades would be nearly the same two runs every time: blocks stay at a quarter
        self.assertEqual(chance, self.lab().bootstrap_profit_chance(rs, block=4))

    def test_an_etf_is_bought_and_sold_at_the_next_open(self):
        lab = self.lab()
        coin = [c._replace(o=c.o * 1.004, h=max(c.h, c.o * 1.004)) for c in _trend_coin(500)]  # gaps up overnight
        at_close = lab.rule_trades(coin, "etf_trend", "1d", 0.0, {})
        next_open = lab.rule_trades(coin, "etf_trend", "1d", 0.0, {"fill": "next_open"})
        self.assertTrue(at_close and next_open)
        self.assertNotEqual([r for _, r in at_close], [r for _, r in next_open])

    def test_a_day_the_bot_skips_never_keeps_the_coin_busy(self):
        lab = self.lab()
        coin = _trend_coin(500)
        ends = {}
        every = lab.rule_trades(coin, "etf_trend", "1d", 0.0, {}, ends)
        first = every[0][0]
        later = lab.rule_trades(coin, "etf_trend", "1d", 0.0, {"entry_ok": lambda ts: ts != first})
        self.assertNotIn(first, [ts for ts, _ in later])
        # a signal while that refused trade would have run is taken: no ghost trade keeps the coin busy
        self.assertTrue(later and first < later[0][0] < ends[first][0], (later[:1], ends[first]))

    def test_the_runner_is_judged_after_its_design_window(self):
        lab = self.lab()
        cut = mc.ts("2023-01-01T00:00:00Z")
        pairs = [(cut - 86400 * i, 0.0, 5.0) for i in range(1, 41)]  # it shone in 2022, while it was being chosen…
        pairs += [(cut + 86400 * i, 0.5, 0.4) for i in range(40)]    # …and not since
        v = lab.runner_verdict("trend_breakout", {"expectancy_r": 0.0, "profit_chance": 0.5}, [], [], pairs)
        self.assertFalse(v["helps"])
        self.assertIn("after 2022", v["judged_on"])
