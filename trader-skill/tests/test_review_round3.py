"""Review round 3 (24 Oct 2026): money accounting — each scenario as the review found it, held to the fixed
behaviour."""
from __future__ import annotations

from shared import config, state
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
