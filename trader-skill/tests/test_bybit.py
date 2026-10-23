"""Bybit EU spot (and spot margin): requests, signatures, the rules the adapter keeps, and the live opt-in."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import socket
import urllib.parse
from unittest import mock

from shared import brokers, config
from shared.brokers import BrokerError
from shared.brokers import bybit as bybit_mod
from shared.brokers.bybit import BybitBroker
from tests.helpers import TraderTestCase, load
from tests.test_brokers import FakeResponse

KEY, SECRET = "BYTESTKEY123", "bybit-secret-never-leaks-77"
INSTRUMENTS = [
    {"symbol": "BTCUSDC", "baseCoin": "BTC", "quoteCoin": "USDC", "status": "Trading", "marginTrading": "utaOnly",
     "lotSizeFilter": {"basePrecision": "0.000001", "minOrderAmt": "5"}, "priceFilter": {"tickSize": "0.1"}},
    {"symbol": "SOLUSDC", "baseCoin": "SOL", "quoteCoin": "USDC", "status": "Trading", "marginTrading": "none",
     "lotSizeFilter": {"basePrecision": "0.001", "minOrderAmt": "5"}, "priceFilter": {"tickSize": "0.01"}},
    {"symbol": "BTCUSDT", "baseCoin": "BTC", "quoteCoin": "USDT", "status": "Trading", "marginTrading": "both",
     "lotSizeFilter": {"basePrecision": "0.000001", "minOrderAmt": "5"}, "priceFilter": {"tickSize": "0.1"}},
]


def ok(result):
    return {"retCode": 0, "retMsg": "OK", "result": result, "time": 1792800000000}


class FakeBybit:
    """Answers like Bybit's v5 API, from a script per path; records every request."""

    def __init__(self):
        self.calls, self.script = [], {}
        self.orders = {}  # orderId → order record (what realtime/history list)
        self.n = 0

    def on(self, path, *replies):
        self.script.setdefault(path, []).extend(replies)

    def open(self, req, timeout=0):
        url = urllib.parse.urlsplit(req.full_url)
        q = dict(urllib.parse.parse_qsl(url.query))
        body = json.loads(req.data.decode()) if req.data else None
        self.calls.append({"method": req.get_method(), "path": url.path, "query": q, "body": body,
                           "raw_query": url.query, "raw_body": req.data.decode() if req.data else None,
                           "headers": {k.lower(): v for k, v in req.header_items()}})
        if self.script.get(url.path):
            r = self.script[url.path].pop(0)
            if isinstance(r, Exception):
                raise r
            return FakeResponse(json.dumps(r).encode())
        return FakeResponse(json.dumps(self.default(url.path, q, body)).encode())

    def default(self, path, q, body):
        if path == "/v5/market/time":
            return ok({"timeSecond": "1792800000", "timeNano": "1792800000000000000"})
        if path == "/v5/market/instruments-info":
            return ok({"category": "spot", "list": INSTRUMENTS})
        if path == "/v5/spot-margin-trade/state":
            return ok({"spotLeverage": "2", "spotMarginMode": "1", "effectiveLeverage": "1"})
        if path == "/v5/order/create":
            self.n += 1
            oid = "oid-%d" % self.n
            self.orders[oid] = {"orderId": oid, "orderLinkId": body.get("orderLinkId") or "", "symbol": body["symbol"],
                                "side": body["side"], "orderType": body["orderType"], "price": body.get("price", "0"),
                                "qty": body["qty"], "orderStatus": "Untriggered" if body.get("triggerPrice") else "New",
                                "cumExecQty": "0", "avgPrice": "", "triggerPrice": body.get("triggerPrice", "0"),
                                "timeInForce": body.get("timeInForce", "GTC"), "createdTime": "1792800000000",
                                "updatedTime": "1792800000000"}
            return ok({"orderId": oid, "orderLinkId": body.get("orderLinkId")})
        if path in ("/v5/order/realtime", "/v5/order/history"):
            rows = list(self.orders.values())
            if q.get("orderId"):
                rows = [r for r in rows if r["orderId"] == q["orderId"]]
            if q.get("orderLinkId"):
                rows = [r for r in rows if r["orderLinkId"] == q["orderLinkId"]]
            live = path.endswith("realtime")
            rows = [r for r in rows if (r["orderStatus"] in ("New", "Untriggered", "PartiallyFilled")) == live
                    or q.get("orderId") or q.get("orderLinkId")]
            return ok({"list": rows, "nextPageCursor": ""})
        if path == "/v5/order/cancel":
            self.orders[body["orderId"]]["orderStatus"] = "Cancelled"
            return ok({"orderId": body["orderId"]})
        return ok({})

    def posts(self, path):
        return [c for c in self.calls if c["method"] == "POST" and c["path"] == path]


class BybitBase(TraderTestCase):
    NOW = "2026-10-20T13:50:00Z"

    def setUp(self):
        super().setUp()
        os.environ.pop("TRADER_OFFLINE", None)  # the adapter refuses offline; its opener is faked instead
        os.environ["BYBIT_TESTNET_KEY"], os.environ["BYBIT_TESTNET_SECRET"] = KEY, SECRET
        self.ex = FakeBybit()
        self.patch = mock.patch.object(bybit_mod, "_OPENER", self.ex)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def broker(self, lev=1.0):
        if lev > 1:
            config.update_file("config.json", {"leverage": {"crypto": lev}})
            config.update_file("limits.json", {"crypto": {"allow_leverage": True, "max_leverage": lev}})
        return BybitBroker("paper", config.load_config())


class BybitAdapter(BybitBase):
    def test_refuses_offline_and_without_keys_and_names_where_to_get_them(self):
        os.environ["TRADER_OFFLINE"] = "1"
        with self.assertRaises(BrokerError):
            BybitBroker("paper")
        os.environ.pop("TRADER_OFFLINE")
        os.environ.pop("BYBIT_TESTNET_SECRET")
        with self.assertRaises(BrokerError) as cm:
            BybitBroker("paper")
        self.assertIn("BYBIT_TESTNET_SECRET", str(cm.exception))
        self.assertIn("testnet.bybit.com", str(cm.exception))

    def test_every_signed_request_signs_exactly_what_it_sends(self):
        b = self.broker()
        b.account()
        b.place_entry({"symbol": "BTC/USD", "asset": "crypto", "qty": 0.0031234567, "limit_price": 69629.95,
                       "client_order_id": "ord-1"})
        signed = [c for c in self.ex.calls if "x-bapi-sign" in c["headers"]]
        self.assertTrue(signed)
        for c in signed:
            h = c["headers"]
            payload = c["raw_query"] if c["method"] == "GET" else c["raw_body"]
            want = hmac.new(SECRET.encode(), (h["x-bapi-timestamp"] + KEY + h["x-bapi-recv-window"] + payload).encode(),
                            hashlib.sha256).hexdigest()
            self.assertEqual(h["x-bapi-sign"], want, c["path"])
            self.assertEqual(h["x-bapi-api-key"], KEY)
            self.assertNotIn(SECRET, json.dumps(c))  # the secret signs; it never travels
        log = (self.home / "broker" / "log.jsonl").read_text()
        self.assertNotIn(SECRET, log)
        self.assertNotIn(KEY, log)

    def test_paper_is_the_testnet_and_live_is_bybit_eu(self):
        self.assertEqual(self.broker().base, "https://api-testnet.bybit.com")
        os.environ["BYBIT_LIVE_KEY"], os.environ["BYBIT_LIVE_SECRET"] = KEY, SECRET
        self.assertEqual(BybitBroker("live", config.load_config()).base, "https://api.bybit.eu")

    def test_entry_without_leverage_never_borrows(self):
        b = self.broker()
        o = b.place_entry({"symbol": "BTC/USD", "asset": "crypto", "qty": 0.0031234567, "limit_price": 69629.97,
                           "client_order_id": "ord-1", "leverage": 1.0})
        body = self.ex.posts("/v5/order/create")[0]["body"]
        self.assertEqual((body["symbol"], body["side"], body["orderType"], body["isLeverage"]),
                         ("BTCUSDC", "Buy", "Limit", 0))
        self.assertEqual(body["qty"], "0.003123")   # floored to the coin's step
        self.assertEqual(body["price"], "69630.0")  # on the tick
        self.assertEqual(o["client_order_id"], "ord-1")
        self.assertFalse(self.ex.posts("/v5/spot-margin-trade/switch-mode"))

    def test_entry_with_leverage_borrows_and_sets_the_account_to_two_times_at_most(self):
        b = self.broker(lev=1.5)
        b.place_entry({"symbol": "BTC/USD", "asset": "crypto", "qty": 0.01, "limit_price": 69000,
                       "client_order_id": "ord-2", "leverage": 1.5})
        self.assertEqual(self.ex.posts("/v5/order/create")[0]["body"]["isLeverage"], 1)
        self.assertEqual(self.ex.posts("/v5/spot-margin-trade/switch-mode")[0]["body"], {"spotMarginMode": "1"})
        self.assertEqual(self.ex.posts("/v5/spot-margin-trade/set-leverage")[0]["body"], {"leverage": "2"})
        self.assertEqual(self.ex.posts("/v5/spot-margin-trade/set-auto-repay-mode")[0]["body"],
                         {"currency": "USDC", "autoRepayMode": "1"})

    def test_no_leverage_where_bybit_does_not_lend_or_on_a_meme_coin(self):
        b = self.broker(lev=1.5)
        with self.assertRaises(BrokerError) as cm:
            b.place_entry({"symbol": "SOL/USD", "asset": "crypto", "qty": 1, "limit_price": 100,
                           "client_order_id": "ord-3", "leverage": 1.5})
        self.assertIn("does not lend", str(cm.exception))
        self.assertFalse(self.ex.posts("/v5/order/create"))
        INSTRUMENTS.append({"symbol": "DOGEUSDC", "baseCoin": "DOGE", "quoteCoin": "USDC", "status": "Trading",
                            "marginTrading": "both", "lotSizeFilter": {"basePrecision": "1", "minOrderAmt": "5"},
                            "priceFilter": {"tickSize": "0.00001"}})
        self.addCleanup(INSTRUMENTS.pop)
        b._info = {}
        b.place_entry({"symbol": "DOGE/USD", "asset": "crypto", "qty": 100, "limit_price": 0.2,
                       "client_order_id": "ord-4", "leverage": 1.5})
        self.assertEqual(self.ex.posts("/v5/order/create")[-1]["body"]["isLeverage"], 0)

    def test_sales_and_stops_never_borrow_and_stops_sit_at_the_exchange(self):
        b = self.broker(lev=1.5)
        s = b.place_stop("BTC/USD", 0.0031, 65000.04, client_order_id="ord-1-stop")
        x = b.place_exit("BTC/USD", 0.0031, "market", client_order_id="ord-1-x1")
        stop, sell = [c["body"] for c in self.ex.posts("/v5/order/create")]
        self.assertEqual((stop["orderFilter"], stop["orderType"], stop["triggerPrice"], stop["side"]),
                         ("tpslOrder", "Market", "65000.0", "Sell"))
        self.assertEqual(stop["isLeverage"], 0)
        self.assertEqual(sell["isLeverage"], 0)
        self.assertEqual(sell["marketUnit"], "baseCoin")
        self.assertEqual((s["leg"], s["type"]), ("stop", "stop"))
        self.assertEqual(x["leg"], "exit")

    def test_a_long_client_id_travels_as_a_hash_and_comes_back_as_itself(self):
        b = self.broker()
        cid = "ord-BTCUSDT-20261020-trend_breakout-x1792800000000"
        b.place_exit("BTC/USD", 0.001, "market", client_order_id=cid)
        link = self.ex.posts("/v5/order/create")[0]["body"]["orderLinkId"]
        self.assertLessEqual(len(link), 36)
        self.assertNotEqual(link, cid)
        self.assertEqual(b.find_client(cid)["client_order_id"], cid)
        self.assertEqual([o["client_order_id"] for o in b.orders()], [cid])

    def test_a_lost_reply_is_looked_up_before_anything_is_sent_again(self):
        b = self.broker()
        real = self.ex.default

        def landed_then_timeout(path, q, body):  # the order lands, the answer never comes back
            real(path, q, body)
            raise socket.timeout("timed out")
        self.ex.on("/v5/order/create")
        with mock.patch.object(self.ex, "default", side_effect=lambda p, q, bd: landed_then_timeout(p, q, bd)
                               if p == "/v5/order/create" else real(p, q, bd)):
            o = b.place_entry({"symbol": "BTC/USD", "asset": "crypto", "qty": 0.01, "limit_price": 69000,
                               "client_order_id": "ord-9"})
        self.assertEqual(len(self.ex.posts("/v5/order/create")), 1, "sent once, found by its client id")
        self.assertEqual(o["client_order_id"], "ord-9")

    def test_a_duplicate_id_returns_the_order_already_there(self):
        b = self.broker()
        b.place_entry({"symbol": "BTC/USD", "asset": "crypto", "qty": 0.01, "limit_price": 69000,
                       "client_order_id": "ord-5"})
        self.ex.on("/v5/order/create", {"retCode": 170141, "retMsg": "Duplicate clientOrderId.", "result": {}})
        again = b.place_entry({"symbol": "BTC/USD", "asset": "crypto", "qty": 0.01, "limit_price": 69000,
                               "client_order_id": "ord-5"})
        self.assertEqual(again["id"], "oid-1")

    def test_a_refusal_is_an_error_not_an_order(self):
        b = self.broker()
        self.ex.on("/v5/order/create", {"retCode": 170131, "retMsg": "Insufficient balance.", "result": {}})
        with self.assertRaises(BrokerError) as cm:
            b.place_exit("BTC/USD", 1.0, "market", client_order_id="ord-6-x1")
        self.assertIn("Insufficient balance", str(cm.exception))

    def test_account_cash_goes_negative_while_a_margin_loan_is_open(self):
        self.ex.on("/v5/account/wallet-balance", ok({"list": [{"totalEquity": "1500", "totalAvailableBalance": "900",
                   "coin": [{"coin": "USDC", "walletBalance": "100", "spotBorrow": "400", "usdValue": "100"},
                            {"coin": "BTC", "walletBalance": "0.02", "spotBorrow": "0", "usdValue": "1400"}]}]}),
                   ok({"list": [{"totalEquity": "1500",
                   "coin": [{"coin": "USDC", "walletBalance": "100", "spotBorrow": "400", "usdValue": "100"},
                            {"coin": "BTC", "walletBalance": "0.02", "spotBorrow": "0", "usdValue": "1400"}]}]}))
        b = self.broker(lev=1.5)
        a = b.account()
        self.assertEqual((a["equity"], a["cash"], a["borrowed"]), (1500.0, -300.0, 300.0))
        self.assertEqual(a["buying_power"], -300.0 + 1500.0)  # the account's 2×: the autopilot caps at its own 1.5×
        pos = b.positions()
        self.assertEqual([(p["symbol"], p["qty"], round(p["last"])) for p in pos], [("BTC/USD", 0.02, 70000)])

    def test_a_filled_buy_reports_the_coins_received_after_the_fee(self):
        b = self.broker()
        b._instruments()
        o = b._order({"orderId": "x", "orderLinkId": "ord-7", "symbol": "BTCUSDC", "side": "Buy", "orderType": "Limit",
                      "qty": "0.01", "price": "69000", "orderStatus": "Filled", "cumExecQty": "0.01",
                      "avgPrice": "68990", "cumFeeDetail": {"BTC": "0.00001"}, "updatedTime": "1792800000000"})
        self.assertAlmostEqual(o["filled_qty"], 0.00999)
        self.assertEqual((o["status"], o["filled_avg_price"], o["symbol"]), ("filled", 68990.0, "BTC/USD"))

    def test_cancel_finds_the_symbol_and_says_it_is_a_stop(self):
        b = self.broker()
        s = b.place_stop("BTC/USD", 0.001, 65000, client_order_id="ord-8-stop")
        b.cancel(s["id"])
        body = self.ex.posts("/v5/order/cancel")[0]["body"]
        self.assertEqual((body["symbol"], body["orderFilter"], body["orderId"]), ("BTCUSDC", "tpslOrder", s["id"]))
        self.assertEqual(b.cancel("no-such-order")["status"], "canceled")

    def test_tradable_is_the_quote_coins_pairs_and_with_leverage_only_those_bybit_lends_on(self):
        self.assertEqual(self.broker().tradable("crypto"), {"BTC", "SOL"})
        self.assertEqual(self.broker().tradable("stock"), set())
        self.assertEqual(self.broker(lev=1.5).tradable("crypto"), {"BTC"})

    def test_stocks_are_never_sent(self):
        with self.assertRaises(BrokerError):
            self.broker().place_entry({"symbol": "TSLA", "asset": "stock", "qty": 1, "limit_price": 300})

    def test_a_blocked_country_says_so(self):
        import urllib.error
        self.ex.on("/v5/account/wallet-balance", urllib.error.HTTPError("u", 403, "Forbidden", {}, None))
        self.ex.on("/v5/account/wallet-balance", urllib.error.HTTPError("u", 403, "Forbidden", {}, None))
        with self.assertRaises(BrokerError) as cm:
            self.broker().account()
        self.assertIn("EEA", str(cm.exception))


class BybitOptIn(TraderTestCase):
    def cfg(self, **ap):
        c = config.load_config()
        c["autopilot"].update(ap)
        return c

    def test_paper_needs_testnet_keys_and_live_needs_every_step(self):
        os.environ.pop("TRADER_OFFLINE", None)
        with self.assertRaises(BrokerError) as cm:
            brokers.get(self.cfg(broker="bybit"))
        self.assertIn("BYBIT_TESTNET_KEY", str(cm.exception))
        c = self.cfg(broker="bybit", mode="live", live_confirmation=brokers.LIVE_PHRASE)
        c["paper"] = False
        ok_, missing = brokers.live_readiness(c, book=False)
        self.assertFalse(ok_)
        self.assertTrue(any("BYBIT_LIVE_KEY" in m for m in missing))
        os.environ["BYBIT_LIVE_KEY"], os.environ["BYBIT_LIVE_SECRET"] = KEY, SECRET
        self.assertEqual(brokers.live_readiness(c, book=False), (True, []))
        for broken in ({"paper": True}, {"autopilot": dict(c["autopilot"], live_confirmation="yes")},
                       {"autopilot": dict(c["autopilot"], broker="simulator")}):
            self.assertFalse(brokers.live_readiness(dict(c, **broken), book=False)[0], broken)
        with mock.patch.object(bybit_mod, "_OPENER", FakeBybit()):
            self.assertEqual(brokers.get(c).name, "bybit")
            self.assertEqual(brokers.get(c).mode, "live")

    def test_alpaca_keys_never_open_bybit_live(self):
        os.environ["ALPACA_LIVE_KEY_ID"], os.environ["ALPACA_LIVE_SECRET_KEY"] = "A", "B"
        c = self.cfg(broker="bybit", mode="live", live_confirmation=brokers.LIVE_PHRASE)
        c["paper"] = False
        self.assertFalse(brokers.live_readiness(c, book=False)[0])

    def test_leverage_is_allowed_at_bybit_but_never_for_meme_coins_or_past_two(self):
        cfg = dict(config.load_config(), leverage={"crypto": 5.0})
        lim = config.deep_merge(config.load_limits(), {"crypto": {"allow_leverage": True, "max_leverage": 5}})
        self.assertEqual(config.leverage(cfg, lim, "crypto", "bybit", "BTC")[0], config.LEVERAGE_HARD_CAP)
        self.assertEqual(config.leverage(cfg, lim, "crypto", "alpaca", "BTC")[0], 1.0)
        self.assertEqual(config.leverage(cfg, lim, "crypto", "bybit", "PEPE")[0], 1.0)


class VenueProfile(TraderTestCase):
    def test_bybit_costs_no_cash_interest_and_no_etf_leg_and_the_broker_untouched(self):
        ap = load("trader-autopilot", "autopilot")
        cfg, _ = ap.trend_profile(2, 1.5, 1, 1000.0, core_risk=3, fixed_risk=True, venue="bybit")
        self.assertEqual(cfg["costs"]["crypto"], {"fee_bps": 15.0, "slippage_bps": 3.0})
        self.assertEqual((cfg["borrow_rate_pct"], cfg["cash_yield_pct"]), (20.0, 0.0))
        self.assertIs(cfg["autopilot"]["etf_trend"]["enabled"], False)
        self.assertNotIn("broker", cfg["autopilot"])
        self.assertNotIn("mode", cfg["autopilot"])
        with self.assertRaises(ValueError):
            ap.trend_profile(2, 1, 1, 1000.0, venue="binance")

    def test_the_daemon_wakes_just_after_the_daily_close(self):
        ap = load("trader-autopilot", "autopilot")
        self.assertEqual(ap.next_daily_close(1792799999.0), 1792800000 + ap.DAILY_CLOSE_DELAY_SEC)
        self.assertEqual(ap.next_daily_close(1792800006.0), 1792886400 + ap.DAILY_CLOSE_DELAY_SEC)


class TheAutopilotTradesThroughBybit(BybitBase):
    """A filled buy gets its stop at the exchange (the coins received after the fee), the stop's fill closes it."""
    NOW = "2026-10-20T14:45:00Z"

    def test_fill_stop_at_the_exchange_then_the_stop_closes_the_trade(self):
        from shared import state
        a = load("trader-autopilot", "autopilot")
        plan = {"id": "BTCUSD-20261020-trend_breakout", "symbol": "BTC/USD", "symbol_display": "BTC/USD",
                "asset": "crypto", "setup": "trend_breakout", "entry": {"price": 69000.0, "time": "2026-10-20T00:00:05Z"},
                "stop": {"price": 64000.0}, "target": {"price": 200000.0}, "risk_per_unit": 5000.0,
                "time_stop": {"at": "2026-12-19T00:00:00Z"}}
        self.write_state("plan.json", {"plans": {plan["id"]: plan}})
        cid = "ord-" + plan["id"]
        self.write_state("orders.json", {"orders": [{"id": cid, "plan_id": plan["id"], "qty": 0.006}]})
        b = self.broker()
        entry = b.place_entry({"symbol": "BTC/USD", "asset": "crypto", "qty": 0.006, "limit_price": 69000.0,
                               "client_order_id": cid})
        rec = self.ex.orders[entry["id"]]
        rec.update(orderStatus="Filled", cumExecQty="0.006", avgPrice="68990", cumFeeDetail={"BTC": "0.000006"},
                   updatedTime="1792800300000")
        book = {"items": {plan["id"]: {"plan_id": plan["id"], "order_id": cid, "broker_order_id": entry["id"],
                                       "broker": "bybit", "mode": "paper", "symbol": "BTC/USD", "data_key": "BTCUSDT",
                                       "asset": "crypto", "qty": 0.006, "qty_unit": "coins", "stop": 64000.0,
                                       "target": 200000.0, "time_stop": "2026-12-19T00:00:00Z", "status": "pending",
                                       "placed_at": "2026-10-20T00:00:05Z"}}, "handled": {}}
        cfg, limits = config.load_config(), config.load_limits()
        a.reconcile(b, book, [], b.orders(), cfg, limits)
        it = book["items"][plan["id"]]
        self.assertEqual(it["status"], "open")
        self.assertAlmostEqual(it["qty"], 0.005994)
        stop = self.ex.posts("/v5/order/create")[-1]["body"]
        self.assertEqual((stop["orderFilter"], stop["qty"], stop["triggerPrice"]), ("tpslOrder", "0.005994", "64000.0"))
        # it is the bot's working stop — the exits leave it alone
        self.assertIsNotNone(a._live_stop(it, b.orders()))
        srec = self.ex.orders[it["stop_order_id"]]
        srec.update(orderStatus="Filled", cumExecQty="0.005994", avgPrice="63990", updatedTime="1792803000000")
        a.reconcile(b, book, [], b.orders(), cfg, limits)
        self.assertEqual((it["status"], it["exit_reason"]), ("closed", "stop"))
        t = state.read_json("journal.json")["trades"][0]
        self.assertEqual((t["status"], t["exit"]["reason"]), ("closed", "stop"))
        self.assertLess(t["pnl_usd"], 0)


class BrokerTest(BybitBase):
    def test_read_only_calls_and_nothing_sent(self):
        a = load("trader-autopilot", "autopilot")
        cfg = config.load_config()
        cfg["autopilot"]["broker"] = "bybit"
        self.ex.on("/v5/account/wallet-balance", ok({"list": [{"totalEquity": "1000", "coin": [
            {"coin": "USDC", "walletBalance": "1000", "spotBorrow": "0", "usdValue": "1000"}]}]}),
            ok({"list": [{"totalEquity": "1000", "coin": []}]}))
        res = a.broker_test(cfg)
        self.assertTrue(res["ok"], res)
        self.assertIn("equity $1,000.00", "\n".join(res["lines"]))
        self.assertFalse([c for c in self.ex.calls if c["method"] == "POST"])
