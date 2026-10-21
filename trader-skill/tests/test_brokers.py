"""Brokers: the local simulator's fill rules and the Alpaca adapter's requests (urlopen mocked)."""
from __future__ import annotations

import io
import json
import os
import socket
import urllib.error
import urllib.request
from unittest import mock

from tests.helpers import TraderTestCase
from shared import brokers, config, market_clock as mc, state
from shared.brokers import BrokerError
from shared.brokers.alpaca import AlpacaBroker
from shared.brokers.simulator import SimBroker
from shared.indicators import Candle

T0 = mc.ts("2026-10-20T13:50:00Z")


def bar(k, o, h, l, c):
    return Candle(T0 + 300 * k, o, h, l, c, 1000)


class Simulator(TraderTestCase):
    NOW = "2026-10-20T13:50:00Z"

    def sim(self, bars=None, symbol="NVDA"):
        b = SimBroker(config.load_config())
        if bars is not None:
            b._candles[(symbol, "stock")] = bars
        return b

    def entry(self, b, qty=10, limit=100.0, stop=98.0, target=104.0):
        return b.place_entry({"client_order_id": "ord-1", "symbol": "NVDA", "asset": "stock", "qty": qty,
                              "limit_price": limit, "stop_price": stop, "target_price": target})

    def test_bracket_entry_fill_then_target_cancels_stop(self):
        b = self.sim([bar(0, 100.5, 100.8, 99.6, 100.2), bar(1, 100.2, 104.5, 100.1, 104.2)])
        self.entry(b)
        self.assertEqual(len(b.open_orders()), 3)  # entry + held stop + held target
        self.set_now("2026-10-20T14:00:00Z")
        b.sync()
        orders = {o["leg"]: o for o in b.orders()}
        self.assertEqual(orders["entry"]["status"], "filled")
        self.assertEqual(orders["entry"]["filled_avg_price"], 100.0)  # min(limit, open)
        self.assertEqual(orders["target"]["status"], "filled")
        self.assertEqual(orders["target"]["filled_avg_price"], 104.0)
        self.assertEqual(orders["stop"]["status"], "canceled")
        self.assertEqual(b.positions(), [])
        self.assertAlmostEqual(b.account()["equity"], 25000 + 10 * 4.0, places=2)

    def test_stop_first_when_one_bar_touches_both(self):
        b = self.sim([bar(0, 100.0, 100.2, 99.9, 100.1), bar(1, 100.1, 104.5, 97.5, 101.0)])
        self.entry(b)
        self.set_now("2026-10-20T14:00:00Z")
        b.sync()
        orders = {o["leg"]: o for o in b.orders()}
        self.assertEqual(orders["stop"]["status"], "filled")
        self.assertEqual(orders["stop"]["filled_avg_price"], 97.98)  # stop less 2 bps slippage, to the cent
        self.assertEqual(orders["target"]["status"], "canceled")

    def test_gap_through_stop_fills_at_the_open(self):
        b = self.sim([bar(0, 100.0, 100.2, 99.9, 100.1), bar(1, 95.0, 96.0, 94.0, 95.5)])
        self.entry(b)
        self.set_now("2026-10-20T14:00:00Z")
        b.sync()
        stop = [o for o in b.orders() if o["leg"] == "stop"][0]
        self.assertEqual(stop["filled_avg_price"], 94.98)

    def test_entry_not_filled_when_price_never_comes_back(self):
        b = self.sim([bar(0, 101.0, 101.5, 100.5, 101.2)])
        self.entry(b)
        self.set_now("2026-10-20T13:55:00Z")
        b.sync()
        self.assertEqual([o["status"] for o in b.orders() if o["leg"] == "entry"], ["new"])
        self.set_now("2026-10-20T20:05:00Z")
        b._candles.clear()
        b._candles[("NVDA", "stock")] = [bar(0, 101.0, 101.5, 100.5, 101.2)]
        b.sync()
        self.assertEqual([o["status"] for o in b.orders() if o["leg"] == "entry"], ["expired"])

    def test_market_exit_and_close_position(self):
        b = self.sim([bar(0, 100.0, 100.2, 99.9, 100.1), bar(1, 100.1, 100.6, 100.0, 100.5)])
        self.entry(b)
        self.set_now("2026-10-20T14:00:00Z")
        b.sync()
        self.assertEqual(b.positions()[0]["last"], 100.5)
        res = b.close_position("NVDA")
        self.assertEqual(res["status"], "filled")
        self.assertEqual(res["filled_avg_price"], 100.48)  # last close less 2 bps
        self.assertEqual(b.positions(), [])
        self.assertTrue(all(o["status"] != "held" for o in b.orders()))
        self.assertTrue((self.home / "broker" / "sim.json").exists())

    def test_real_fixture_fill(self):
        b = SimBroker(config.load_config())
        b.place_entry({"client_order_id": "x", "symbol": "NVDA", "asset": "stock", "qty": 5, "limit_price": 193.93,
                       "stop_price": 190.90, "target_price": 199.96})
        self.set_now("2026-10-20T13:55:00Z")
        b2 = SimBroker(config.load_config())  # a fresh process sees the same book
        b2.sync()
        self.assertEqual(b2.positions()[0]["qty"], 5)

    def test_refusals(self):
        b = self.sim([bar(0, 100.0, 100.2, 99.9, 100.1)])
        with self.assertRaises(BrokerError):
            self.entry(b, qty=1000, limit=100.0)  # $100k with $25k cash
        with self.assertRaises(BrokerError):
            b.place_entry({"symbol": "x", "asset": "meme", "qty": 1, "limit_price": 1, "stop_price": 0.5,
                           "target_price": 2})


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class Alpaca(TraderTestCase):
    NOW = "2026-10-20T13:50:00Z"

    def setUp(self):
        super().setUp()
        os.environ.pop("TRADER_OFFLINE", None)  # Alpaca refuses offline; urlopen is mocked instead
        os.environ["ALPACA_PAPER_KEY_ID"] = "PKTESTKEY0123456789"
        os.environ["ALPACA_PAPER_SECRET_KEY"] = "sEcReT-should-never-leak-42"
        self.calls = []

    def fake(self, responses):
        responses = list(responses)

        def urlopen(req, timeout=0):
            self.calls.append({"method": req.get_method(), "url": req.full_url, "headers": dict(req.header_items()),
                               "body": json.loads(req.data.decode()) if req.data else None})
            r = responses.pop(0)
            if isinstance(r, Exception):
                raise r
            return FakeResponse(json.dumps(r).encode())
        from shared.brokers import alpaca as alpaca_mod
        return mock.patch.object(alpaca_mod, "_OPENER", type("Opener", (), {"open": staticmethod(urlopen)})())

    def broker(self):
        b = AlpacaBroker("paper", config.load_config())
        b._tick = lambda symbol, asset: 0.01
        b._crypto_lot = lambda symbol: {}
        return b

    def test_offline_and_missing_keys_refused(self):
        os.environ["TRADER_OFFLINE"] = "1"
        with self.assertRaises(BrokerError):
            AlpacaBroker("paper")
        os.environ.pop("TRADER_OFFLINE")
        os.environ.pop("ALPACA_PAPER_SECRET_KEY")
        with self.assertRaises(BrokerError) as cm:
            AlpacaBroker("paper")
        self.assertIn("ALPACA_PAPER_SECRET_KEY", str(cm.exception))
        self.assertIn("alpaca.markets", str(cm.exception))

    def test_stock_bracket_request_shape(self):
        with self.fake([{"id": "a1", "client_order_id": "ord-1", "symbol": "NVDA", "status": "accepted", "qty": "32",
                         "side": "buy", "type": "limit", "limit_price": "193.93"}]):
            o = self.broker().place_entry({"client_order_id": "ord-1", "symbol": "NVDA", "asset": "stock", "qty": 32,
                                           "limit_price": 193.93, "stop_price": 190.9, "target_price": 199.96})
        c = self.calls[0]
        self.assertEqual((c["method"], c["url"]), ("POST", "https://paper-api.alpaca.markets/v2/orders"))
        hdr = {k.lower(): v for k, v in c["headers"].items()}
        self.assertEqual(hdr["apca-api-key-id"], "PKTESTKEY0123456789")
        self.assertIn("apca-api-secret-key", hdr)
        self.assertEqual(c["body"], {"symbol": "NVDA", "qty": "32", "side": "buy", "type": "limit",
                                     "limit_price": "193.93", "client_order_id": "ord-1", "time_in_force": "day",
                                     "order_class": "bracket", "take_profit": {"limit_price": "199.96"},
                                     "stop_loss": {"stop_price": "190.90"}})
        self.assertEqual((o["id"], o["leg"], o["qty"]), ("a1", "entry", 32.0))

    def test_crypto_entry_has_no_bracket(self):
        with self.fake([{"id": "c1", "symbol": "BTC/USD", "status": "new", "qty": "0.05559"}]):
            self.broker().place_entry({"client_order_id": "ord-2", "symbol": "BTC/USD", "asset": "crypto",
                                       "qty": 0.05559, "limit_price": 67462.09, "stop_price": 67320.53,
                                       "target_price": 67704.74})
        body = self.calls[0]["body"]
        self.assertEqual((body["symbol"], body["time_in_force"], body["qty"], body["limit_price"]),
                         ("BTC/USD", "gtc", "0.05559", "67462.09"))
        self.assertNotIn("order_class", body)
        with self.fake([{"id": "s1", "symbol": "BTC/USD", "status": "new"}]):
            self.broker().place_stop("BTC/USD", 0.05559, 67320.53, client_order_id="ord-2-stop")
        stop = self.calls[1]["body"]
        self.assertEqual((stop["type"], stop["stop_price"], stop["side"]), ("stop_limit", "67320.53", "sell"))
        self.assertLess(float(stop["limit_price"]), float(stop["stop_price"]))

    def test_post_timeout_is_looked_up_not_resent(self):
        found = {"id": "a9", "client_order_id": "ord-9", "symbol": "NVDA", "status": "accepted"}
        with self.fake([socket.timeout("timed out"), found]), mock.patch("time.sleep"):
            o = self.broker().place_entry({"client_order_id": "ord-9", "symbol": "NVDA", "asset": "stock", "qty": 1,
                                           "limit_price": 10, "stop_price": 9, "target_price": 12})
        self.assertEqual(o["id"], "a9")
        self.assertEqual([c["method"] for c in self.calls], ["POST", "GET"])
        self.assertIn("orders:by_client_order_id?client_order_id=ord-9", self.calls[1]["url"])

    def test_a_resent_order_alpaca_already_has_is_found_not_lost(self):
        """POST timed out, the lookup did not see it yet, the resend is refused as a duplicate: it did land."""
        dup = urllib.error.HTTPError("u", 422, "dup", {}, io.BytesIO(b'{"message": "client_order_id must be unique"}'))
        nf = urllib.error.HTTPError("u", 404, "nf", {}, io.BytesIO(b"{}"))
        found = {"id": "a7", "client_order_id": "ord-7", "symbol": "NVDA", "status": "accepted"}
        with self.fake([socket.timeout("timed out"), nf, nf, nf, dup, found]), mock.patch("time.sleep"):
            o = self.broker().place_entry({"client_order_id": "ord-7", "symbol": "NVDA", "asset": "stock", "qty": 1,
                                           "limit_price": 10, "stop_price": 9, "target_price": 12})
        self.assertEqual(o["id"], "a7")
        self.assertEqual([c["method"] for c in self.calls], ["POST", "GET", "GET", "GET", "POST", "GET"])

    def test_a_bracket_takes_whole_shares_and_crypto_alpacas_own_steps(self):
        with self.fake([{"id": "a1", "symbol": "NVDA", "status": "accepted"}]):
            self.broker().place_entry({"client_order_id": "o", "symbol": "NVDA", "asset": "stock", "qty": 3.4567,
                                       "limit_price": 10, "stop_price": 9, "target_price": 12})
        self.assertEqual(self.calls[0]["body"]["qty"], "3")
        with self.assertRaises(BrokerError):
            self.broker().place_entry({"client_order_id": "o", "symbol": "NVDA", "asset": "stock", "qty": 0.5,
                                       "limit_price": 10, "stop_price": 9, "target_price": 12})
        b = AlpacaBroker("paper", config.load_config())
        assets = [{"symbol": "BTC/USD", "tradable": True, "price_increment": "1", "min_trade_increment": "0.0001",
                   "min_order_size": "0.0002"}]
        with self.fake([assets, {"id": "c1", "symbol": "BTC/USD", "status": "new"}]):
            b.place_entry({"client_order_id": "o", "symbol": "BTC/USD", "asset": "crypto", "qty": 0.055594,
                           "limit_price": 67462.09, "stop_price": 1, "target_price": 2})
            with self.assertRaises(BrokerError):
                b.place_stop("BTC/USD", 0.00015, 60000.0)
        self.assertEqual((self.calls[-1]["body"]["qty"], self.calls[-1]["body"]["limit_price"]), ("0.0555", "67462"))

    def test_a_redirect_never_carries_the_keys_elsewhere(self):
        from shared.brokers.alpaca import _NoRedirect
        req = urllib.request.Request("https://paper-api.alpaca.markets/v2/account", headers={"APCA-API-KEY-ID": "k"})
        with self.assertRaises(urllib.error.HTTPError):
            _NoRedirect().redirect_request(req, io.BytesIO(b""), 302, "Found", {}, "https://evil.example/")

    def test_rejection_message_and_no_secret_leak(self):
        err = urllib.error.HTTPError("https://paper-api.alpaca.markets/v2/orders", 403, "Forbidden", {},
                                     io.BytesIO(b'{"message": "insufficient buying power"}'))
        with self.fake([err]):
            with self.assertRaises(BrokerError) as cm:
                self.broker().place_entry({"client_order_id": "o", "symbol": "NVDA", "asset": "stock", "qty": 1,
                                           "limit_price": 10, "stop_price": 9, "target_price": 12})
        self.assertIn("insufficient buying power", str(cm.exception))
        for f in self.home.rglob("*"):
            if f.is_file():
                text = f.read_text(encoding="utf-8", errors="ignore")
                self.assertNotIn("sEcReT-should-never-leak-42", text, f)
                self.assertNotIn("PKTESTKEY0123456789", text, f)

    def test_positions_and_orders_mapping(self):
        with self.fake([[{"symbol": "BTCUSD", "asset_class": "crypto", "qty": "0.05", "avg_entry_price": "67000",
                          "current_price": "67500", "market_value": "3375", "unrealized_pl": "25"}],
                        [{"id": "p", "symbol": "NVDA", "side": "buy", "type": "limit", "status": "filled",
                          "filled_avg_price": "193.92", "qty": "32", "legs": [
                              {"id": "s", "symbol": "NVDA", "side": "sell", "type": "stop", "status": "held"},
                              {"id": "t", "symbol": "NVDA", "side": "sell", "type": "limit", "status": "held"}]}],
                        [{"id": "old-stop", "symbol": "GBTC", "side": "sell", "type": "stop", "status": "new"}]]):
            b = self.broker()
            pos = b.positions()
            orders = b.orders()
        self.assertEqual((pos[0]["symbol"], pos[0]["asset"], pos[0]["last"]), ("BTC/USD", "crypto", 67500.0))
        self.assertEqual([(o["id"], o["leg"], o["parent_id"]) for o in orders],
                         [("p", None, None), ("s", "stop", "p"), ("t", "target", "p"), ("old-stop", None, None)])
        self.assertEqual(orders[-1]["symbol"], "GBTC")   # an open order older than the page, and a stock not G/BTC
        self.assertIn("limit=500", self.calls[1]["url"])
        self.assertIn("status=open", self.calls[2]["url"])


    def test_tradable_crypto_assets_cached_and_failure_tolerant(self):
        assets = [{"symbol": "BTC/USD", "class": "crypto", "tradable": True},
                  {"symbol": "ETH/USD", "class": "crypto", "tradable": True},
                  {"symbol": "DOGEUSD", "class": "crypto", "tradable": True},
                  {"symbol": "XYZ/USD", "class": "crypto", "tradable": False}]
        b = self.broker()
        with self.fake([assets]):
            self.assertEqual(b.tradable("crypto"), {"BTC", "ETH", "DOGE"})
            self.assertEqual(b.tradable("crypto"), {"BTC", "ETH", "DOGE"})  # cached: one request
            self.assertIsNone(b.tradable("stock"))
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0]["url"],
                         "https://paper-api.alpaca.markets/v2/assets?asset_class=crypto&status=active")
        err = urllib.error.HTTPError("u", 500, "err", {}, io.BytesIO(b"{}"))
        b2 = self.broker()
        with self.fake([err, err]), mock.patch("time.sleep"):
            self.assertIsNone(b2.tradable("crypto"))
        self.assertIn("asset list unavailable", b2.notes[0])

    def test_simulator_trades_anything(self):
        from shared.brokers.simulator import SimBroker
        self.assertIsNone(SimBroker(config.load_config()).tradable("crypto"))


class Readiness(TraderTestCase):
    def test_live_needs_every_step(self):
        cfg = config.load_config()
        ok, missing = brokers.live_readiness(cfg)
        self.assertFalse(ok)
        self.assertEqual(len(missing), 6)
        cfg["autopilot"].update(broker="alpaca", mode="live", live_confirmation=brokers.LIVE_PHRASE)
        cfg["paper"] = False
        os.environ["ALPACA_LIVE_KEY_ID"], os.environ["ALPACA_LIVE_SECRET_KEY"] = "k" * 12, "s" * 12
        self.assertEqual(brokers.live_readiness(cfg), (True, []))
        cfg["autopilot"]["live_confirmation"] = "yes"
        with self.assertRaises(BrokerError) as cm:
            brokers.get(cfg)
        self.assertIn("I ACCEPT REAL MONEY RISK", str(cm.exception))

    def test_default_is_simulator(self):
        b = brokers.get(config.load_config())
        self.assertEqual((b.name, b.mode), ("simulator", "simulator"))
        cfg = config.load_config()
        cfg["autopilot"]["broker"] = "alpaca"
        with self.assertRaises(BrokerError) as cm:
            brokers.get(cfg)
        self.assertIn("ALPACA_PAPER_KEY_ID", str(cm.exception))

    def test_broker_symbols(self):
        self.assertEqual(brokers.broker_symbol("BTCUSDT", "crypto"), "BTC/USD")
        self.assertEqual(brokers.broker_symbol("TSLA", "stock"), "TSLA")
        with self.assertRaises(BrokerError):
            brokers.broker_symbol("SOL:Fk6KsBpNNTxEMb4bovfUMjB4xZiZ8376ritJ6qzWpump")
        self.assertIsNotNone(state)
