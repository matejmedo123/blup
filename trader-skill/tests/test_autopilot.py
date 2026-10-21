"""Autopilot: takes only what clears every gate, journals real fills, pause / kill / caps, never meme, never live by accident."""
from __future__ import annotations

import json
import os

from tests.helpers import MEME_PASS, TraderTestCase, load
from shared import config, market_clock as mc, state
from shared.brokers.base import Broker


def ap():
    return load("trader-autopilot", "autopilot")


def decisions():
    return state.read_jsonl("autopilot/decisions.jsonl")


class Day(TraderTestCase):
    """The fixture day: NVDA's breakout is backed by its history, TSLA's and BTC's are not."""
    NOW = "2026-10-20T13:45:00Z"

    def setUp(self):
        super().setUp()
        config.ensure_home()
        # the v2 scenario: just the watchlists, crypto on its daily backtest (test_autopilot_v3 covers the rest)
        self.cfg(universe={"mode": "watchlist"}, playbook={"required_for_crypto": False})

    def cfg(self, **autopilot):
        doc = json.loads((self.home / "config.json").read_text()) if (self.home / "config.json").exists() else {}
        doc.setdefault("autopilot", {}).update(autopilot)
        (self.home / "config.json").write_text(json.dumps(doc))

    def cycle(self, at, approved=True):
        res = ap().run_cycle(at, approved=approved)
        self.assertNotEqual(res["status"], "error", res)
        return res

    def test_takes_nvda_skips_tsla_and_btc_and_exits_on_time(self):
        config.ensure_home()
        for at in ("2026-10-20T13:50:00Z", "2026-10-20T13:55:00Z", "2026-10-20T14:15:00Z", "2026-10-20T14:40:00Z",
                   "2026-10-20T19:55:00Z"):
            self.cycle(at)
        ds = {d["id"]: d for d in decisions()}
        nv = ds["NVDA-20261020-orb15"]
        self.assertEqual(nv["action"], "taken")
        self.assertEqual((nv["stop"], nv["target"], nv["qty"]), (190.9, 199.96, 32))
        self.assertEqual(nv["desk"]["status"], "GO")
        ts = ds["TSLA-20261020-orb15"]
        self.assertEqual(ts["action"], "skipped")
        self.assertTrue(any("lost money on TSLA" in r for r in ts["reasons"]))
        btc = ds["BTCUSDT-20261020-asia_range"]
        self.assertEqual(btc["action"], "skipped")
        trades = state.read_json("journal.json")["trades"]
        nvt = [t for t in trades if t["plan_id"] == "NVDA-20261020-orb15"][0]
        self.assertEqual((nvt["source"], nvt["broker"], nvt["status"]), ("autopilot", "simulator", "closed"))
        self.assertEqual(nvt["exit"]["reason"], "time")
        self.assertGreater(nvt["pnl_usd"], 0)
        appr = state.read_jsonl("approvals.jsonl")
        self.assertEqual(len(appr), 1)
        self.assertIn("standing approval", appr[0]["user_reply"])
        st = state.read_json("autopilot/state.json")
        self.assertEqual((st["status"], st["mode"], st["today"]["trades_opened"]), ("running", "simulator", 1))
        self.assertGreaterEqual(len(state.read_jsonl("broker/equity.jsonl")), 5)
        self.assertEqual(state.read_json("broker/positions.json"), [])
        self.assertTrue(all(d["asset"] != "meme" for d in decisions()))

    def test_dry_run_when_not_enabled(self):
        self.cycle("2026-10-20T13:50:00Z", approved=None)
        nv = [d for d in decisions() if d["id"] == "NVDA-20261020-orb15"][0]
        self.assertTrue(nv["dry_run"])
        self.assertIn("would have placed: BUY 32 NVDA", nv["reasons"][0])
        self.assertEqual(state.read_json("broker/sim.json")["orders"], [])
        self.assertTrue(state.read_json("autopilot/state.json")["dry_run"])

    def test_paused_takes_no_new_entries(self):
        ap().write_control(paused=True)
        res = self.cycle("2026-10-20T13:50:00Z")
        self.assertEqual(res["status"], "paused")
        self.assertEqual(decisions(), [])

    def test_kill_cancels_flattens_and_stays_killed_until_resume(self):
        self.cycle("2026-10-20T13:50:00Z")
        self.cycle("2026-10-20T13:55:00Z")
        held = state.read_json("broker/positions.json")
        self.assertEqual(len(held), 1)
        # the dashboard draws the position between its stop and target
        self.assertLess(held[0]["stop"], held[0]["avg_entry"])
        self.assertGreater(held[0]["target"], held[0]["avg_entry"])
        self.assertFalse(held[0]["rule_exit"])
        ap().write_control(kill=True)
        res = self.cycle("2026-10-20T14:30:00Z")
        self.assertEqual(res["status"], "killed")
        self.assertEqual(state.read_json("broker/positions.json"), [])
        t = [t for t in state.read_json("journal.json")["trades"] if t["source"] == "autopilot"][0]
        self.assertEqual((t["status"], t["exit"]["reason"]), ("closed", "manual"))
        self.assertIn("kill switch", t["notes"])
        self.assertEqual(self.cycle("2026-10-20T14:35:00Z")["status"], "killed")
        ap().write_control(paused=False)
        self.assertEqual(self.cycle("2026-10-20T14:40:00Z")["status"], "running")

    def test_daily_trade_cap(self):
        config.ensure_home()
        self.cfg(max_new_trades_per_day=0)
        self.cycle("2026-10-20T13:50:00Z")
        nv = [d for d in decisions() if d["id"] == "NVDA-20261020-orb15"][0]
        self.assertEqual(nv["action"], "skipped")
        self.assertIn("daily cap", nv["reasons"][0])

    def test_daily_loss_kills(self):
        config.ensure_home()
        self.write_state("journal.json", {"trades": [{"id": "trd-x", "status": "closed", "asset": "stock",
                                                      "pnl_usd": -800.0, "exit": {"time": "2026-10-20T13:40:00Z"}}]})
        res = self.cycle("2026-10-20T13:50:00Z")
        self.assertEqual(res["status"], "killed")
        self.assertIn("daily loss", res["message"])
        self.assertTrue(ap().read_control()["paused"])

    def test_daily_loss_is_measured_from_the_start_of_the_day(self):
        """A position held for days carries old unrealized P&L — only today's fall in equity counts."""
        config.ensure_home()
        self.write_state("autopilot/day.json", {"day": "2026-10-20", "start_equity": 25000.0, "last_equity": 25000.0})
        res = self.cycle("2026-10-20T13:50:00Z")
        self.assertNotEqual(res["status"], "killed")
        loss, start = ap()._day_loss("2026-10-20T15:00:00Z", 24100.0)   # fell $900 since midnight
        self.assertEqual((loss, start), (900.0, 25000.0))
        loss, start = ap()._day_loss("2026-10-21T00:05:00Z", 24050.0)   # a new day starts from yesterday's last
        self.assertEqual((loss, start), (50.0, 24100.0))
        self.write_state("autopilot/day.json", {"day": "2026-10-20", "start_equity": 25900.0, "last_equity": 25900.0})
        res = self.cycle("2026-10-20T14:00:00Z")          # equity ~$25,000: $900 below the day's start ≥ $750
        self.assertEqual(res["status"], "killed")
        self.assertIn("daily loss", res["message"])

    def test_a_back_off_beats_with_its_real_wait(self):
        hb = ap().heartbeat("daemon", "error", wait_sec=900)
        self.assertEqual(hb["interval_sec"], 900)   # the dashboard waits 3 × 15 min before calling it dead
        self.assertEqual(mc.ts(hb["next_cycle"]) - mc.ts(hb["at"]), 900)

    def test_meme_never_traded(self):
        config.ensure_home()
        doc = json.loads((self.home / "config.json").read_text())
        doc["autopilot"] = {"assets": ["stock", "crypto", "meme"], "universe": {"mode": "watchlist"},
                            "playbook": {"required_for_crypto": False}}
        doc["watchlists"] = {"stocks": [], "crypto": [], "meme": [MEME_PASS]}
        (self.home / "config.json").write_text(json.dumps(doc))
        self.cycle("2026-10-20T15:55:00Z")
        self.assertEqual(decisions(), [])
        self.assertNotIn("meme", ap().watchlist(config.load_config()))

    def test_live_refused_with_every_missing_item(self):
        config.ensure_home()
        self.cfg(broker="alpaca", mode="live")
        res = ap().run_cycle("2026-10-20T13:50:00Z", approved=True)
        self.assertEqual(res["status"], "error")
        for needle in ("paper must be false", "ALPACA_LIVE_KEY_ID", "I ACCEPT REAL MONEY RISK"):
            self.assertIn(needle, res["message"])
        self.assertEqual(decisions(), [])

    def test_paper_alpaca_without_keys(self):
        config.ensure_home()
        self.cfg(broker="alpaca")
        res = ap().run_cycle("2026-10-20T13:50:00Z", approved=True)
        self.assertEqual(res["status"], "error")
        self.assertIn("ALPACA_PAPER_KEY_ID", res["message"])

    def test_cli(self):
        code, out, _ = self.run_tool("trader-autopilot", "autopilot", ["--help"])
        self.assertEqual(code, 0)
        self.assertIn("standing approval", out)
        code, _, err = self.run_tool("trader-autopilot", "autopilot", ["kill"])
        self.assertEqual(code, 2)
        self.assertIn("--confirm KILL", err)
        code, out, _ = self.run_tool("trader-autopilot", "autopilot", ["check-live"])
        self.assertIn("OFF", out)
        code, out, _ = self.run_tool("trader-autopilot", "autopilot", ["pause"])
        self.assertTrue(ap().read_control()["paused"])
        code, out, _ = self.run_tool("trader-autopilot", "autopilot", ["status"])
        self.assertIn("AUTOPILOT", out)


class FakeBroker(Broker):
    name = "alpaca"
    mode = "paper"

    def __init__(self):
        self.pos, self.ords, self.calls = [], [], []

    def account(self):
        return {"equity": 25000, "cash": 25000, "buying_power": 25000}

    def positions(self):
        return list(self.pos)

    def orders(self, since=None):
        return list(self.ords)

    def place_stop(self, symbol, qty, stop_price, client_order_id=None, asset="crypto"):
        self.calls.append(("stop", symbol, qty, stop_price))
        o = {"id": "stop-1", "symbol": symbol, "side": "sell", "type": "stop_limit", "status": "new", "leg": "stop"}
        self.ords.append(o)
        return o

    def cancel(self, order_id):
        self.calls.append(("cancel", order_id))
        return {"id": order_id, "status": "canceled"}

    def close_position(self, symbol):
        self.calls.append(("close", symbol))
        return {"symbol": symbol, "status": "accepted"}


class CryptoOnAlpaca(TraderTestCase):
    NOW = "2026-10-20T14:45:00Z"

    def test_stop_after_fill_then_target_cancels_stop_and_sells(self):
        a = ap()
        plan = {"id": "BTCUSD-20261020-asia_range", "symbol": "BTC/USD", "symbol_display": "BTC/USD",
                "asset": "crypto", "setup": "asia_range", "entry": {"price": 67448.6, "time": "2026-10-20T14:40:00Z"},
                "stop": {"price": 67320.53}, "target": {"price": 67704.74}, "risk_per_unit": 128.07,
                "time_stop": {"at": "2026-10-20T18:40:00Z"}}
        self.write_state("plan.json", {"plans": {plan["id"]: plan}})
        self.write_state("orders.json", {"orders": [{"id": "ord-b", "plan_id": plan["id"], "qty": 0.05}]})
        book = {"items": {plan["id"]: {"plan_id": plan["id"], "order_id": "ord-b", "broker_order_id": "e1",
                                       "broker": "alpaca", "mode": "paper", "symbol": "BTC/USD", "data_key": "BTCUSD",
                                       "asset": "crypto", "qty": 0.05, "qty_unit": "coins", "stop": 67320.53,
                                       "target": 67704.74, "time_stop": "2026-10-20T18:40:00Z", "status": "pending",
                                       "placed_at": "2026-10-20T14:40:00Z"}}, "handled": {}}
        b = FakeBroker()
        b.ords = [{"id": "e1", "client_order_id": "ord-b", "symbol": "BTC/USD", "side": "buy", "status": "filled",
                   "filled_avg_price": 67450.0, "filled_qty": 0.05, "filled_at": "2026-10-20T14:41:00Z"}]
        cfg, limits = config.load_config(), config.load_limits()
        a.reconcile(b, book, [], b.ords, cfg, limits)
        it = book["items"][plan["id"]]
        self.assertEqual(it["status"], "open")
        self.assertEqual(b.calls[0], ("stop", "BTC/USD", 0.049875, 67320.53))  # Alpaca takes its fee in the coin
        self.assertEqual(it["stop_order_id"], "stop-1")
        b.pos = [{"symbol": "BTC/USD", "asset": "crypto", "qty": 0.05, "last": 67710.0}]
        acts = a.manage_exits(b, book, b.pos, b.ords)
        self.assertIn(("cancel", "stop-1"), b.calls)
        self.assertEqual(b.calls[-1], ("close", "BTC/USD"))
        self.assertEqual(it["exit_reason"], "target")
        self.assertTrue(acts)
        b.pos = []
        b.ords.append({"id": "x1", "symbol": "BTC/USD", "side": "sell", "status": "filled", "leg": "exit",
                       "filled_avg_price": 67705.0, "filled_at": "2026-10-20T14:50:00Z", "filled_qty": 0.05})
        a.reconcile(b, book, [], b.ords, cfg, limits)
        t = state.read_json("journal.json")["trades"][0]
        self.assertEqual((t["status"], t["exit"]["reason"], t["entry"]["price"]), ("closed", "target", 67450.0))
        self.assertGreater(t["pnl_usd"], 0)


class OnlyWhatTheBotOwns(TraderTestCase):
    """At a real broker you may hold the same symbol yourself: the bot sells, cancels and closes only its own."""
    NOW = "2026-10-20T15:00:00Z"   # 11 a.m. ET, the market is open

    def setUp(self):
        super().setUp()
        config.ensure_home()
        plan = {"id": "p1", "symbol": "NVDA", "symbol_display": "NVDA", "asset": "stock", "setup": "orb15",
                "entry": {"price": 100.0, "time": "2026-10-20T14:00:00Z"}, "stop": {"price": 95.0},
                "target": {"price": 110.0}, "risk_per_unit": 5.0, "time_stop": {"at": "2026-10-20T19:55:00Z"}}
        self.write_state("plan.json", {"plans": {"p1": plan}})
        self.write_state("orders.json", {"orders": [{"id": "ord-p1", "plan_id": "p1", "qty": 10}]})
        self.it = {"plan_id": "p1", "order_id": "ord-p1", "broker_order_id": "e1", "broker": "alpaca", "mode": "paper",
                   "symbol": "NVDA", "data_key": "NVDA", "asset": "stock", "qty": 10.0, "qty_unit": "shares",
                   "stop": 95.0, "target": 110.0, "time_stop": "2026-10-20T19:55:00Z", "status": "pending",
                   "placed_at": "2026-10-20T14:00:00Z"}
        self.book = {"items": {"p1": self.it}, "handled": {}}
        self.b = Seller()
        self.cfg, self.limits = config.load_config(), config.load_limits()

    def test_a_partly_filled_entry_is_a_trade_with_its_own_stop(self):
        self.b.ords = [{"id": "e1", "client_order_id": "ord-p1", "symbol": "NVDA", "side": "buy", "status": "canceled",
                        "filled_qty": 4.0, "filled_avg_price": 100.1, "filled_at": "2026-10-20T14:02:00Z"}]
        acts = ap().reconcile(self.b, self.book, [], self.b.ords, self.cfg, self.limits)
        self.assertEqual((self.it["status"], self.it["qty"]), ("open", 4.0))
        self.assertIn(("stop", "NVDA", 4.0, 95.0), self.b.calls)  # a cancelled bracket never activates its legs
        self.assertTrue(any("filled 4 NVDA" in a for a in acts), acts)

    def test_an_exit_sells_its_own_shares_not_yours(self):
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z", time_stop="2026-10-20T14:30:00Z")
        mine = {"id": "u1", "client_order_id": "my-own", "symbol": "NVDA", "side": "sell", "type": "limit",
                "status": "new"}
        leg = {"id": "t1", "client_order_id": "ord-p1-tp", "parent_id": "e1", "symbol": "NVDA", "side": "sell",
               "type": "limit", "status": "held", "leg": "target"}
        pos = [{"symbol": "NVDA", "asset": "stock", "qty": 25.0, "last": 101.0}]   # 15 of them are yours
        ap().manage_exits(self.b, self.book, pos, [mine, leg], self.cfg)
        self.assertEqual(self.it["exit_reason"], "time")
        self.assertIn(("cancel", "t1"), self.b.calls)
        self.assertNotIn(("cancel", "u1"), self.b.calls)
        self.assertEqual(self.b.calls[-1], ("exit", "NVDA", 10.0))
        self.assertNotIn(("close", "NVDA"), self.b.calls)

    def test_its_own_stop_filling_closes_the_trade_while_you_still_hold_the_symbol(self):
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z", entry_fill=100.0)
        self.write_state("orders.json", {"orders": [{"id": "ord-p1", "plan_id": "p1", "qty": 10}]})
        self.b.ords = [{"id": "e1", "client_order_id": "ord-p1", "symbol": "NVDA", "side": "buy", "status": "filled",
                        "filled_qty": 10.0, "filled_avg_price": 100.0, "filled_at": "2026-10-20T14:02:00Z"}]
        ap().reconcile(self.b, dict(self.book, items={"p1": dict(self.it, status="pending")}), [], self.b.ords,
                       self.cfg, self.limits)
        trade_id = state.read_json("journal.json")["trades"][0]["id"]
        self.it["trade_id"] = trade_id
        stop = {"id": "s1", "client_order_id": "ord-p1-sl", "parent_id": "e1", "symbol": "NVDA", "side": "sell",
                "type": "stop", "status": "filled", "leg": "stop", "filled_qty": 10.0, "filled_avg_price": 94.9,
                "filled_at": "2026-10-20T14:40:00Z"}
        pos = [{"symbol": "NVDA", "asset": "stock", "qty": 15.0, "last": 94.9}]   # yours stay
        ap().reconcile(self.b, self.book, pos, self.b.ords + [stop], self.cfg, self.limits)
        self.assertEqual((self.it["status"], self.it["exit_reason"]), ("closed", "stop"))

    def test_kill_touches_only_the_bots_orders_and_quantity(self):
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z")
        other = dict(self.it, plan_id="p2", order_id="ord-p2", broker_order_id="e2", symbol="AAPL", data_key="AAPL",
                     status="pending", placed_at="2026-10-20T14:55:00Z")
        self.book["items"]["p2"] = other
        mine = {"id": "u1", "client_order_id": "my-own", "symbol": "NVDA", "side": "sell", "status": "new"}
        leg = {"id": "s1", "parent_id": "e1", "symbol": "NVDA", "side": "sell", "status": "held", "leg": "stop"}
        pos = [{"symbol": "NVDA", "asset": "stock", "qty": 25.0, "last": 101.0}]
        acts = ap().kill(self.b, self.book, self.cfg, "test", [mine, leg], pos)
        self.assertIn(("cancel", "s1"), self.b.calls)
        self.assertIn(("cancel", "e2"), self.b.calls)
        self.assertNotIn(("cancel", "u1"), self.b.calls)
        self.assertIn(("exit", "NVDA", 10.0), self.b.calls)
        self.assertFalse([c for c in self.b.calls if c[0] in ("cancel_all", "close_all", "close")])
        self.assertTrue(other["cancel_asked_at"])
        self.assertNotIn("kill incomplete", " ".join(acts))

    def test_a_crypto_stop_limit_the_price_fell_through_is_closed_by_the_bot(self):
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z", symbol="ETH/USD", data_key="ETHUSDT",
                       asset="crypto", time_stop="2026-10-27T00:00:00Z", stop_order_id="s1")
        stop = {"id": "s1", "client_order_id": "ord-p1-stop", "symbol": "ETH/USD", "side": "sell",
                "type": "stop_limit", "status": "new", "leg": "stop"}
        pos = [{"symbol": "ETH/USD", "asset": "crypto", "qty": 10.0, "last": 94.8}]
        self.assertEqual(ap().manage_exits(self.b, self.book, pos, [stop], self.cfg), [])  # the stop-limit can fill
        pos[0]["last"] = 94.0   # below its 0.5 % limit room: it never will
        ap().manage_exits(self.b, self.book, pos, [stop], self.cfg)
        self.assertEqual(self.it["exit_reason"], "stop")
        self.assertEqual(self.b.calls[-2:], [("cancel", "s1"), ("close", "ETH/USD")])

    def test_the_daily_loss_kill_fires_once_a_day(self):
        self.assertFalse(ap()._killed_today("2026-10-20T15:00:00Z"))
        ap()._killed_today("2026-10-20T15:00:00Z", mark=True)
        self.assertTrue(ap()._killed_today("2026-10-20T18:00:00Z"))
        self.assertFalse(ap()._killed_today("2026-10-21T00:05:00Z"))


class ExitsAlwaysRun(OnlyWhatTheBotOwns):
    """A broken book item, a lost plan or a disk error must never stop another position's stop or time stop."""

    def test_a_fill_whose_plan_is_gone_still_becomes_a_trade(self):
        self.write_state("plan.json", {"plans": {}})   # a manual run overwrote plan.json
        self.it["entry_plan"] = 100.0
        self.b.ords = [{"id": "e1", "client_order_id": "ord-p1", "symbol": "NVDA", "side": "buy", "status": "filled",
                        "filled_qty": 10.0, "filled_avg_price": 100.2, "filled_at": "2026-10-20T14:02:00Z"}]
        ap().reconcile(self.b, self.book, [], self.b.ords, self.cfg, self.limits)
        self.assertEqual(self.it["status"], "open")
        t = state.read_json("journal.json")["trades"][0]
        self.assertEqual((t["stop"], t["entry"]["price"]), (95.0, 100.2))

    def test_one_broken_item_does_not_stop_the_others(self):
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z", time_stop="2026-10-20T14:30:00Z")
        self.book["items"] = {"bad": {"status": "open", "symbol": "AMD", "asset": "stock"}, "p1": self.it}
        pos = [{"symbol": "NVDA", "asset": "stock", "qty": 10.0, "last": 101.0},
               {"symbol": "AMD", "asset": "stock", "qty": 1.0, "last": 101.0}]
        acts = ap().manage_exits(self.b, self.book, pos, [], self.cfg)
        self.assertEqual(self.it["exit_reason"], "time")
        self.assertTrue(any(a.startswith("could not check the exits of AMD") for a in acts), acts)
        self.book["items"]["bad"]["status"] = "pending"   # and no placed_at
        acts = ap().reconcile(self.b, self.book, pos, [], self.cfg, self.limits)
        self.assertTrue(any(a.startswith("could not reconcile AMD") for a in acts), acts)
        self.assertIn("KeyError", self.book["items"]["bad"]["error"])

    def test_a_full_disk_stops_new_entries_not_the_time_stop(self):
        a = ap()
        broker = a.brokers.get(self.cfg)
        broker.book["positions"]["NVDA"] = {"symbol": "NVDA", "asset": "stock", "qty": 10.0, "avg_entry": 100.0,
                                            "last": 101.0, "opened_at": "2026-10-20T14:02:00Z"}
        broker._save()
        self.it.update(status="open", filled_at="2026-10-20T14:02:00Z", time_stop="2026-10-20T14:30:00Z",
                       broker="simulator", mode="simulator")
        self.write_state("autopilot/book.json", self.book)

        def full(*a, **k):
            raise OSError(28, "No space left on device")
        real = a._write_broker_files
        a._write_broker_files = full
        self.addCleanup(setattr, a, "_write_broker_files", real)
        res = a.run_cycle("2026-10-20T15:00:00Z", approved=True)
        self.assertTrue(any("time exit for NVDA" in x for x in res["actions"]), res)
        self.assertTrue(any("No space left" in e for e in res["errors"]), res)
        self.assertEqual(res.get("decisions"), [])


class Seller(FakeBroker):
    def place_exit(self, symbol, qty, kind="market", limit_price=None, client_order_id=None, asset="stock"):
        self.calls.append(("exit", symbol, qty))
        return {"id": "x-%d" % len(self.calls), "symbol": symbol, "side": "sell", "status": "new"}

    def place_stop(self, symbol, qty, stop_price, client_order_id=None, asset="crypto"):
        self.calls.append(("stop", symbol, qty, stop_price))
        return {"id": "stop-%d" % len(self.calls), "symbol": symbol, "side": "sell", "status": "new"}


class NoSecretsAnywhere(TraderTestCase):
    NOW = "2026-10-20T13:50:00Z"

    def test_secrets_never_written(self):
        os.environ["ALPACA_PAPER_KEY_ID"] = "PK-SENTINEL-123456"
        os.environ["ALPACA_PAPER_SECRET_KEY"] = "SECRET-SENTINEL-987654"
        config.ensure_home()
        doc = json.loads((self.home / "config.json").read_text())
        doc["autopilot"] = {"broker": "alpaca"}
        (self.home / "config.json").write_text(json.dumps(doc))
        res = ap().run_cycle("2026-10-20T13:50:00Z", approved=True)  # offline → Alpaca refuses, cleanly
        self.assertEqual(res["status"], "error")
        blob = json.dumps(res)
        for f in self.home.rglob("*"):
            if f.is_file():
                blob += f.read_text(encoding="utf-8", errors="ignore")
        self.assertNotIn("PK-SENTINEL-123456", blob)
        self.assertNotIn("SECRET-SENTINEL-987654", blob)
        self.assertIsNotNone(mc)
