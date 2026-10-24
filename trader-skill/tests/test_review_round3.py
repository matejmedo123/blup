"""Review round 3 (24 Oct 2026): money accounting — each scenario as the review found it, held to the fixed
behaviour."""
from __future__ import annotations

from shared import config, market_clock, state
from shared.brokers.base import BrokerError
from tests.helpers import TraderTestCase, load


def ap():
    return load("trader-autopilot", "autopilot")


def trade(tid, pnl, qty, entry_t, exit_t, rpu=5.0, **kw):
    t = {"id": tid, "source": "autopilot", "status": "closed", "asset": "crypto", "setup": "trend_breakout",
         "symbol": "SOLUSDT", "qty": qty, "risk_per_unit": rpu, "pnl_usd": pnl, "r_multiple": pnl / (qty * rpu),
         "r_net": pnl / (qty * rpu), "fees_usd": 0.0, "slippage_usd": 0.0,
         "entry": {"time": entry_t, "price": 100.0}, "exit": {"time": exit_t, "price": 100.0 + pnl / qty}}
    t.update(kw)
    return t


class Accounting(TraderTestCase):
    NOW = "2026-10-21T00:20:00Z"

    def test_a_loss_held_over_midnight_is_not_counted_twice_by_the_daily_limit(self):
        config.ensure_home()
        a = ap()
        state.write_json("autopilot/day.json", {"day": "2026-10-20", "start_equity": 25000.0, "last_equity": 24300.0})
        # six stops filled after midnight for −$760 — $700 of it was already yesterday's fall in equity
        state.write_json("journal.json", {"trades": [
            trade("t%d" % k, -760 / 6.0, 1.0, "2026-10-19T00:05:00Z", "2026-10-21T00:15:00Z") for k in range(6)]})
        loss, start = a._day_loss("2026-10-21T00:20:00Z", 24240.0)
        self.assertAlmostEqual(loss, 60.0)
        # bought and sold today: all of its loss is today's, whatever else moved equity
        state.write_json("journal.json", {"trades": [trade("u", -500.0, 1.0, "2026-10-21T00:01:00Z",
                                                           "2026-10-21T00:10:00Z")]})
        loss, _ = a._day_loss("2026-10-21T00:21:00Z", 24300.0)  # equity flat (your coins rose meanwhile)
        self.assertAlmostEqual(loss, 500.0)

    def test_a_split_position_is_judged_as_one_trade(self):
        from shared import adapt, health, trades as tm
        config.ensure_home()
        # one 10-coin trade risking $50: the stop-limit sold 5 at 94.80, the rest went at 90 — −$80.82 in all
        a1 = trade("trd-A", -26.0, 5.0, "2026-10-20T10:00:00Z", "2026-10-20T12:00:00Z",
                   split={"root": "trd-A", "of_qty": 10.0})
        a2 = trade("trd-A-1", -54.82, 5.0, "2026-10-20T10:00:00Z", "2026-10-20T13:00:00Z",
                   split={"root": "trd-A", "of_qty": 10.0})
        # a runner: a third sold at +1R, two thirds stopped at the buy price
        r1 = trade("trd-R", 33.0, 3.3, "2026-10-20T10:00:00Z", "2026-10-20T14:00:00Z",
                   runner={"part": "sold", "of_qty": 10.0}, split={"root": "trd-R", "of_qty": 10.0})
        r2 = trade("trd-R-ride", 0.0, 6.7, "2026-10-20T10:00:00Z", "2026-10-20T18:00:00Z",
                   runner={"part": "ride", "from": "trd-R"}, split={"root": "trd-R", "of_qty": 10.0})
        state.write_json("journal.json", {"trades": [a1, a2, r1, r2]})
        whole = tm.merge([a1, a2, r1, r2])
        self.assertEqual(len(whole), 2)
        self.assertAlmostEqual(whole[0]["r_net"], -80.82 / 50.0, places=3)
        self.assertAlmostEqual(whole[1]["r_net"], 33.0 / 50.0, places=3)
        self.assertEqual([round(t["r"], 3) for t in health.live_trades()], [-1.616, 0.66])
        rows = adapt._closed_trades(10 ** 10)
        self.assertEqual(len(rows), 2)
        self.assertEqual(adapt._streak(rows[:1]), 1)  # one loss, not a streak of two
        stats = load("trader-journal", "journal").compute_stats([a1, a2, r1, r2])["overall"]
        self.assertEqual((stats["trades"], stats["wins"]), (2, 1))
        # still open: not judged until every piece is sold
        r2_open = dict(r2, status="open", pnl_usd=None)
        self.assertEqual([t["status"] for t in tm.merge([r1, r2_open])], ["open"])

    def test_forgotten_trades_leave_the_open_book_too(self):
        config.ensure_home()
        a = ap()
        journal = load("trader-journal", "journal")
        journal.save_trade({"id": "trd-s1", "status": "open", "asset": "crypto", "symbol": "BTCUSDT", "qty": 1.0,
                            "entry": {"price": 60000.0, "time": "2026-10-20T00:00:05Z"}, "risk_per_unit": 3000.0})
        state.write_json("autopilot/book.json", {"items": {"p1": {
            "plan_id": "p1", "order_id": "ord-p1", "trade_id": "trd-s1", "broker": "simulator", "mode": "simulator",
            "symbol": "BTC/USD", "asset": "crypto", "qty": 1.0, "status": "open"}}, "handled": {}})
        cfg = config.load_config()
        cfg["autopilot"]["broker"] = "bybit"
        cfg["autopilot"]["mode"] = "paper"
        a.forget_foreign(cfg)
        self.assertEqual(journal.get_trade("trd-s1")["status"], "left")
        self.assertEqual(load("trader-risk", "risk").open_book("2026-10-21T00:20:00Z"), [])

    def test_the_dashboard_shows_the_current_accounts_pnl(self):
        server = load("app", "server")
        config.ensure_home()
        for at, acct, eq in (("2026-10-19T12:00:00Z", "simulator/simulator/-", 25310.0),
                             ("2026-10-20T12:00:00Z", "alpaca/paper/A1", 100000.0),
                             ("2026-10-21T00:10:00Z", "alpaca/paper/A1", 99950.0)):
            state.append_jsonl("broker/equity.jsonl", {"at": at, "account": acct, "equity": eq, "cash": eq})
        view = server.account_view(config.load_config(), {"pnl_total": 0.0, "pnl_today_realized": 0.0}, [])
        self.assertEqual(view["pnl_today"], -50.0)
        self.assertEqual(view["pnl_total"], -50.0)  # not +$74,640 against the simulator's starting cash

    def test_the_sniper_counts_a_positions_loss_net_of_what_it_already_took_out(self):
        sn = load("trader-sniper", "sniper")
        config.ensure_home()
        s = sn.settings(config.load_config())
        s.update(daily_loss_usd=30, max_positions=20, max_open_usd=1000, max_trades_per_day=50, trade_usd=10)
        book = {"positions": {"solana:%d" % k: {"cost_usd": 10.0, "realized_usd": 7.5, "value_usd": 6.5}
                              for k in range(9)}, "days": {}, "traded": {}}
        now = 1792800000.0
        self.assertEqual(sn.budget_refusal(book, s, now, "solana:new"), "")  # +$36 in all: nothing lost today

    def test_the_simulator_keeps_a_sub_cent_coins_price(self):
        from shared.brokers import simulator
        self.assertEqual(simulator._px(0.00001234), 0.00001234)
        self.assertEqual(simulator._px(0.000010997), 0.000010997)
        self.assertEqual(simulator._px(67012.345678), 67012.346)


class Regressions(TraderTestCase):
    NOW = "2026-10-20T15:00:00Z"

    def setUp(self):
        super().setUp()
        config.ensure_home()
        self.cfg, self.limits = config.load_config(), config.load_limits()

    def test_a_part_sale_the_broker_never_got_is_tried_again_at_once(self):
        from tests.test_fatal_round2 import Fake, item
        b = Fake()
        it = item(stop_order_id=None, runner={"keep": 0.67, "status": "selling", "sell_order_id": None,
                                              "asked_at": "2026-10-20T14:54:00Z", "sell_qty": 0.33})
        book = {"items": {"p1": it}, "handled": {}}
        b.pos = [{"symbol": "BTC/USD", "asset": "crypto", "qty": 1.0, "last": 60.0}]
        acts = ap().reconcile(b, book, b.positions(), b.orders(), self.cfg, self.limits)
        self.assertEqual(it["runner"]["status"], "planned")  # not half an hour with neither a stop nor a sale
        self.assertIn("tried again", " ".join(acts))
        ap().manage_exits(b, book, b.positions(), b.orders(), self.cfg)
        self.assertEqual(b.pos, [])  # price through the stop: sold this same cycle

    def test_a_closed_trades_cleanup_never_touches_an_order_that_only_shares_its_id(self):
        from tests.test_fatal_round2 import Fake, item
        b = Fake()
        old = item(status="closed", stop_order_id="sim-000002", closed_at="2026-10-20T10:00:00Z")
        book = {"items": {"p1": old}, "handled": {}}
        # sim.json deleted: the simulator numbers from 1 again — the new ETH trade's stop has the old stop's id
        b.ords = [{"id": "sim-000002", "client_order_id": "ord-p9-stop", "symbol": "ETH/USD", "side": "sell",
                   "type": "stop_limit", "status": "new", "qty": 1.0, "stop_price": 2000.0, "filled_qty": 0}]
        ap().reconcile(b, book, b.positions(), b.orders(), self.cfg, self.limits)
        self.assertEqual(b.ords[0]["status"], "new")

    def test_the_kill_never_sells_a_trade_whose_stop_already_sold(self):
        from tests.test_fatal_round2 import Fake, item
        b = Fake()
        it = item()
        book = {"items": {"p1": it}, "handled": {}}
        b.ords = [{"id": "S1", "client_order_id": "ord-p1-stop", "symbol": "BTC/USD", "side": "sell",
                   "type": "stop_limit", "status": "filled", "qty": 1.0, "filled_qty": 1.0, "filled_avg_price": 99.8,
                   "filled_at": "2026-10-20T13:00:00Z"}]
        b.pos = [{"symbol": "BTC/USD", "asset": "crypto", "qty": 2.0, "last": 98.0}]  # yours
        ap().kill(b, book, self.cfg, "test", b.orders(), b.positions())
        self.assertEqual(b.pos[0]["qty"], 2.0)

    def test_a_degraded_bot_fails_the_health_check(self):
        import importlib.util
        import os
        a = ap()
        a._state(exit_fail_streak=a.EXIT_FAIL_ALERT_AFTER)
        hb = a.heartbeat("daemon", "running")
        self.assertEqual(hb["status"], "degraded")
        spec = importlib.util.spec_from_file_location("hc", os.path.join(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))), "deploy", "healthcheck.py"))
        hc = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hc)
        from datetime import datetime
        from pathlib import Path
        state.write_json("autopilot/heartbeat.json", dict(hb, last_ok_at="2026-10-20T13:00:00Z"))
        ok, why = hc.check(Path(str(self.home)), now=datetime.fromisoformat("2026-10-20T15:00:30+00:00"))
        self.assertFalse(ok, why)
        self.assertIn("no successful cycle", why)

    def test_bybit_items_saved_under_another_quotes_name_find_their_position(self):
        from tests.test_fatal_round2 import Fake, item
        b = Fake()
        b.name = "bybit"
        b.book_symbol = lambda raw, asset=None: str(raw).split("/")[0].replace("USDC", "") + "/USD"
        it = item(broker="bybit", symbol="BTC/USDC")
        book = {"items": {"p1": it}, "handled": {}}
        ap().reconcile(b, book, b.positions(), b.orders(), self.cfg, self.limits)
        self.assertEqual(it["symbol"], "BTC/USD")

    def test_the_sniper_reads_an_old_wallets_secrets_file_in_any_encoding(self):
        from shared import solana
        sn = load("trader-sniper", "sniper")
        secret, pub = solana.new_keypair()
        (self.home / "secrets.env").write_bytes(("# kľúče\n%s\nSNIPER_SOL_SECRET=%s\n" % (
            sn.WALLET_MARK, solana.b58encode(secret))).encode("cp1250"))
        import os
        os.chmod(str(self.home / "secrets.env"), 0o600)
        self.assertEqual(sn.wallet_problem(), "")


class AlpacaPath(TraderTestCase):
    NOW = "2026-10-20T15:00:00Z"

    def setUp(self):
        super().setUp()
        config.ensure_home()

    def alpaca(self):
        import os
        from shared.brokers.alpaca import AlpacaBroker
        os.environ.pop("TRADER_OFFLINE", None)
        os.environ["ALPACA_PAPER_KEY_ID"] = "PKTESTKEY0123456789"
        os.environ["ALPACA_PAPER_SECRET_KEY"] = "sEcReT-should-never-leak-42"
        return AlpacaBroker("paper", config.load_config())

    def test_the_day_trade_rule_counts_todays_open_same_day_trades(self):
        from unittest import mock
        from shared import data
        from tests.test_autopilot import FakeBroker
        a = ap()
        plan = {"id": "p", "symbol": "WEN", "entry": {"price": 10.0}, "stop": {"price": 9.5},
                "target": {"price": 11.0}, "exit_rule": "x"}

        def stop_here(*a, **k):
            raise ValueError("stopped here by the test")
        desk = type("Desk", (), {"auto_review": staticmethod(lambda *a, **k: {"status": "GO", "objections": [],
                                                                              "gates": []}),
                                 "size_order": staticmethod(stop_here)})
        stock = {"id": "z", "sym": data.as_symbol("WEN", "stock"), "asset": "stock", "setup": "orb15"}
        # three same-day trades bought this morning, each sold at 3:55 p.m.: Alpaca's count is still 0
        book = {"items": {"i%d" % k: {"plan_id": "i%d" % k, "asset": "stock", "broker": "alpaca", "status": "open",
                                      "swing": False, "placed_at": "2026-10-20T13:5%dZ" % k, "data_key": "S%d" % k,
                                      "symbol": "S%d" % k} for k in range(3)}, "handled": {}}
        cfg, limits = config.load_config(), config.load_limits()
        cfg["autopilot"]["max_new_trades_per_day"] = 10
        with mock.patch.object(a, "_write_entry"), mock.patch.object(a, "make_plan", return_value=plan), \
                mock.patch.object(a, "ensure_backtest"), mock.patch.object(a, "refresh_news", return_value="ok"), \
                mock.patch.object(a, "_mod", return_value=desk):
            d = a.judge(stock, cfg, limits, FakeBroker(), book, True, {"equity": 5000, "daytrade_count": 0})
            self.assertIn("pattern day trader", d["reasons"][0])
            for it in book["items"].values():
                it["swing"] = True  # held overnight: no day trades
            d = a.judge(stock, cfg, limits, FakeBroker(), book, True, {"equity": 5000, "daytrade_count": 0})
            self.assertEqual(d["reasons"], ["sizer: stopped here by the test"])

    def test_any_split_ratio_is_recognised(self):
        a = ap()
        it = {"asset": "stock", "symbol": "X", "qty": 100.0, "stop": 90.0, "target": 120.0, "entry_fill": 100.0,
              "broker_qty": 100.0, "broker_avg": 100.0}
        why = a._split_check(it, {"qty": 150.0, "avg_entry": 66.6667})  # 3-for-2
        self.assertIn("3-for-2 split", why)
        self.assertEqual(it["qty"], 150.0)
        self.assertAlmostEqual(it["stop"], 60.0)
        # 1-for-3 with the fraction paid out in cash: 10 shares become 3 (not 3.33)
        it = {"asset": "stock", "symbol": "Y", "qty": 10.0, "stop": 90.0, "target": None, "entry_fill": 100.0,
              "broker_qty": 10.0, "broker_avg": 100.0}
        self.assertIn("1-for-3 reverse split", a._split_check(it, {"qty": 3.0, "avg_entry": 299.0}))
        self.assertEqual(it["qty"], 3.0)
        self.assertAlmostEqual(it["stop"], 270.0)
        # your own purchase at a lower price moves the average too — but it adds to what the shares cost
        it = {"asset": "stock", "symbol": "Z", "qty": 100.0, "stop": 90.0, "broker_qty": 100.0, "broker_avg": 100.0}
        self.assertEqual(a._split_check(it, {"qty": 200.0, "avg_entry": 75.0}), "")
        self.assertEqual((it["qty"], it["stop"]), (100.0, 90.0))

    def test_a_wash_trade_fallback_prices_above_your_own_buy(self):
        from tests.test_fatal_round2 import Fake, item
        a = ap()
        b = Fake()
        mine = {"id": "U1", "client_order_id": "manual-1", "symbol": "BTC/USD", "side": "buy", "type": "limit",
                "status": "new", "limit_price": 95.0, "qty": 1.0}
        b.ords.append(mine)
        b.open_orders = lambda: [dict(o) for o in b.ords if o["status"] == "new"]
        real = b.place_stop
        sent = []

        def place_stop(symbol, qty, stop_price, client_order_id=None, asset="crypto", limit_price=None):
            sent.append(limit_price)
            if limit_price is None or float(limit_price) <= 95.0:  # Alpaca: a sell at or under your buy is refused
                raise BrokerError("potential wash trade detected. use complex orders")
            return real(symbol, qty, stop_price, client_order_id, asset, limit_price)
        b.place_stop = place_stop
        it = item(stop=97.0, stop_order_id=None)
        acts = a._restore_stop(b, it, 1.0, market_clock.now_utc(), config.load_config())
        self.assertIn("put back", acts[0])
        self.assertGreater(sent[-1], 95.0)
        self.assertLess(sent[-1], 97.0)
        # your buy at or above the stop: no stop-limit of the bot's can stay clear of it — said so, not sent
        mine["limit_price"] = 97.5
        it = item(stop=97.0, stop_order_id=None)
        acts = a._restore_stop(b, it, 1.0, market_clock.now_utc(), config.load_config())
        self.assertIn("no stop order", acts[0])
        self.assertIn("at or above the stop", it.get("stop_error") or acts[0])
        # a sale: just above your buy when 1 % under the price would meet it
        mine["limit_price"] = 99.5
        self.assertAlmostEqual(a._wash_limit(b, "BTC/USD", 100.0 * a.WASH_LIMIT, 100.0), 99.5 * a.WASH_OVER)
        mine["limit_price"] = 99.95
        self.assertIsNone(a._wash_limit(b, "BTC/USD", 100.0 * a.WASH_LIMIT, 100.0))

    def test_class_shares_carry_alpacas_dot(self):
        b = self.alpaca()
        self.assertEqual(b.book_symbol("BRK-B", "stock"), "BRK.B")
        self.assertEqual(b.book_symbol("TSLA", "stock"), "TSLA")
        self.assertEqual(b.book_symbol("BTCUSDT", "crypto"), "BTC/USD")
        from tests.test_fatal_round2 import Fake, item
        f = Fake()
        f.book_symbol = b.book_symbol
        it = item(asset="stock", symbol="BRK-B", data_key="BRK-B")
        ap().reconcile(f, {"items": {"p1": it}, "handled": {}}, [], [], config.load_config(), config.load_limits())
        self.assertEqual(it["symbol"], "BRK.B")

    def test_alpacas_smallest_crypto_order_is_known(self):
        b = self.alpaca()
        b._crypto = {"BTC/USD": {"min_order_size": 0.0001, "min_trade_increment": 1e-9, "price_increment": 1.0}}
        self.assertEqual(b.min_order("BTC/USD"), {"qty": 0.0001, "value": 0.0})
        self.assertEqual(b.min_order("NVDA"), {"qty": 0.0, "value": 0.0})

    def test_an_unanswered_lookup_is_not_no_sale(self):
        from shared.brokers.base import BrokerError as BE
        b = self.alpaca()

        def busy(path, retries=3):
            raise BE("Alpaca GET /v2/orders/X1 failed (HTTP 503): busy")
        b._get = busy
        self.assertEqual(b.lookup("X1"), [])
        with self.assertRaises(BE):
            b.lookup("X1", strict=True)
        b._get = lambda path, retries=3: (_ for _ in ()).throw(BE("Alpaca GET /v2/orders/X1 failed (HTTP 404): no"))
        self.assertEqual(b.lookup("X1", strict=True), [])
        b._get = busy
        q = ap()._queued_exit(b, {"exit_order_id": "X1"}, [])
        self.assertEqual(q["status"], "unknown")

    def test_a_tls_error_mid_reply_counts_as_a_lost_reply(self):
        import ssl
        from unittest import mock
        from shared.brokers import alpaca as alpaca_mod
        b = self.alpaca()

        class Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False
        opener = type("Opener", (), {"open": staticmethod(lambda req, timeout=0: Resp())})()
        with mock.patch.object(alpaca_mod, "_OPENER", opener), \
                mock.patch.object(alpaca_mod, "read_body", side_effect=ssl.SSLError("bad record mac")):
            with self.assertRaises(ConnectionError):
                b._send("POST", "/v2/orders", {"x": 1})


class DataAndSignals(TraderTestCase):
    NOW = "2026-10-20T00:10:00Z"

    def test_an_old_bar_is_judged_on_a_settled_ema(self):
        from unittest import mock
        from shared import data, indicators
        from shared.indicators import Candle
        a = ap()
        day = 86400
        last_t = market_clock.ts("2026-10-19T00:00:00Z")
        t0 = last_t - 599 * day
        closes = [100.0 + k for k in range(600)]  # a steady climb: the EMA lags it by ~24.5
        full = indicators.ema(closes, 50)
        closes[450] = full[450] + 1.0  # one dip that stays above the true 50-day EMA
        full = indicators.ema(closes, 50)
        self.assertGreater(closes[450], full[450])
        bars = [Candle(t0 + k * day, c, c + 1, c - 1, c, 1.0) for k, c in enumerate(closes)]

        def fake(key, interval, days=None, asset=None, **kw):
            return data.Series(data.as_symbol(key, "crypto"), interval, bars[-int(round(days)):], "test", [], {})
        it = {"exit_rule": {"type": "close_below_ema", "n": 50, "interval": "1d", "max_bars": 1000},
              "data_key": "ETHUSDT", "asset": "crypto", "filled_at": market_clock.iso(t0 + 421 * day),
              "placed_at": market_clock.iso(t0 + 421 * day)}
        with mock.patch.object(data, "get_candles", side_effect=fake):
            self.assertEqual(a.rule_exit_due(it), "")  # the lab never sold it there — neither does the bot

    def test_the_labs_bitcoin_regime_is_always_btcusdt(self):
        from shared import market_clock as mc
        from tests.test_lab import daily_uptrend
        lab = load("trader-backtest", "lab")
        now_ts = mc.ts(self.NOW)
        start = now_ts - 900 * 86400
        usdt = daily_uptrend(8, days=899, start=start)
        usdc = daily_uptrend(3, days=899, start=start)  # other closes: a different regime
        asked, seen = [], {}

        def history(sym, interval, days, now, asset="crypto"):
            asked.append(sym.key)
            return (usdt if sym.key == "BTCUSDT" else usdc), "test"

        class Seen(Exception):
            pass

        def study(st, interval, coins, now, args, exit_mod, cost, context, members, tradable):
            seen["btc_up"] = context["btc_up"]
            raise Seen()
        real_h, real_s = lab.history, lab.study_family
        lab.history, lab.study_family = history, study
        self.addCleanup(setattr, lab, "history", real_h)
        self.addCleanup(setattr, lab, "study_family", real_s)
        cfg = config.load_config()
        cfg["quote_currency"] = "USDC"
        args = lab.build_parser().parse_args(["--symbols", "BTCUSDC,ETHUSDC", "--timeframes", "1d", "--setups",
                                              "trend_breakout", "--no-html", "--workers", "1"])
        ctx = type("Ctx", (), {"cfg": cfg, "now": mc.parse_iso(self.NOW)})()
        with self.assertRaises(Seen):
            lab.run(args, ctx)
        self.assertIn("BTCUSDT", asked)
        self.assertEqual(seen["btc_up"], setups_regime(usdt))

    def test_the_etf_gate_reads_the_bitcoin_day_the_bot_buys_on(self):
        from shared import market_clock as mc
        from shared.indicators import Candle
        lab = load("trader-backtest", "lab")
        sunday = mc.ts("2026-10-18T00:00:00Z")
        btc = []
        for k in range(300):
            t = sunday - (299 - k) * 86400
            c = 50.0 if t == sunday else (120.0 if t >= sunday - 3 * 86400 else 100.0)  # Thu–Sat bull, Sun bear
            btc.append(Candle(t, c, c, c, c, 1.0))
        real = lab.history
        lab.history = lambda sym, interval, days, now_ts, asset="crypto": (btc, "test")
        self.addCleanup(setattr, lab, "history", real)
        args = lab.build_parser().parse_args(["--etf", "--no-html"])
        gate = lab.etf_context(args, config.load_config(), mc.ts("2026-10-20T00:00:00Z"), [])
        friday_bar = mc.ts("2026-10-16T13:30:00Z")  # Yahoo stamps a daily bar at the 9:30 ET open
        # bought Monday 9:45 ET: the newest Bitcoin bar closed then is Sunday's — a bear market
        self.assertTrue(gate["entry_ok"](friday_bar + 86400))
        thursday_bar = mc.ts("2026-10-15T13:30:00Z")  # bought Friday: Thursday's Bitcoin bar — a bull market
        self.assertFalse(gate["entry_ok"](thursday_bar + 86400))

    def test_kraken_never_stands_in_with_terra_classic(self):
        from shared import symbols
        self.assertEqual(symbols.parse("LUNAUSDC", asset="crypto").kraken, "LUNA2USD")
        self.assertEqual(symbols.parse("LUNCUSDT", asset="crypto").kraken, "LUNAUSDT")
        self.assertEqual(symbols.parse("BTCUSDC", asset="crypto").kraken, "XBTUSD")


def setups_regime(candles):
    from shared import setups
    return setups.regime_map(candles)


class ShadowEtfGate(TraderTestCase):
    NOW = "2026-10-19T15:00:00Z"  # Monday, after the bot's 9:45 ET turn

    def test_a_friday_signal_is_judged_on_sundays_bitcoin(self):
        from shared import data, market_clock as mc, setups, shadow
        from shared.indicators import Candle
        from tests.test_etf import series
        config.ensure_home()
        cfg = config.load_config()
        cfg["autopilot"]["etf_trend"].update(enabled=True, when="crypto_bear", symbols=["GLD"])
        bars = series(700, 0.0012, seed=4)
        i = setups.series_signals("etf_trend", bars, "1d")[-1]["trigger"]["index"]
        friday = mc.ts("2026-10-16T13:30:00Z")
        bars = [Candle(friday - (i - k) * 86400, c.o, c.h, c.l, c.c, c.v) for k, c in enumerate(bars[:i + 1])]
        sunday = mc.ts("2026-10-18T00:00:00Z")
        btc = []
        for k in range(300):
            t = sunday - (299 - k) * 86400
            c = 50.0 if t == sunday else (120.0 if t >= sunday - 2 * 86400 else 100.0)  # Fri + Sat bull, Sun bear
            btc.append(Candle(t, c, c, c, c, 1.0))
        real = data.get_candles

        def fake(symbol, interval="5m", days=None, asset=None, end=None, quote=None):
            sym = data.as_symbol(symbol, asset)
            if sym.key in ("GLD", "BTCUSDT"):
                return data.Series(sym, interval, bars if sym.key == "GLD" else btc, "test", [], {})
            return real(symbol, interval, days=days, asset=asset, end=end, quote=quote)
        data.get_candles = fake
        self.addCleanup(setattr, data, "get_candles", real)
        self.write_state("backtests/playbook-etf.json", {"generated_at": "2026-09-01T00:00:00Z", "entries": {
            "GLD:etf_trend@1d": {"symbol": "GLD", "setup": "etf_trend", "interval": "1d"}}})
        row = [r for r in shadow.run(cfg)["rows"] if r["signal_at"].startswith("2026-10-17")][0]
        # the bot bought on Monday reading Sunday's bar — a bear market — so the trade was due
        self.assertNotIn("bull market", row.get("reason") or "")
        self.assertEqual(row["outcome"], "missed")
