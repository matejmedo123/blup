"""Round five, second half: your own buy order next to the bot's sale (Alpaca's wash-trade guard), a log line cut
off by a full disk, one coin without prices, an order id sent twice, your own coins moving the bot's equity, a crash
right after a sale, a coin too new for the Time Machine, and a backtest that trades a coin the bot still holds."""
from __future__ import annotations

import os
from unittest import mock

from shared import config, data, market_clock as mc, setups, state
from shared.brokers import BrokerError
from shared.brokers.simulator import SimBroker
from shared.indicators import Candle
from tests import test_autopilot as _ta
from tests.helpers import TraderTestCase, load
from tests.test_autopilot import Seller


def ap():
    return load("trader-autopilot", "autopilot")


def lab():
    return load("trader-backtest", "lab")


WASH = "potential wash trade detected. use complex orders"


class Washy(Seller):
    """Alpaca with your own buy order open on the symbol: market sales and plain stops are refused, limits are not."""
    def place_exit(self, symbol, qty, kind="market", limit_price=None, client_order_id=None, asset="stock"):
        if kind != "limit":
            raise BrokerError(WASH)
        self.calls.append(("exit", symbol, qty, kind, limit_price))
        return {"id": "x-%d" % len(self.calls), "symbol": symbol, "side": "sell", "status": "new"}

    def close_position(self, symbol):
        raise BrokerError(WASH)

    def place_stop(self, symbol, qty, stop_price, client_order_id=None, asset="crypto", limit_price=None):
        if limit_price is None:
            raise BrokerError(WASH)
        self.calls.append(("stop", symbol, qty, stop_price, limit_price))
        return {"id": "stop-%d" % len(self.calls), "symbol": symbol, "side": "sell", "status": "new"}


class YourBuyOrderNextToTheBotsSale(_ta.OnlyWhatTheBotOwns):
    def setUp(self):
        super().setUp()
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z", time_stop="2026-10-20T14:30:00Z")
        self.pos = [{"symbol": "NVDA", "asset": "stock", "qty": 10.0, "last": 101.0}]

    def test_the_sale_goes_out_as_a_limit_just_under_the_price(self):
        b = Washy()
        acts = ap().manage_exits(b, self.book, self.pos, [], self.cfg)
        sale = [c for c in b.calls if c[0] == "exit"]
        self.assertEqual(len(sale), 1, b.calls)
        self.assertEqual(sale[0][3], "limit")
        self.assertAlmostEqual(sale[0][4], 101.0 * ap().WASH_LIMIT)
        self.assertIn("time exit for NVDA", acts)

    def test_the_stop_goes_back_as_a_stop_limit(self):
        acts = ap()._restore_stop(Washy(), self.it, 10.0, mc.now_utc())
        self.assertIn("put back", acts[0])
        self.assertTrue(self.it["stop_order_id"])

    def test_a_stop_limit_under_the_stop_at_alpaca(self):
        from shared.brokers.alpaca import AlpacaBroker
        b = AlpacaBroker.__new__(AlpacaBroker)
        b.mode, b.cfg, b.log = "paper", {}, (lambda *a, **k: None)
        sent = []
        with mock.patch.object(AlpacaBroker, "_post_order", side_effect=lambda body: sent.append(body) or
                               {"id": "o1", "status": "new"}), \
                mock.patch.object(AlpacaBroker, "_tick", return_value=None), \
                mock.patch.object(AlpacaBroker, "_order", side_effect=lambda res, **k: res):
            b.place_stop("NVDA", 10, 95.0, client_order_id="c", asset="stock", limit_price=92.15)
            b.place_stop("NVDA", 10, 95.0, client_order_id="d", asset="stock")
        self.assertEqual((sent[0]["type"], sent[0]["limit_price"]), ("stop_limit", "92.15"))
        self.assertEqual(sent[1]["type"], "stop")


for _name in dir(_ta.OnlyWhatTheBotOwns):  # its own tests run in test_autopilot
    if _name.startswith("test") and _name not in YourBuyOrderNextToTheBotsSale.__dict__:
        setattr(YourBuyOrderNextToTheBotsSale, _name, None)


class FullDiskLogLine(TraderTestCase):
    def test_a_line_cut_off_by_a_full_disk_is_taken_back(self):
        config.ensure_home()
        state.append_jsonl("events.jsonl", {"i": 1})
        real = os.write
        calls = []

        def half_then_full(fd, buf):
            calls.append(len(buf))
            if len(calls) == 1:
                return real(fd, bytes(buf[:5]))
            raise OSError(28, "No space left on device")
        with mock.patch("os.write", side_effect=half_then_full):
            with self.assertRaises(OSError):
                state.append_jsonl("events.jsonl", {"i": 2, "pad": "x" * 50})
        state.append_jsonl("events.jsonl", {"i": 3})
        self.assertEqual([r["i"] for r in state.read_jsonl("events.jsonl")], [1, 3])


class Simulator(TraderTestCase):
    NOW = "2026-10-20T15:00:00Z"

    def broker(self):
        config.ensure_home()
        return SimBroker(config.load_config())

    def test_one_coin_without_prices_does_not_hold_up_the_others(self):
        b = self.broker()
        t0 = mc.ts(self.NOW)
        bars = [Candle(t0 + i * 300, 100.0, 101.0, 98.0, 99.0, 1.0) for i in range(6)]

        def series(symbol, asset, since_ts=None):
            if symbol == "XYZ/USD":
                raise BrokerError("no prices for XYZ/USD: delisted")
            return bars
        b._series = series
        for sym in ("BTC/USD", "XYZ/USD"):
            b.place_entry({"client_order_id": "ord-" + sym, "symbol": sym, "asset": "crypto", "qty": 1.0,
                           "limit_price": 99.0, "stop_price": 90.0, "target_price": 120.0})
        self.set_now("2026-10-20T15:30:00Z")
        b.sync()
        self.assertIn("XYZ/USD", b.sync_errors)
        entries = {o["symbol"]: o["status"] for o in b.book["orders"] if o.get("leg") == "entry"}
        self.assertEqual(entries, {"BTC/USD": "filled", "XYZ/USD": "new"})

    def test_an_order_id_sent_twice_is_one_order(self):
        b = self.broker()
        b._candles[("BTC/USD", "crypto")] = []
        first = b.place_stop("BTC/USD", 1.0, 60000.0, client_order_id="ord-a-stop")
        again = b.place_stop("BTC/USD", 1.0, 60000.0, client_order_id="ord-a-stop")
        self.assertEqual(first["id"], again["id"])
        self.assertEqual(len(b.book["orders"]), 1)
        b.cancel(first["id"])
        with self.assertRaises(BrokerError):  # a cancelled order is no answer for a new one under its id
            b.place_stop("BTC/USD", 1.0, 60000.0, client_order_id="ord-a-stop")

    def test_closing_a_position_leaves_the_other_orders_alone(self):
        b = self.broker()
        b._candles[("BTC/USD", "crypto")] = [Candle(mc.ts(self.NOW) - 300, 100.0, 100.0, 100.0, 100.0, 1.0)]
        b.book["positions"]["BTC/USD"] = {"symbol": "BTC/USD", "asset": "crypto", "qty": 2.0, "avg_entry": 90.0}
        yours = b.place_exit("BTC/USD", 1.0, "limit", limit_price=150.0, client_order_id="my-own", asset="crypto")
        b.close_position("BTC/USD")
        self.assertEqual([o["status"] for o in b.book["orders"] if o["id"] == yours["id"]], ["new"])


class YourOwnCoinsAndTheBotsEquity(TraderTestCase):
    def book(self, status="open"):
        return {"handled": {}, "items": {"p": {"symbol": "ETH/USD", "qty": 2.0, "status": status,
                                               "broker": "alpaca", "mode": "paper"}}}

    def test_your_btc_falling_is_not_the_bots_loss(self):
        acct = {"equity": 24000.0, "cash": 10000.0}
        pos = [{"symbol": "BTC/USD", "qty": 0.1, "avg_entry": 60000.0, "last": 50000.0},  # yours: −$1,000
               {"symbol": "ETH/USD", "qty": 2.0, "avg_entry": 3000.0, "last": 2900.0}]    # the bot's
        out = ap().bot_account(acct, pos, self.book(), _ta.FakeBroker())
        self.assertEqual((out["equity"], out["account_equity"], out["yours_pl_usd"]), (25000.0, 24000.0, -1000.0))

    def test_buying_some_yourself_changes_nothing(self):
        acct = {"equity": 25000.0, "cash": 20000.0}
        pos = [{"symbol": "BTC/USD", "qty": 0.1, "avg_entry": 50000.0, "last": 50000.0}]
        self.assertEqual(ap().bot_account(acct, pos, self.book(), _ta.FakeBroker())["equity"], 25000.0)

    def test_the_bots_entry_that_just_filled_is_the_bots(self):
        acct = {"equity": 24800.0}
        pos = [{"symbol": "ETH/USD", "qty": 2.0, "avg_entry": 3000.0, "last": 2900.0}]
        self.assertEqual(ap().bot_account(acct, pos, self.book("pending"), _ta.FakeBroker())["equity"], 24800.0)


class CrashRightAfterTheSale(_ta.OnlyWhatTheBotOwns):
    def test_the_reason_is_on_disk_before_the_sale(self):
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z", time_stop="2026-10-20T14:30:00Z")
        state.write_json("autopilot/book.json", self.book)
        seen = []

        class Watching(Seller):
            def close_position(self, symbol):
                seen.append(state.read_json("autopilot/book.json")["items"]["p1"].get("exit_reason"))
                return Seller.close_position(self, symbol)
        pos = [{"symbol": "NVDA", "asset": "stock", "qty": 10.0, "last": 101.0}]
        ap().manage_exits(Watching(), self.book, pos, [], self.cfg, persist=True)
        self.assertEqual(seen, ["time"])


for _name in dir(_ta.OnlyWhatTheBotOwns):
    if _name.startswith("test") and _name not in CrashRightAfterTheSale.__dict__:
        setattr(CrashRightAfterTheSale, _name, None)


class ACoinTooNewToReplay(_ta.Day):
    def test_is_a_skip_not_an_error(self):
        with mock.patch.object(ap(), "run_timemachine", side_effect=data.DataUnavailable("only 3 days of history")):
            res = self.cycle("2026-10-20T13:50:00Z")
        self.assertEqual(res["errors"], [])
        tm = [d for d in _ta.decisions() if any("Time Machine:" in r for r in d.get("reasons") or [])]
        self.assertTrue(tm)
        self.assertTrue(all(d["action"] == "skipped" for d in tm))


for _name in dir(_ta.Day):
    if _name.startswith("test") and _name not in ACoinTooNewToReplay.__dict__:
        setattr(ACoinTooNewToReplay, _name, None)


class TheLabRidesOneTradeAtATime(TraderTestCase):
    def test_no_runner_trade_starts_while_the_last_one_still_rides(self):
        day, end, coin, px = 86400, mc.ts("2026-10-01T00:00:00Z"), [], 100.0
        for i in range(900):  # 30 days up 1 % a day, then a pullback that breaks the 10-day low, not the trend
            o, px = px, px * (0.985 if i % 34 >= 30 else 1.01)
            coin.append(Candle(end - (900 - i) * day, o, max(o, px) * 1.005, min(o, px) * 0.995, px, 1000.0))
        ends = {}
        trades = lab().rule_trades(coin, "trend_breakout", "1d", 0.0026, {"btc_up": setups.regime_map(coin)}, ends)
        rides = [(t, ends[t][1]) for t, res in trades if lab().RUNNER_KEY in res]
        self.assertTrue(rides)
        self.assertLess(len(rides), len(trades))  # some signals came while two thirds still rode: sell-all only
        for (_, ride_end), (start, _) in zip(rides, rides[1:]):
            self.assertGreater(start, ride_end)
