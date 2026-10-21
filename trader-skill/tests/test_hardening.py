"""Round three: a mistyped setting, a broken quote, your own orders on the same symbol, a split, a stuck source —
none of it may stop the stops, trade by accident or take what is yours."""
from __future__ import annotations

import json
import time

from tests.helpers import TraderTestCase, load
from tests.test_app import DashboardCase
from tests.test_autopilot import FakeBroker, OnlyWhatTheBotOwns, Seller
from shared import config, data, state


def ap():
    return load("trader-autopilot", "autopilot")


class MistypedSettings(TraderTestCase):
    def write(self, name, doc):
        config.ensure_home()
        (self.home / name).write_text(json.dumps(doc))

    def test_a_wrong_type_is_an_error_not_a_quiet_yes_or_no_limit(self):
        for name, doc, needle in (
                ("limits.json", {"global": {"max_daily_loss_pct": "5%"}}, "max_daily_loss_pct must be a number"),
                ("config.json", {"autopilot": {"enabled": "false"}}, "enabled must be true or false"),
                ("limits.json", {"stock": None}, "stock must be an object"),
                ("limits.json", {"global": {"max_daily_loss_usd": 0}}, "must be above 0"),
                ("config.json", {"autopilot": {"interval_sec": 1}}, "at least 5 seconds"),
                ("limits.json", {"blocked_symbols": "TSLA"}, "must be a list")):
            self.write(name, doc)
            with self.assertRaises(config.ConfigError) as cm:
                config.load_config() if name == "config.json" else config.load_limits()
            self.assertIn(needle, str(cm.exception))
            (self.home / name).write_text("{}")

    def test_an_explicit_null_limit_keeps_its_default(self):
        self.write("limits.json", {"stock": {"max_position_pct": None}})
        self.assertEqual(config.load_limits()["stock"]["max_position_pct"], 25)
        self.assertTrue(any("max_position_pct is null" in w for w in config.warnings))

    def test_switches_count_only_when_really_true(self):
        self.assertFalse(ap()._approved({"autopilot": {"enabled": "false"}}, None))
        self.assertTrue(ap()._approved({"autopilot": {"enabled": True}}, None))
        lev = config.leverage({"leverage": {"stock": 2.0}}, {"stock": {"allow_margin": "false", "max_leverage": 2}},
                              "stock", "simulator")
        self.assertEqual(lev[0], 1.0)

    def test_a_typo_after_a_good_start_still_runs_the_time_stop(self):
        config.ensure_home()
        a = ap()
        good = a.run_cycle("2026-10-20T15:00:00Z", approved=True)
        self.assertNotEqual(good["status"], "error", good)
        broker = a.brokers.get(config.load_config())
        broker.book["positions"]["NVDA"] = {"symbol": "NVDA", "asset": "stock", "qty": 10.0, "avg_entry": 100.0,
                                            "last": 101.0, "opened_at": "2026-10-20T14:02:00Z"}
        broker._save()
        book = {"items": {"p1": {"plan_id": "p1", "order_id": "ord-p1", "broker_order_id": "e1", "broker": "simulator",
                                 "mode": "simulator", "symbol": "NVDA", "data_key": "NVDA", "asset": "stock",
                                 "qty": 10.0, "stop": 95.0, "target": 110.0, "time_stop": "2026-10-20T15:30:00Z",
                                 "status": "open", "placed_at": "2026-10-20T14:00:00Z",
                                 "filled_at": "2026-10-20T14:02:00Z"}}, "handled": {}}
        state.write_json("autopilot/book.json", book)
        (self.home / "limits.json").write_text(json.dumps({"global": {"max_daily_loss_pct": "5%"}}))
        res = a.run_cycle("2026-10-20T15:35:00Z", approved=True)
        self.assertTrue(any("time exit for NVDA" in x for x in res["actions"]), res)
        self.assertTrue(any("last good settings" in e for e in res["errors"]), res)
        self.assertEqual(res["decisions"], [])


class YourOwnOrders(OnlyWhatTheBotOwns):
    def test_your_stop_is_not_the_bots_and_is_never_cancelled(self):
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z", time_stop="2026-10-20T14:30:00Z")
        yours = {"id": "u-stop", "client_order_id": "my-stop", "symbol": "NVDA", "side": "sell", "type": "stop",
                 "status": "new"}
        pos = [{"symbol": "NVDA", "asset": "stock", "qty": 25.0, "last": 101.0}]
        self.assertIsNone(ap()._live_stop(self.it, [yours]))
        ap().manage_exits(self.b, self.book, pos, [yours], self.cfg)
        self.assertNotIn(("cancel", "u-stop"), self.b.calls)
        self.assertEqual(self.b.calls[-1], ("exit", "NVDA", 10.0))

    def test_a_partial_sale_cancels_only_the_bots_orders(self):
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z", stop_order_id="bot-stop",
                       runner={"status": "planned", "sell_qty": 3.0, "keep": 0.67})
        orders = [{"id": "bot-stop", "symbol": "NVDA", "side": "sell", "status": "new", "type": "stop"},
                  {"id": "u-tp", "client_order_id": "mine", "symbol": "NVDA", "side": "sell", "status": "new"}]
        ap().sell_part(self.b, self.it, orders, self.cfg)
        self.assertIn(("cancel", "bot-stop"), self.b.calls)
        self.assertNotIn(("cancel", "u-tp"), self.b.calls)

    def test_a_stop_just_placed_is_not_placed_twice(self):
        self.it.update(asset="crypto", symbol="ETH/USD", data_key="ETHUSDT", time_stop="2026-10-27T00:00:00Z")
        fill = [{"id": "e1", "client_order_id": "ord-p1", "symbol": "ETH/USD", "side": "buy", "status": "filled",
                 "filled_qty": 10.0, "filled_avg_price": 100.0, "filled_at": "2026-10-20T14:02:00Z"}]
        pos = [{"symbol": "ETH/USD", "asset": "crypto", "qty": 10.0, "last": 101.0}]
        ap().reconcile(self.b, self.book, pos, fill, self.cfg, self.limits)
        ap().manage_exits(self.b, self.book, pos, fill, self.cfg)  # the same, older order list
        self.assertEqual(sum(1 for c in self.b.calls if c[0] == "stop"), 1)

    def test_a_broken_quote_never_sells(self):
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z", asset="crypto", symbol="ETH/USD",
                       data_key="ETHUSDT", time_stop="2026-10-27T00:00:00Z", stop_order_id="s1")
        stop = [{"id": "s1", "symbol": "ETH/USD", "side": "sell", "type": "stop_limit", "status": "new"}]
        for bad in (0.0, -1.0, float("nan")):
            pos = [{"symbol": "ETH/USD", "asset": "crypto", "qty": 10.0, "last": bad}]
            self.assertEqual(ap().manage_exits(self.b, self.book, pos, stop, self.cfg), [])
        self.assertEqual(self.b.calls, [])

    def test_a_stock_split_rescales_the_trade(self):
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z", entry_fill=100.0, swing=True,
                       time_stop="2027-01-01T00:00:00Z", stop_order_id="s1")
        stop = [{"id": "s1", "symbol": "NVDA", "side": "sell", "type": "stop", "status": "new"}]
        pos = [{"symbol": "NVDA", "asset": "stock", "qty": 20.0, "avg_entry": 50.0, "last": 50.5}]
        acts = ap().manage_exits(self.b, self.book, pos, stop, self.cfg)
        self.assertIn("2-for-1 split", acts[0])
        self.assertEqual((self.it["qty"], self.it["stop"], self.it["entry_fill"]), (20.0, 47.5, 50.0))
        self.assertFalse([c for c in self.b.calls if c[0] in ("exit", "close")])

    def test_an_intraday_stock_held_past_the_close_gets_a_stop(self):
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z")
        self.set_now("2026-10-20T21:30:00Z")  # 5:30 p.m. ET: the day bracket's legs expired at 4
        pos = [{"symbol": "NVDA", "asset": "stock", "qty": 10.0, "last": 101.0}]
        acts = ap().manage_exits(self.b, self.book, pos, [], self.cfg)
        self.assertIn("put back", acts[0])
        self.assertEqual(self.b.calls, [("stop", "NVDA", 10.0, 95.0)])


class KillUntilDone(OnlyWhatTheBotOwns):
    def test_a_kill_whose_sale_fails_stays_on_and_one_broken_item_does_not_stop_it(self):
        class Busy(Seller):
            def close_position(self, symbol):
                raise ap().BrokerError("insufficient qty available (held by orders)")
        b = Busy()
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z")
        self.book["items"]["bad"] = {"status": "open", "symbol": "AMD"}  # no asset, no qty: broken
        acts = ap().kill(b, self.book, self.cfg, "test", [], [{"symbol": "NVDA", "asset": "stock", "qty": 10.0}])
        self.assertTrue(any(a.startswith("kill incomplete") for a in acts), acts)
        self.assertIn("NVDA", " ".join(acts))


class RunOnceIsUsedUp(TraderTestCase):
    def test_a_blocked_cycle_still_uses_up_run_once(self):
        config.ensure_home()
        ap().write_control(by="test", run_once=True, paused=True)
        (self.home / "limits.json").write_text('{"global": ')  # broken: the cycle can't vouch for its limits
        ap().run_cycle("2026-10-20T15:00:00Z", approved=True)
        self.assertFalse(ap().read_control()["run_once"])


class OrdersSentBeforeACrash(TraderTestCase):
    def test_a_submitting_entry_is_found_or_dropped(self):
        config.ensure_home()
        b = FakeBroker()
        b.ords = [{"id": "e9", "client_order_id": "ord-p9", "symbol": "NVDA", "side": "buy", "status": "new"}]
        it = {"plan_id": "p9", "order_id": "ord-p9", "symbol": "NVDA", "asset": "stock", "status": "submitting",
              "placed_at": "2026-10-20T13:49:00Z", "qty": 1.0, "stop": 9.0, "target": 12.0,
              "time_stop": "2026-10-20T19:55:00Z", "broker": "alpaca", "mode": "paper", "data_key": "NVDA"}
        book = {"items": {"p9": it}, "handled": {}}
        ap().reconcile(b, book, [], b.ords, config.load_config(), config.load_limits())
        self.assertEqual((it["status"], it["broker_order_id"]), ("pending", "e9"))
        gone = dict(it, status="submitting", order_id="ord-p8", broker_order_id=None, placed_at="2026-10-20T13:00:00Z")
        book["items"]["p8"] = gone
        ap().reconcile(b, book, [], b.ords, config.load_config(), config.load_limits())
        self.assertEqual(gone["status"], "canceled")


class AiDeskFailsClosed(TraderTestCase):
    def test_an_unreadable_ai_review_is_a_no(self):
        a = ap()
        real = a._mod
        fake_ai = type("AI", (), {"review": staticmethod(lambda case, desk, cfg: {"status": "error",
                                                                                   "reason": "refusal"})})

        def mod(skill, module):
            return fake_ai if module == "ai_desk" else real(skill, module)
        a._mod = mod
        self.addCleanup(setattr, a, "_mod", real)
        block, gate, _ = a.ai_review({"id": "x"}, {}, {"ai_desk": {"on_unavailable": "rule_based"}})
        self.assertTrue(block)
        self.assertFalse(gate["ok"])


class StuckSources(TraderTestCase):
    def test_a_slow_news_refresh_does_not_hold_the_cycle(self):
        a = ap()
        real, budget = a._mod, a.NEWS_REFRESH_BUDGET_SEC
        slow = type("News", (), {"refresh_feed": staticmethod(lambda **kw: time.sleep(3))})
        a._mod = lambda skill, module: slow if module == "news" else real(skill, module)
        a.NEWS_REFRESH_BUDGET_SEC = 0.2
        self.addCleanup(setattr, a, "_mod", real)
        self.addCleanup(setattr, a, "NEWS_REFRESH_BUDGET_SEC", budget)
        t = time.monotonic()
        note = a.refresh_news({"symbol": "NVDA", "asset": "stock"}, config.load_config())
        self.assertLess(time.monotonic() - t, 2)
        self.assertIn("still fetching", note)

    def test_a_held_lock_times_out_and_says_who(self):
        import fcntl
        p = state.path(".locks", "autopilot__cycle.lock")
        fh = open(str(p), "a+")
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        fh.write("4242@elsewhere\n")
        fh.flush()
        try:
            with self.assertRaises(state.LockTimeout) as cm:
                with state.locked("autopilot/cycle", timeout=0.5):
                    pass
            self.assertIn("4242@elsewhere", str(cm.exception))
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            fh.close()

    def test_replay_refuses_a_zero_step(self):
        config.ensure_home()
        code, _, err = self.run_tool("trader-autopilot", "autopilot", ["replay", "--from", "2026-10-20T14:00:00Z",
                                                                       "--to", "2026-10-20T15:00:00Z", "--step", "0m"])
        self.assertEqual(code, 2)
        self.assertIn("--step", err)


class BrokenFileRestored(TraderTestCase):
    def test_the_good_copy_is_put_back(self):
        state.write_json("autopilot/scan.json", {"stock": {"bar": 1}})
        (self.home / "autopilot" / "scan.json").write_text("{")
        self.assertEqual(state.read_json("autopilot/scan.json"), {"stock": {"bar": 1}})
        self.assertTrue((self.home / "autopilot" / "scan.json.broken").exists())
        self.assertEqual(json.loads((self.home / "autopilot" / "scan.json").read_text()), {"stock": {"bar": 1}})
        state.recovered.clear()


class Healthcheck(TraderTestCase):
    def test_an_hour_of_failing_cycles_is_unhealthy(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("hc", str(load("app", "server").STATIC.parents[1] / "deploy" /
                                                                  "healthcheck.py"))
        hc = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hc)
        from datetime import datetime, timezone
        now = datetime(2026, 10, 20, 15, 0, tzinfo=timezone.utc)
        (self.home / "autopilot").mkdir(parents=True, exist_ok=True)
        hb = {"at": "2026-10-20T14:59:30Z", "status": "error", "interval_sec": 120, "last_ok_at": "2026-10-20T13:30:00Z"}
        (self.home / "autopilot" / "heartbeat.json").write_text(json.dumps(hb))
        ok, msg = hc.check(self.home, now)
        self.assertFalse(ok)
        self.assertIn("no successful cycle", msg)
        hb["last_ok_at"] = "2026-10-20T14:40:00Z"
        (self.home / "autopilot" / "heartbeat.json").write_text(json.dumps(hb))
        self.assertTrue(hc.check(self.home, now)[0])


class LoginThrottle(DashboardCase):
    def test_wrong_passwords_lock_out_that_client_only(self):
        self.start(password="pw-for-test-1")
        for _ in range(10):
            code, _, _ = self.req("POST", "/login", "password=wrong", {
                "Content-Type": "application/x-www-form-urlencoded", "Origin": "http://127.0.0.1:%d" % self.port,
                "X-Forwarded-For": "203.0.113.7"})
        self.assertEqual(code, 401)
        hdrs = {"Content-Type": "application/x-www-form-urlencoded", "Origin": "http://127.0.0.1:%d" % self.port}
        self.assertEqual(self.req("POST", "/login", "password=pw-for-test-1",
                                  dict(hdrs, **{"X-Forwarded-For": "203.0.113.7"}))[0], 429)
        self.assertEqual(self.req("POST", "/login", "password=pw-for-test-1",
                                  dict(hdrs, **{"X-Forwarded-For": "198.51.100.2"}))[0], 303)

    def test_a_made_up_forwarded_address_does_not_reset_the_count(self):
        # Caddy appends the real address: "<whatever the client sent>, <real address>"
        self.start(password="pw-for-test-1")
        hdrs = {"Content-Type": "application/x-www-form-urlencoded", "Origin": "http://127.0.0.1:%d" % self.port}
        for i in range(10):
            self.req("POST", "/login", "password=wrong", dict(hdrs, **{"X-Forwarded-For": "10.9.9.%d, 203.0.113.7" % i}))
        self.assertEqual(self.req("POST", "/login", "password=pw-for-test-1",
                                  dict(hdrs, **{"X-Forwarded-For": "10.1.1.1, 203.0.113.7"}))[0], 429)

    def test_guesses_from_many_addresses_meet_a_ceiling(self):
        self.start(password="pw-for-test-1")
        self.app.LOGIN_MAX_FAILS_ALL = 5  # 50 in real life; each wrong guess waits half a second
        hdrs = {"Content-Type": "application/x-www-form-urlencoded", "Origin": "http://127.0.0.1:%d" % self.port}
        for i in range(5):
            self.req("POST", "/login", "password=wrong", dict(hdrs, **{"X-Forwarded-For": "198.18.0.%d" % i}))
        self.assertEqual(self.req("POST", "/login", "password=pw-for-test-1",
                                  dict(hdrs, **{"X-Forwarded-For": "192.0.2.1"}))[0], 429)


class RightAsset(TraderTestCase):
    def test_wen_the_stock_is_not_a_meme_coin_but_wen_the_coin_is(self):
        book = {"items": {"x": {"status": "closed"}}, "handled": {}}  # the next check after the meme guard answers
        stock = {"id": "x", "sym": data.as_symbol("WEN", "stock"), "asset": "stock", "setup": "orb15"}
        d = ap().judge(stock, config.load_config(), config.load_limits(), FakeBroker(), book, True, {})
        self.assertFalse(any("meme" in r for r in d["reasons"]), d["reasons"])
        self.assertIn("already traded", d["reasons"][0])
        coin = {"id": "y", "sym": data.as_symbol("WEN", "crypto"), "asset": "crypto", "setup": "trend"}
        d = ap().judge(coin, config.load_config(), config.load_limits(), FakeBroker(), book, True, {})
        self.assertIn("meme coin", d["reasons"][0])

    def test_a_fourth_day_trade_under_25k_is_not_sent(self):
        from unittest import mock
        a = ap()
        plan = {"id": "p", "symbol": "WEN", "entry": {"price": 10.0}, "stop": {"price": 9.5},
                "target": {"price": 11.0}, "exit_rule": "x"}
        def stop_here(*a, **k):
            raise ValueError("stopped here by the test")
        desk = type("Desk", (), {"auto_review": staticmethod(lambda *a, **k: {"status": "GO", "objections": [],
                                                                              "gates": []}),
                                 "size_order": staticmethod(stop_here)})  # stands in for the sizer too
        stock = {"id": "z", "sym": data.as_symbol("WEN", "stock"), "asset": "stock", "setup": "orb15"}
        with mock.patch.object(a, "_write_entry"), mock.patch.object(a, "make_plan", return_value=plan), \
                mock.patch.object(a, "ensure_backtest"), mock.patch.object(a, "refresh_news", return_value="ok"), \
                mock.patch.object(a, "_mod", return_value=desk):
            book = {"items": {}, "handled": {}}
            d = a.judge(stock, config.load_config(), config.load_limits(), FakeBroker(), book, True,
                        {"equity": 5000, "daytrade_count": 3})
            self.assertIn("pattern day trader", d["reasons"][0])
            plan["swing"] = True  # held overnight it is no day trade
            d = a.judge(stock, config.load_config(), config.load_limits(), FakeBroker(), book, True,
                        {"equity": 5000, "daytrade_count": 3})
            self.assertEqual(d["reasons"], ["sizer: stopped here by the test"])
