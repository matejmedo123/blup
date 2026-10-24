"""Second fatal-bug hunt (24 Oct 2026): each scenario that left a position unprotected, sold what you hold
yourself, or bought when it must not — as the review found it, now held to the fixed behaviour."""
from __future__ import annotations

import os
from unittest import mock

from shared import config
from shared.brokers.base import Broker, BrokerError
from tests.helpers import TraderTestCase, load

NOW = "2026-10-20T15:00:00Z"


def ap():
    return load("trader-autopilot", "autopilot")


class Fake(Broker):
    """Alpaca-like: an order sent twice under one client id returns the first (filled or not)."""
    name, mode = "alpaca", "paper"

    def __init__(self):
        self.pos, self.ords, self.calls, self.n = [], [], [], 0
        self.exit_unsure_but_filled = False  # place_exit: the order lands (filled) but the answer is lost

    def account(self):
        return {"equity": 100000, "cash": 100000, "buying_power": 100000}

    def positions(self):
        return [dict(p) for p in self.pos]

    def orders(self, since=None):
        return [dict(o) for o in self.ords]

    def _by_cid(self, cid):
        return next((o for o in self.ords if cid and o.get("client_order_id") == cid), None)

    def place_stop(self, symbol, qty, stop_price, client_order_id=None, asset="crypto", limit_price=None):
        again = self._by_cid(client_order_id)
        self.calls.append(("stop", symbol, qty))
        if again:
            return dict(again)
        self.n += 1
        o = {"id": "S%d" % self.n, "client_order_id": client_order_id, "symbol": symbol, "side": "sell",
             "type": "stop_limit" if asset == "crypto" else "stop", "status": "new", "qty": qty,
             "stop_price": stop_price, "filled_qty": 0}
        self.ords.append(o)
        return dict(o)

    def place_exit(self, symbol, qty, kind="market", limit_price=None, client_order_id=None, asset="stock"):
        again = self._by_cid(client_order_id)
        self.calls.append(("exit", symbol, qty))
        if again:
            return dict(again)
        self.n += 1
        o = {"id": "X%d" % self.n, "client_order_id": client_order_id, "symbol": symbol, "side": "sell",
             "type": kind, "status": "filled", "qty": qty, "filled_qty": qty, "filled_avg_price": 100.0,
             "filled_at": os.environ["TRADER_NOW"], "limit_price": limit_price}
        self.ords.append(o)
        for p in self.pos:
            if p["symbol"] == symbol:
                p["qty"] = round(p["qty"] - qty, 10)
        self.pos = [p for p in self.pos if p["qty"] > 1e-12]
        if self.exit_unsure_but_filled:
            self.exit_unsure_but_filled = False
            raise BrokerError("Alpaca order may or may not have been placed: it failed twice (HTTP 504) and nothing "
                              "was found under %s yet — it is looked up again" % client_order_id)
        return dict(o)

    def cancel(self, order_id):
        self.calls.append(("cancel", order_id))
        for o in self.ords:
            if o["id"] == order_id and o["status"] in ("new", "held", "accepted", "partially_filled"):
                o["status"] = "canceled"
        return {"id": order_id, "status": "canceled"}

    def lookup(self, order_id):
        return [dict(o) for o in self.ords if o["id"] == order_id]

    def find_client(self, cid):
        o = self._by_cid(cid)
        return dict(o) if o else None

    def close_position(self, symbol):
        p = next((p for p in self.pos if p["symbol"] == symbol), None)
        self.calls.append(("close", symbol))
        if not p:
            return {"symbol": symbol, "status": "flat"}
        return self.place_exit(symbol, p["qty"], "market", client_order_id="close-%s" % symbol, asset="crypto")

    def sold(self, symbol):
        return round(sum(float(o.get("filled_qty") or 0) for o in self.ords
                         if o["symbol"] == symbol and o["side"] == "sell" and o["status"] in ("filled", "canceled")), 10)


def item(**kw):
    it = {"plan_id": "p1", "order_id": "ord-p1", "broker_order_id": "e1", "broker": "alpaca", "mode": "paper",
          "symbol": "BTC/USD", "data_key": "BTCUSD", "asset": "crypto", "qty": 1.0, "stop": 100.0, "target": 130.0,
          "time_stop": "2026-10-21T00:00:00Z", "status": "open", "placed_at": "2026-10-20T10:00:00Z",
          "filled_at": "2026-10-20T10:01:00Z", "entry_fill": 105.0, "trade_id": None,
          "stop_retry_at": "2026-10-20T10:01:00Z"}
    it.update(kw)
    return it


class ExitsAndProtection(TraderTestCase):
    NOW = NOW

    def setUp(self):
        super().setUp()
        config.ensure_home()
        self.cfg, self.limits = config.load_config(), config.load_limits()

    def cycle(self, b, book):
        a = ap()
        acts = a.reconcile(b, book, b.positions(), b.orders(), self.cfg, self.limits)
        return acts + a.manage_exits(b, book, b.positions(), b.orders(), self.cfg)

    def test_a_stale_partly_filled_limit_sale_is_cancelled_and_the_rest_sold(self):
        b = Fake()
        it = item(exit_order_id="X9", exit_limit=99.0, exit_limit_at="2026-10-20T14:30:00Z", exit_reason="stop",
                  stop_order_id=None, stop_retry_at="2026-10-20T14:30:00Z")
        book = {"items": {"p1": it}, "handled": {}}
        b.ords = [{"id": "X9", "client_order_id": "ord-p1-x1", "symbol": "BTC/USD", "side": "sell", "type": "limit",
                   "limit_price": 99.0, "status": "partially_filled", "qty": 1.0, "filled_qty": 0.3,
                   "filled_avg_price": 99.0}]
        b.pos = [{"symbol": "BTC/USD", "asset": "crypto", "qty": 0.7, "last": 90.0}]  # fell below the limit
        for _ in range(3):
            self.cycle(b, book)
        self.assertEqual(it["status"], "closed")
        self.assertEqual(b.pos, [])
        self.assertAlmostEqual(b.sold("BTC/USD"), 1.0)

    def test_a_lost_answer_on_the_part_sale_never_sells_it_twice(self):
        a = ap()

        def ride_ok(it, p, cfg=None):
            it["runner"].update(sell_qty=0.33, keep_qty=0.67)
            return True, None
        b = Fake()
        it = item(qty=1.0, target=1e9, time_stop="2026-10-20T14:00:00Z", placed_at="2026-10-10T10:00:00Z",
                  filled_at="2026-10-10T10:01:00Z", stop_order_id="S0",
                  runner={"keep": 0.67, "min_sma": 200, "status": "planned",
                          "exit_rule": {"type": "close_below_ema", "n": 50, "max_bars": 250, "interval": "1d",
                                        "short": "close < 50-day EMA", "text": "x"}})
        book = {"items": {"p1": it}, "handled": {}}
        b.ords = [{"id": "S0", "client_order_id": "ord-p1-stop", "symbol": "BTC/USD", "side": "sell",
                   "type": "stop_limit", "status": "new", "qty": 1.0, "stop_price": 100.0, "filled_qty": 0}]
        b.pos = [{"symbol": "BTC/USD", "asset": "crypto", "qty": 3.0, "last": 150.0}]  # 2.0 of it is yours
        b.exit_unsure_but_filled = True
        with mock.patch.object(a, "ride_check", side_effect=ride_ok):
            a.manage_exits(b, book, b.positions(), b.orders(), self.cfg)
        self.assertAlmostEqual(b.sold("BTC/USD"), 0.33)  # only the part — not the part and then everything
        self.assertEqual(it["runner"]["status"], "selling")
        with mock.patch.object(a, "start_ride", return_value=["ride"]) as ride:
            a.reconcile(b, book, b.positions(), b.orders(), self.cfg, self.limits)
        ride.assert_called_once()  # found by its client id: the ride goes on from the sale that did happen

    def test_a_reopened_trade_whose_stop_already_sold_never_sells_your_coins(self):
        b = Fake()
        self.write_state("orders.json", {"orders": [{"id": "ord-p1", "plan_id": "p1", "qty": 1.0}]})
        it = item(status="pending", entry_plan=105.0, setup="asia_range")
        it.pop("filled_at")
        book = {"items": {"p1": it}, "handled": {}}  # a book read back from an older copy: still "pending"
        b.ords = [{"id": "e1", "client_order_id": "ord-p1", "symbol": "BTC/USD", "side": "buy", "type": "limit",
                   "status": "filled", "qty": 1.0, "filled_qty": 1.0, "filled_avg_price": 105.0,
                   "filled_at": "2026-10-20T10:01:00Z"},
                  {"id": "S1", "client_order_id": "ord-p1-stop", "symbol": "BTC/USD", "side": "sell",
                   "type": "stop_limit", "status": "filled", "qty": 0.9975, "filled_qty": 0.9975,
                   "filled_avg_price": 99.8, "filled_at": "2026-10-20T13:00:00Z"}]
        b.pos = [{"symbol": "BTC/USD", "asset": "crypto", "qty": 2.0, "last": 98.0}]  # all yours now
        self.cycle(b, book)
        self.assertEqual(b.pos[0]["qty"], 2.0)
        self.assertFalse([c for c in b.calls if c[0] in ("exit", "close")])

    def test_a_stop_you_edited_at_the_broker_is_followed_and_cancelled_with_the_exit(self):
        b = Fake()
        it = item(stop_order_id="S0")
        book = {"items": {"p1": it}, "handled": {}}
        b.ords = [{"id": "S0", "client_order_id": "ord-p1-stop", "symbol": "BTC/USD", "side": "sell",
                   "type": "stop_limit", "status": "replaced", "replaced_by": "S0b", "qty": 1.0, "stop_price": 100.0,
                   "filled_qty": 0},
                  {"id": "S0b", "client_order_id": "6f1c3e1a-0b9e-4b7e-a1d2-3c4d5e6f7a8b", "replaces": "S0",
                   "symbol": "BTC/USD", "side": "sell", "type": "stop_limit", "status": "new", "qty": 1.0,
                   "stop_price": 98.0, "filled_qty": 0}]
        b.pos = [{"symbol": "BTC/USD", "asset": "crypto", "qty": 3.0, "last": 110.0}]  # 2 are yours
        a = ap()
        a.manage_exits(b, book, b.positions(), b.orders(), self.cfg)
        self.assertFalse([c for c in b.calls if c[0] == "stop"], "the edited stop is its stop: no second one")
        self.assertEqual(it["stop_order_id"], "S0b")
        b.pos[0]["last"] = 131.0  # the target
        a.manage_exits(b, book, b.positions(), b.orders(), self.cfg)
        self.assertEqual([o["id"] for o in b.ords if o["status"] == "new"], [])
        self.assertAlmostEqual(b.pos[0]["qty"], 2.0)

    def test_a_split_while_the_kill_is_on_sells_all_the_bots_shares(self):
        b = Fake()
        it = item(symbol="XYZ", data_key="XYZ", asset="stock", qty=10.0, stop=90.0, time_stop="2026-11-20T19:55:00Z",
                  swing=True, stop_order_id="S0", broker_qty=10.0, broker_avg=100.0, entry_fill=100.0,
                  placed_at="2026-10-10T14:00:00Z", filled_at="2026-10-10T14:01:00Z")
        book = {"items": {"p1": it}, "handled": {}}
        b.ords = [{"id": "S0", "client_order_id": "ord-p1-s1", "symbol": "XYZ", "side": "sell", "type": "stop",
                   "status": "canceled", "qty": 10.0, "stop_price": 90.0, "filled_qty": 0}]
        b.pos = [{"symbol": "XYZ", "asset": "stock", "qty": 20.0, "avg_entry": 50.0, "last": 51.0}]  # 2-for-1
        a = ap()
        a.kill(b, book, self.cfg, "kill switch", b.orders(), b.positions())
        a.reconcile(b, book, b.positions(), b.orders(), self.cfg, self.limits)
        self.assertEqual(b.pos, [])

    def test_a_journal_that_cannot_be_written_never_leaves_a_fill_without_its_stop(self):
        b = Fake()
        self.write_state("orders.json", {"orders": [{"id": "ord-p1", "plan_id": "p1", "qty": 10.0}]})
        it = item(symbol="SOL/USD", data_key="SOLUSDT", qty=10.0, target=1e9, time_stop="2026-11-20T00:00:00Z",
                  status="pending", placed_at="2026-10-20T14:50:00Z", entry_plan=105.0, setup="asia_range")
        it.pop("filled_at")
        book = {"items": {"p1": it}, "handled": {}}
        b.ords = [{"id": "e1", "client_order_id": "ord-p1", "symbol": "SOL/USD", "side": "buy", "type": "limit",
                   "status": "filled", "qty": 10.0, "filled_qty": 10.0, "filled_avg_price": 105.0,
                   "filled_at": "2026-10-20T14:51:00Z"}]
        b.pos = [{"symbol": "SOL/USD", "asset": "crypto", "qty": 10.0, "last": 104.0}]
        journal = ap()._mod("trader-journal", "journal")
        with mock.patch.object(journal, "save_trade", side_effect=OSError(28, "No space left on device")):
            acts = ap().reconcile(b, book, b.positions(), b.orders(), self.cfg, self.limits)
        self.assertEqual(it["status"], "open")
        self.assertIn(("stop", "SOL/USD", it["qty"]), b.calls)
        self.assertIn("protected anyway", " ".join(acts))
        ap().reconcile(b, book, b.positions(), b.orders(), self.cfg, self.limits)  # the disk has room again
        self.assertTrue(it.get("trade_id"))
        self.assertNotIn("journal_error", it)

    def test_a_part_sale_comes_off_the_quantity_even_when_the_journal_fails(self):
        b = Fake()
        b.name = "bybit"
        it = item(plan_id="p2", order_id="ord-p2", broker="bybit", symbol="SOL/USD", data_key="SOLUSDT", qty=10.0,
                  target=1e9, time_stop="2026-11-20T00:00:00Z", trade_id="trd-p2", stop_order_id="S0")
        journal = ap()._mod("trader-journal", "journal")
        journal.save_trade({"id": "trd-p2", "plan_id": "p2", "symbol": "SOL/USD", "asset": "crypto", "qty": 10.0,
                            "entry": {"price": 105.0, "time": "2026-10-20T10:01:00Z"}, "stop": 100.0,
                            "risk_per_unit": 5.0, "status": "open", "exit": None, "notes": ""})
        book = {"items": {"p2": it}, "handled": {}}
        b.ords = [{"id": "S0", "client_order_id": "ord-p2-stop", "symbol": "SOL/USD", "side": "sell", "type": "stop",
                   "leg": "stop", "status": "canceled", "qty": 10.0, "filled_qty": 4.0, "filled_avg_price": 99.9,
                   "filled_at": None, "updated_at": "2026-10-20T14:00:00Z"}]
        b.pos = [{"symbol": "SOL/USD", "asset": "crypto", "qty": 26.0, "last": 101.0}]  # 6 the bot's, 20 yours
        with mock.patch.object(journal, "save_trade", side_effect=OSError(28, "No space left on device")):
            ap().reconcile(b, book, b.positions(), b.orders(), self.cfg, self.limits)
        self.assertEqual(it["qty"], 6.0)

    def test_a_closed_trades_leftover_stop_is_cancelled_until_it_is_gone(self):
        b = Fake()
        it = item(status="closed", stop_order_id="S1")
        book = {"items": {"p1": it}, "handled": {}}
        b.ords = [{"id": "S1", "client_order_id": "ord-p1-stop", "symbol": "BTC/USD", "side": "sell",
                   "type": "stop_limit", "status": "new", "qty": 1.0, "stop_price": 100.0, "filled_qty": 0}]
        real = b.cancel
        with mock.patch.object(b, "cancel", side_effect=BrokerError("timeout")):
            acts = ap().reconcile(b, book, b.positions(), b.orders(), self.cfg, self.limits)
        self.assertIn("tried again next cycle", " ".join(acts))
        b.cancel = real
        ap().reconcile(b, book, b.positions(), b.orders(), self.cfg, self.limits)
        self.assertEqual(b.ords[0]["status"], "canceled")

    def test_one_setups_client_ids_are_never_another_setups(self):
        a = ap()
        it = item(order_id="ord-BTCUSD-20261020-trend_breakout")
        self.assertTrue(a._mine({"client_order_id": "ord-BTCUSD-20261020-trend_breakout-stop"}, it))
        self.assertTrue(a._mine({"client_order_id": "ord-BTCUSD-20261020-trend_breakout"}, it))
        self.assertFalse(a._mine({"client_order_id": "ord-BTCUSD-20261020-trend_breakout_vol-stop"}, it))


class Entries(TraderTestCase):
    NOW = "2026-10-20T13:50:00Z"

    def test_a_forced_cycle_while_paused_buys_nothing(self):
        config.ensure_home()
        config.update_file("config.json", {"autopilot": {"universe": {"mode": "watchlist"},
                                                         "playbook": {"required_for_crypto": False}}})
        a = ap()
        a.write_control(by="cli", paused=True)
        a.write_control(by="cli", run_once=True)
        res = a.run_cycle("2026-10-20T13:50:00Z", approved=True)
        self.assertEqual(res["status"], "paused")
        self.assertFalse(a.read_control()["run_once"], "the forced cycle is used up")
        self.assertNotIn("placed", res["message"])

    def test_the_dashboard_started_from_the_config_asks_the_config_every_cycle(self):
        server = load("app", "server")
        seen = {}

        def fake_make_server(host, port, password, run_ap, news_every, approve=True):
            seen.update(run_ap=run_ap, approve=approve)
            raise server.StartupError("stop here")
        config.ensure_home()
        config.update_file("config.json", {"autopilot": {"enabled": True}})
        with mock.patch.object(server, "make_server", side_effect=fake_make_server):
            server.main([])
        self.assertEqual(seen, {"run_ap": True, "approve": False})
        app = server.DashboardApp("", True, None, approve=False)
        calls = []
        app._run_cycle(type("M", (), {"run_cycle": staticmethod(lambda **kw: calls.append(kw))}))
        self.assertIsNone(calls[0]["approved"])  # autopilot.enabled is read again, not overridden

    def test_bybit_book_names_match_its_positions_whatever_the_quote(self):
        from shared.brokers.bybit import BybitBroker
        bb = object.__new__(BybitBroker)
        bb.quote = "USDC"
        for key in ("BTCUSDT", "BTCUSDC", "BTC/USD", "BTCEUR"):
            self.assertEqual(bb.book_symbol(key, "crypto"), "BTC/USD")
        self.assertEqual(Fake().book_symbol("BTCUSDT", "crypto"), "BTC/USD")
