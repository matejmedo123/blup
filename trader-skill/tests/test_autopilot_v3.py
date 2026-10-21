"""Autopilot v3: 24/7 daemon, heartbeat, self-picked universe, per-bar scan, news gate, learning, AI veto, notifications."""
from __future__ import annotations

import json
import os
import socket
import time
import types

from tests.helpers import TraderTestCase, load
from shared import config, market_clock as mc, state


def ap():
    return load("trader-autopilot", "autopilot")


def decisions():
    return state.read_jsonl("autopilot/decisions.jsonl")


def decision(did):
    found = [d for d in decisions() if d["id"] == did]
    return found[-1] if found else None


def trade(n, r, setup="vwap_reclaim", symbol="AMD", days_ago=1, at="2026-10-19T15:00:00Z"):
    t = mc.iso(mc.ts(at) - days_ago * 86400 + n * 60)
    return {"id": "trd-%s-%d" % (setup, n), "status": "closed", "source": "autopilot", "asset": "stock",
            "setup": setup, "symbol": symbol, "display": symbol, "r_multiple": r, "r_net": r,
            "pnl_usd": round(r * 100, 2), "entry": {"time": t, "price": 10.0}, "exit": {"time": t, "price": 10.0}}


class V3(TraderTestCase):
    NOW = "2026-10-20T13:45:00Z"
    NVDA = "NVDA-20261020-orb15"

    def setUp(self):
        super().setUp()
        config.ensure_home()
        self.cfg(universe={"mode": "watchlist"}, playbook={"required_for_crypto": False})

    def cfg(self, top=None, **autopilot):
        doc = json.loads((self.home / "config.json").read_text())
        doc.setdefault("autopilot", {}).update(autopilot)
        doc.update(top or {})
        (self.home / "config.json").write_text(json.dumps(doc))

    def cycle(self, at, approved=True, runner="cli"):
        res = ap().run_cycle(at, approved=approved, runner=runner)
        self.assertNotEqual(res["status"], "error", res)
        return res

    # --- heartbeat, sessions, scan per bar ---------------------------------------------------------

    def test_heartbeat_and_sessions(self):
        self.cycle("2026-10-20T13:50:00Z", runner="daemon")
        hb = state.read_json("autopilot/heartbeat.json")
        self.assertEqual((hb["runner"], hb["status"], hb["pid"]), ("daemon", "running", os.getpid()))
        self.assertEqual(hb["sessions"], {"crypto": "open 24/7", "stock": "open"})
        self.assertEqual(hb["at"], "2026-10-20T13:50:00Z")
        self.assertEqual(hb["universe"], {"stock": 5, "crypto": 3})
        self.assertEqual(hb["scan"], {"crypto": "3/3", "stock": "5/5"})
        self.cycle("2026-10-24T13:50:00Z")  # a Saturday: crypto keeps going, stocks rest
        hb = state.read_json("autopilot/heartbeat.json")
        self.assertEqual(hb["sessions"]["stock"], "weekend")
        self.assertIn("US market closed", " ".join(state.read_json("autopilot/state.json")["notes"]))

    def test_each_symbol_is_scanned_once_per_bar(self):
        calls = []
        data = ap().data
        real = data.get_candles

        def counting(sym, *a, **kw):
            calls.append(getattr(sym, "key", sym))
            return real(sym, *a, **kw)
        data.get_candles = counting
        try:  # dry run, so the simulator's own price lookups for an open order don't count
            self.cycle("2026-10-20T13:50:00Z", approved=None)
            first = len(calls)
            self.cycle("2026-10-20T13:51:00Z", approved=None)   # same closed bar → nothing new to look at
            self.assertEqual(len(calls), first)
            self.cycle("2026-10-20T13:55:00Z", approved=None)   # next bar → everything again
            self.assertGreater(len(calls), first)
        finally:
            data.get_candles = real
        self.assertEqual(state.read_json("autopilot/scan.json")["stock"]["bar"], mc.ts("2026-10-20T13:50:00Z"))

    def test_scan_budget_rolls_over_to_the_next_cycle(self):
        self.cfg(scan_time_budget_sec=-1)
        self.cycle("2026-10-20T13:50:00Z")
        self.assertIsNone(decision(self.NVDA))
        self.assertIn("scan time budget reached", " ".join(state.read_json("autopilot/state.json")["notes"]))
        self.cfg(scan_time_budget_sec=40)
        self.cycle("2026-10-20T13:51:00Z")     # same bar: picks up where it left off
        self.assertEqual(decision(self.NVDA)["action"], "taken")

    # --- universe ----------------------------------------------------------------------------------

    def test_auto_universe_watches_more_than_the_watchlist(self):
        self.cfg(universe={"mode": "auto", "stocks": {"top_n": 10}, "crypto": {"top_n": 6, "min_volume_usd": 0}})
        self.cycle("2026-10-20T13:50:00Z")
        uni = state.read_json("autopilot/universe.json")
        self.assertEqual(uni["mode"], "auto")
        st = state.read_json("autopilot/state.json")
        self.assertGreater(st["universe"]["stock"], 5)
        for sym in ("NVDA", "TSLA"):
            self.assertIn(sym, uni["stock"]["symbols"])
        self.assertIn("BTCUSDT", uni["crypto"]["symbols"])
        self.assertNotIn("USDCUSDT", uni["crypto"]["symbols"])
        self.assertTrue(all("meme" not in k for k in uni))
        self.assertEqual(decision(self.NVDA)["action"], "taken")

    def test_universe_cli(self):
        code, out, _ = self.run_tool("trader-autopilot", "autopilot", ["universe", "--refresh"])
        self.assertEqual(code, 0, out)
        self.assertIn("UNIVERSE", out)
        self.assertIn("NVDA", out)

    # --- learning from its own record ---------------------------------------------------------------

    def test_losing_setup_is_paused(self):
        self.write_state("journal.json", {"trades": [trade(i, -0.6, setup="orb15", symbol="AMD") for i in range(9)]})
        self.cycle("2026-10-20T13:50:00Z")
        d = decision(self.NVDA)
        self.assertEqual(d["action"], "skipped")
        self.assertIn("learned from its record", d["reasons"][0])
        learned = state.read_json("autopilot/adapt.json")
        self.assertEqual(learned["setups"]["stock:orb15"]["status"], "paused")
        self.assertTrue(any(n["event"] == "learned" for n in state.read_jsonl("notifications.jsonl")))

    def test_losing_streak_halves_the_size(self):
        trades = [trade(1, 1.2, "bull_flag", "AMD", days_ago=3)] + \
                 [trade(i, -1.0, "vwap_reclaim", sym, days_ago=2) for i, sym in ((2, "AMD"), (3, "META"), (4, "AAPL"))]
        self.write_state("journal.json", {"trades": trades})
        self.cycle("2026-10-20T13:50:00Z")
        d = decision(self.NVDA)
        self.assertEqual(d["action"], "taken")
        self.assertLess(d["qty"], 32)
        g = [g for g in d["gates"] if g["name"] == "learned · risk multiplier"]
        self.assertEqual(len(g), 1)
        self.assertIn("× 0.5", g[0]["detail"])

    def test_drawdown_pauses_and_resume_resets_the_peak(self):
        self.cycle("2026-10-20T13:40:00Z")
        state.append_jsonl("broker/equity.jsonl", {"at": "2026-10-20T13:41:00Z", "equity": 30000.0, "cash": 30000.0,
                                                   "unrealized": 0, "realized_today": 0, "mode": "simulator"})
        res = self.cycle("2026-10-20T13:50:00Z")
        self.assertEqual(res["status"], "paused")
        self.assertTrue(ap().read_control()["paused"])
        self.assertTrue(any("drawdown" in a for a in res["actions"]))
        self.assertTrue(any(n["event"] == "paused" and n["priority"] == "high"
                            for n in state.read_jsonl("notifications.jsonl")))
        self.assertIsNone(decision(self.NVDA))
        code, out, _ = self.run_tool("trader-autopilot", "autopilot", ["resume", "--now", "2026-10-20T13:51:00Z"])
        self.assertEqual(code, 0, out)
        self.assertTrue(ap().read_control()["dd_reset_at"])
        self.assertEqual(self.cycle("2026-10-20T13:52:00Z")["status"], "running")
        self.assertEqual(decision(self.NVDA)["action"], "taken")

    # --- news & filings gate -------------------------------------------------------------------------

    def test_fresh_dilution_filing_blocks_the_trade(self):
        item = {"id": "f-nvda-1", "symbol": "NVDA", "asset": "stock", "source": "SEC EDGAR", "kind": "filing",
                "title": "8-K filed: unregistered sale of equity (possible dilution)", "url": "https://www.sec.gov/x",
                "published": "2026-10-20T12:30:00Z", "tags": ["8-K", "dilution"], "why": "official filing",
                "importance": 3, "credibility": 5, "author": None, "sentiment": None, "metrics": {}}
        self.write_state("news_feed.json", {"updated_at": "2026-10-20T13:49:00Z", "items": [item],
                                            "refreshed": {"stock:NVDA": "2026-10-20T13:49:00Z"}})
        self.cycle("2026-10-20T13:50:00Z")
        d = decision(self.NVDA)
        self.assertEqual(d["action"], "skipped")
        self.assertTrue(any("dilution" in r for r in d["reasons"]), d["reasons"])
        self.assertTrue(any(g["name"] == "news refresh" and "fetched 1 min ago" in g["detail"] for g in d["gates"]))

    def test_news_is_refreshed_just_in_time(self):
        self.cycle("2026-10-20T13:50:00Z")
        feed = state.read_json("news_feed.json")
        self.assertIn("stock:NVDA", feed["refreshed"])
        d = decision(self.NVDA)
        self.assertTrue(any(g["name"] == "news refresh" and g["detail"].startswith("news refreshed") for g in d["gates"]))

    # --- optional AI desk: veto only ----------------------------------------------------------------

    def _fake_ai(self, status, reason=None):
        calls = []

        def review(case, rule_result, cfg, client=None):
            calls.append((case.get("id"), rule_result.get("status")))
            return {"status": status, "model": "claude-opus-5-5", "reason": reason,
                    "objections": [{"n": 1, "severity": "major", "text": "8-K this morning changes the picture"}]
                    if status == "NO-GO" else [], "decision_text": "DECISION: %s" % status,
                    "usage": {"calls": 2, "usd": 0.04}}
        mod = types.SimpleNamespace(review=review, available=lambda cfg: (True, ""))
        ap()._MODS["trader-desk/ai_desk"] = mod
        self.addCleanup(ap()._MODS.pop, "trader-desk/ai_desk", None)
        self.cfg(top={"ai_desk": {"enabled": True}})
        return calls

    def test_ai_desk_can_veto(self):
        calls = self._fake_ai("NO-GO")
        self.cycle("2026-10-20T13:50:00Z")
        d = decision(self.NVDA)
        self.assertEqual(d["action"], "skipped")
        self.assertIn("AI desk NO-GO: 8-K this morning", d["reasons"][0])
        self.assertEqual(d["ai"]["status"], "NO-GO")
        self.assertEqual(calls, [(self.NVDA, "GO")])  # only trades the rule-based desk already passed
        self.assertEqual(state.read_json("broker/sim.json")["orders"], [])

    def test_ai_desk_go_and_unavailable(self):
        self._fake_ai("GO")
        self.cycle("2026-10-20T13:50:00Z")
        d = decision(self.NVDA)
        self.assertEqual(d["action"], "taken")
        self.assertTrue(any(g["name"] == "AI desk" and g["ok"] for g in d["gates"]))

    def test_ai_unavailable_follows_on_unavailable(self):
        self._fake_ai("unavailable", reason="daily AI budget reached")
        self.cfg(top={"ai_desk": {"enabled": True, "on_unavailable": "skip"}})
        self.cycle("2026-10-20T13:50:00Z")
        d = decision(self.NVDA)
        self.assertEqual(d["action"], "skipped")
        self.assertIn("daily AI budget reached", d["reasons"][0])

    def test_ai_not_consulted_in_dry_run_or_for_no_go(self):
        calls = self._fake_ai("GO")
        self.cycle("2026-10-20T13:50:00Z", approved=None)
        self.assertEqual(calls, [])

    # --- notifications -----------------------------------------------------------------------------

    def test_trade_notifications_are_logged_not_sent_offline(self):
        self.cfg(top={"notify": {"enabled": True, "ntfy_topic": "trader-test-topic-1234567890"}})
        for at in ("2026-10-20T13:50:00Z", "2026-10-20T13:55:00Z", "2026-10-20T19:55:00Z", "2026-10-20T20:15:00Z"):
            self.cycle(at)
        log = state.read_jsonl("notifications.jsonl")
        events = [n["event"] for n in log]
        for ev in ("trade_opened", "trade_closed", "daily_summary"):
            self.assertIn(ev, events)
        self.assertTrue(all("not sent" in json.dumps(n["channels"]) for n in log))
        summary = [n for n in log if n["event"] == "daily_summary"]
        self.assertEqual(len(summary), 1)
        self.assertIn("1 trade(s) closed", summary[0]["text"])

    # --- the daemon --------------------------------------------------------------------------------

    def test_daemon_runs_locks_and_stops_cleanly(self):
        code, out, err = self.run_tool("trader-autopilot", "autopilot", ["daemon", "--approve", "--max-cycles", "1"])
        self.assertEqual(code, 0, out + err)
        hb = state.read_json("autopilot/heartbeat.json")
        self.assertEqual((hb["runner"], hb["status"]), ("daemon", "stopped"))
        self.assertFalse((self.home / "autopilot" / "daemon.lock").exists())
        events = [n["event"] for n in state.read_jsonl("notifications.jsonl")]
        self.assertEqual((events[0], events[-1]), ("started", "stopped"))

    def test_daemon_refuses_a_second_instance_and_takes_over_a_stale_lock(self):
        now = mc.iso(time.time())  # locks are about real processes, so they use the wall clock
        self.write_state("autopilot/daemon.lock", {"pid": os.getppid(), "host": socket.gethostname(), "started_at": now})
        code, out, err = self.run_tool("trader-autopilot", "autopilot", ["daemon", "--max-cycles", "1"])
        self.assertEqual(code, 2)
        self.assertIn("already running", err)
        self.write_state("autopilot/daemon.lock", {"pid": 99999999, "host": socket.gethostname(), "started_at": now})
        code, out, err = self.run_tool("trader-autopilot", "autopilot", ["daemon", "--max-cycles", "1"])
        self.assertEqual(code, 0, out + err)

    def test_cli_hands_run_and_kill_to_a_running_daemon(self):
        self.write_state("autopilot/daemon.lock", {"pid": os.getppid(), "host": socket.gethostname(),
                                                   "started_at": mc.iso(time.time())})
        code, out, _ = self.run_tool("trader-autopilot", "autopilot", ["run", "--approve"])
        self.assertEqual(code, 0)
        self.assertIn("asked it to run a cycle now", out)
        self.assertTrue(ap().read_control()["run_once"])
        self.assertFalse((self.home / "autopilot" / "state.json").exists())  # no second cycle ran
        code, out, _ = self.run_tool("trader-autopilot", "autopilot", ["kill", "--confirm", "KILL"])
        self.assertEqual(code, 0)
        self.assertIn("KILL sent to the running daemon", out)
        self.assertTrue(ap().read_control()["kill"])
        code, _, err = self.run_tool("trader-autopilot", "autopilot", ["loop", "--max-cycles", "1"])
        self.assertEqual(code, 2)
        self.assertIn("already trading", err)

    def test_daemon_needs_the_real_clock(self):
        code, out, err = self.run_tool("trader-autopilot", "autopilot", ["daemon"])
        self.assertEqual(code, 2)
        self.assertIn("real clock", err)

    # --- housekeeping and CLI ----------------------------------------------------------------------

    def test_equity_log_is_compacted(self):
        rows = [{"at": mc.iso(mc.ts("2026-10-01T00:00:00Z") + i * 60), "equity": 25000 + i} for i in range(180)]
        rows += [{"at": "2026-10-20T13:00:00Z", "equity": 25100}]
        for r in rows:
            state.append_jsonl("broker/equity.jsonl", r)
        removed = ap().compact_equity()
        kept = state.read_jsonl("broker/equity.jsonl")
        self.assertEqual(removed, 177)
        self.assertEqual([r["at"] for r in kept], ["2026-10-01T00:59:00Z", "2026-10-01T01:59:00Z",
                                                   "2026-10-01T02:59:00Z", "2026-10-20T13:00:00Z"])

    def test_status_learned_and_notify_test_cli(self):
        self.cycle("2026-10-20T13:50:00Z", runner="daemon")
        code, out, _ = self.run_tool("trader-autopilot", "autopilot", ["status", "--now", "2026-10-20T13:51:00Z"])
        self.assertEqual(code, 0)
        self.assertIn("Heartbeat: ALIVE", out)
        self.assertIn("Sessions: crypto open 24/7 · US stocks open", out)
        code, out, _ = self.run_tool("trader-autopilot", "autopilot", ["learned"])
        self.assertEqual(code, 0)
        self.assertIn("LEARNED", out)
        code, out, _ = self.run_tool("trader-autopilot", "autopilot", ["notify-test"])
        self.assertEqual(code, 0)
        self.assertIn("notify.enabled is false", out)
