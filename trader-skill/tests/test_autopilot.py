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
        self.cfg(universe={"mode": "watchlist"})  # the v2 scenario: just the watchlists (test_autopilot_v3 covers auto)

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
        self.assertEqual(len(state.read_json("broker/positions.json")), 1)
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

    def test_meme_never_traded(self):
        config.ensure_home()
        doc = json.loads((self.home / "config.json").read_text())
        doc["autopilot"] = {"assets": ["stock", "crypto", "meme"], "universe": {"mode": "watchlist"}}
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
        self.assertEqual(b.calls[0], ("stop", "BTC/USD", 0.05, 67320.53))
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
