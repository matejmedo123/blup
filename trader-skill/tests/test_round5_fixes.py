"""Round five, second half: your own buy order next to the bot's sale (Alpaca's wash-trade guard), a log line cut
off by a full disk, one coin without prices, an order id sent twice, your own coins moving the bot's equity, a crash
right after a sale, a coin too new for the Time Machine, and a backtest that trades a coin the bot still holds."""
from __future__ import annotations

import os
from unittest import mock

from shared import brokers, config, data, market_clock as mc, notify, setups, state, symbols
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


class YourOwnCoinsAndTheBotsDailyLoss(TraderTestCase):
    """Only the daily-loss check takes your own holdings' moves out; equity, sizing and the drawdown stay the broker's."""
    NOW = "2026-10-20T15:00:00Z"

    def setUp(self):
        super().setUp()
        config.ensure_home()
        self.book = {"handled": {}, "items": {"p": {"symbol": "ETH/USD", "qty": 2.0, "status": "open",
                                                    "broker": "alpaca", "mode": "paper"}}}

    def day(self, equity, btc_qty, btc_last, eth_last=3000.0, book=None, orders=()):
        pos = [{"symbol": "ETH/USD", "qty": 2.0, "last": eth_last}]
        if btc_qty:
            pos.append({"symbol": "BTC/USD", "qty": btc_qty, "last": btc_last})
        yours = ap().yours_today(mc.now_utc(), pos, book or self.book, list(orders), _ta.FakeBroker())
        return ap()._day_loss(mc.now_utc(), equity, yours)[0], yours

    def test_your_btc_falling_is_not_the_bots_loss(self):
        self.assertEqual(self.day(100000.0, 1.0, 60000.0), (0.0, 0.0))
        self.assertEqual(self.day(90000.0, 1.0, 50000.0), (0.0, -10000.0))     # all of it your BTC
        self.assertEqual(self.day(89800.0, 1.0, 50000.0, 2900.0), (200.0, -10000.0))  # the bot's ETH: −$200

    def test_selling_or_buying_yours_moves_nothing(self):
        self.day(100000.0, 1.0, 60000.0)
        self.day(90000.0, 1.0, 50000.0)
        self.assertEqual(self.day(90000.0, 0.0, None), (0.0, -10000.0))      # you sold at a loss: no jump
        self.assertEqual(self.day(90000.0, 0.5, 45000.0), (0.0, -10000.0))   # you bought some back: nothing

    def test_the_bots_own_fill_is_not_yours(self):
        book = {"handled": {}, "items": {"p": {"symbol": "ETH/USD", "qty": 2.0, "status": "pending",
                                               "broker": "alpaca", "mode": "paper", "order_id": "ord-p",
                                               "broker_order_id": "e1"}}}
        orders = [{"id": "e1", "client_order_id": "ord-p", "status": "partially_filled", "filled_qty": "1.5"}]
        for last, yours in ((3000.0, 0.0), (2000.0, 0.0)):  # all 1.5 of it the bot's: its loss, not yours
            pos = [{"symbol": "ETH/USD", "qty": 1.5, "last": last}]
            self.assertEqual(ap().yours_today(mc.now_utc(), pos, book, orders, _ta.FakeBroker()), yours)
        pos = [{"symbol": "ETH/USD", "qty": 2.5, "last": 2000.0}]  # you bought 1 yourself
        ap().yours_today(mc.now_utc(), pos, book, orders, _ta.FakeBroker())
        pos[0]["last"] = 1900.0
        self.assertEqual(ap().yours_today(mc.now_utc(), pos, book, orders, _ta.FakeBroker()), -100.0)

    def test_a_new_day_starts_counting_again(self):
        self.day(100000.0, 1.0, 60000.0)
        self.day(90000.0, 1.0, 50000.0)
        self.set_now("2026-10-21T00:05:00Z")
        self.assertEqual(self.day(90000.0, 1.0, 50000.0), (0.0, 0.0))


class APartFilledStop(_ta.OnlyWhatTheBotOwns):
    """The stop sold 0.4 of the bot's 1.0 BTC and was cancelled: the next sale is 0.6, never your coins."""
    NOW = "2026-10-20T15:00:00Z"

    def test_the_part_is_booked_and_only_the_rest_is_sold(self):
        journal = load("trader-journal", "journal")
        journal.save_trade({"id": "t1", "plan_id": "p1", "asset": "crypto", "symbol": "BTC/USD", "qty": 1.0,
                            "entry": {"price": 100.0, "time": "2026-10-20T14:00:00Z"}, "risk_per_unit": 5.0,
                            "status": "open", "source": "autopilot"})
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z", symbol="BTC/USD", asset="crypto", qty=1.0,
                       stop_order_id="s1", trade_id="t1", time_stop="2027-01-01T00:00:00Z")
        part = [{"id": "s1", "client_order_id": "ord-p1-stop", "symbol": "BTC/USD", "side": "sell",
                 "type": "stop_limit", "status": "canceled", "filled_qty": "0.4", "filled_avg_price": "95.0",
                 "updated_at": "2026-10-20T14:50:00Z"}]
        pos = [{"symbol": "BTC/USD", "asset": "crypto", "qty": 2.6, "last": 94.0}]  # 2.0 of them are yours
        acts = ap().reconcile(self.b, self.book, pos, part, self.cfg, self.limits)
        self.assertAlmostEqual(self.it["qty"], 0.6)
        self.assertTrue(any("booked" in a for a in acts), acts)
        first, rest = journal.get_trade("t1"), journal.get_trade(self.it["trade_id"])
        self.assertEqual((first["status"], first["qty"], first["exit"]["reason"]), ("closed", 0.4, "stop"))
        self.assertEqual((rest["status"], rest["qty"]), ("open", 0.6))
        self.assertEqual(ap().reconcile(self.b, self.book, pos, part, self.cfg, self.limits), [])  # booked once
        ap().manage_exits(self.b, self.book, pos, part, self.cfg)
        self.assertIn(("exit", "BTC/USD", 0.6), self.b.calls)


class AWashLimitThePriceLeftBehind(_ta.OnlyWhatTheBotOwns):
    def test_is_sent_again_at_the_new_price(self):
        b = Washy()
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z", time_stop="2026-10-20T14:30:00Z")
        ap().manage_exits(b, self.book, [{"symbol": "NVDA", "asset": "stock", "qty": 10.0, "last": 101.0}], [],
                          self.cfg)
        resting = [{"id": self.it["exit_order_id"], "symbol": "NVDA", "side": "sell", "type": "limit",
                    "limit_price": 99.99, "status": "new"}]
        b.ords = resting
        ap().manage_exits(b, self.book, [{"symbol": "NVDA", "asset": "stock", "qty": 10.0, "last": 100.5}], resting,
                          self.cfg)  # still above its limit: it waits
        self.assertEqual(len([c for c in b.calls if c[0] == "exit"]), 1)
        ap().manage_exits(b, self.book, [{"symbol": "NVDA", "asset": "stock", "qty": 10.0, "last": 90.0}], resting,
                          self.cfg)
        self.assertIn(("cancel", resting[0]["id"]), b.calls)
        self.assertAlmostEqual([c for c in b.calls if c[0] == "exit"][-1][4], 90.0 * ap().WASH_LIMIT)

    def test_the_kill_does_not_wait_on_it_either(self):
        b = Washy()
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z", exit_order_id="x9", exit_limit=99.99,
                       exit_limit_at="2026-10-20T14:00:00Z")
        resting = [{"id": "x9", "symbol": "NVDA", "side": "sell", "type": "limit", "limit_price": 99.99,
                    "status": "new"}]
        b.ords = resting
        ap().kill(b, self.book, self.cfg, "test", resting, [{"symbol": "NVDA", "asset": "stock", "qty": 10.0,
                                                             "last": 101.0}])  # waited 1 h: sent again
        self.assertIn(("cancel", "x9"), b.calls)
        self.assertTrue([c for c in b.calls if c[0] == "exit"])


for _cls in (APartFilledStop, AWashLimitThePriceLeftBehind):
    for _name in dir(_ta.OnlyWhatTheBotOwns):
        if _name.startswith("test") and _name not in _cls.__dict__:
            setattr(_cls, _name, None)


class SmallerThings(TraderTestCase):
    def test_a_paper_trade_in_the_book_never_stops_a_running_live_bot(self):
        config.ensure_home()
        state.write_json("autopilot/book.json", {"handled": {}, "items": {"x": {
            "symbol": "NVDA", "status": "open", "broker": "alpaca", "mode": "paper"}}})
        cfg = config.load_config()
        cfg["autopilot"].update(broker="alpaca", mode="live", live_confirmation=brokers.LIVE_PHRASE)
        cfg["paper"] = False
        os.environ["ALPACA_LIVE_KEY_ID"], os.environ["ALPACA_LIVE_SECRET_KEY"] = "AKTESTLIVE123456", "SKTESTLIVE123456"
        self.assertFalse(brokers.live_readiness(cfg)[0])           # the opt-in check says so
        self.assertTrue(brokers.live_readiness(cfg, book=False)[0])  # the running bot keeps its exits

    def test_a_rotated_part_the_archive_could_not_take_is_kept(self):
        config.ensure_home()
        state.write_json("x.json", {})  # the folder
        for i in range(100):
            state.append_jsonl("events.jsonl", {"i": i, "pad": "x" * 100})
        dest = state.path("archive", "events-2026-10-20.jsonl.gz")
        dest.parent.mkdir(parents=True, exist_ok=True)
        with mock.patch.object(state, "_archive_part", side_effect=OSError(28, "No space left on device")):
            state.rotate_jsonl("events.jsonl", 1000, 0, dest)
        self.assertEqual(state.read_jsonl("events.jsonl"), [])
        later = state.path("archive", "events-2026-10-21.jsonl.gz")
        for i in range(100, 200):
            state.append_jsonl("events.jsonl", {"i": i, "pad": "x" * 100})
        state.rotate_jsonl("events.jsonl", 1000, 0, later)
        import gzip
        with gzip.open(str(dest), "rt") as fh:
            self.assertEqual(len(fh.read().splitlines()), 100)  # yesterday's part, in yesterday's archive
        with gzip.open(str(later), "rt") as fh:
            self.assertEqual(len(fh.read().splitlines()), 100)
        self.assertFalse(list(dest.parent.glob(".*.pending")))

    def test_a_manual_ticket_goes_to_alpaca_unless_told_otherwise(self):
        risk = load("trader-risk", "risk")
        self.assertIn("venue = (((cfg.get(\"autopilot\") or {}).get(\"broker\") or \"simulator\")",
                      open(risk.__file__).read())

    def test_the_ntfy_token_never_follows_a_redirect(self):
        sent = []

        class Resp:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self, n):
                return b""
        with mock.patch("urllib.request.urlopen", lambda req, timeout=0: sent.append(req) or Resp()):
            notify._post("https://ntfy.sh/t", b"x", {"Authorization": "Bearer tk", "Title": "t"})
        self.assertIn("Authorization", sent[0].unredirected_hdrs)
        self.assertNotIn("Authorization", sent[0].headers)

    def test_a_pair_on_the_block_list_is_that_pair(self):
        self.assertEqual(symbols.blocked_hits(["ETHUSDT"], ["ETH/BTC"]), [])
        self.assertEqual(symbols.blocked_hits(["WUSDT"], ["WBTC"]), [])
        self.assertEqual(symbols.blocked_hits(["SOLUSDT"], ["SOL/USD"]), ["SOLUSDT"])


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


class AnOrderOlderThanTheFiveMinuteHistory(TraderTestCase):
    """Yahoo keeps ~60 days of 5-minute bars: an ETF order from last winter (a replay) is walked on hourly bars."""
    NOW = "2026-03-02T15:00:00Z"

    def test_is_walked_on_hourly_bars(self):
        config.ensure_home()
        b = SimBroker(config.load_config())
        placed = mc.ts(self.NOW)
        asked = []

        def candles(sym, interval, days=None, **kw):
            asked.append(interval)
            step = mc.interval_seconds(interval)
            first = mc.ts("2026-04-01T14:30:00Z") if interval == "5m" else placed - 86400  # 5m: only recent bars
            bars = [Candle(t, 100.0, 101.0, 97.0, 99.0, 1.0) for t in range(first, mc.ts("2026-05-01T20:00:00Z"), step)]
            return data.Series(data.as_symbol(sym, "stock"), interval, bars, "test", [], {})
        with mock.patch.object(data, "get_candles", side_effect=candles):
            b._candles[("GLD", "stock")] = []  # an empty 5m series from the order's own cycle
            b.place_entry({"client_order_id": "ord-g", "symbol": "GLD", "asset": "stock", "qty": 2.0,
                           "limit_price": 98.0, "stop_price": 90.0, "target_price": 120.0, "swing": True})
            del b._candles[("GLD", "stock")]
            self.set_now("2026-05-01T20:00:00Z")
            b.sync()
        self.assertEqual(asked[:2], ["5m", "1h"])
        entry = [o for o in b.book["orders"] if o.get("leg") == "entry"][0]
        self.assertEqual(entry["status"], "filled")
        self.assertLess(mc.ts(entry["filled_at"]), mc.ts("2026-03-03T00:00:00Z"))  # the day it was asked, not April
