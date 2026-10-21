"""Months of running: a download cache that only grows, files read whole every minute, a simulator that re-walks
every bar since the entry, a full disk — the bot must stay small, fast and keep doing its exits."""
from __future__ import annotations

import gzip
import json
import os
import subprocess
import sys
import time
import unittest
import urllib.error
from unittest import mock

from tests.helpers import ROOT, TraderTestCase, load
from tests.test_app import DashboardCase
from shared import config, http, market_clock as mc, state
from shared.brokers.simulator import SimBroker
from shared.cache import FileCache
from shared.indicators import Candle
from shared.sources import binance


def ap():
    return load("trader-autopilot", "autopilot")


class DownloadCache(TraderTestCase):
    def test_a_kline_url_stays_the_same_for_a_whole_bar(self):
        seen = []

        def fake(path, ttl=30):
            seen.append(path)
            return [[1761000000000, "1", "1", "1", "1", "1"]]
        t = 1761000000 // 300 * 300
        with mock.patch.object(binance, "_get", fake):
            for end in (t + 10, t + 290, t + 300):
                binance.klines("BTCUSDT", "5m", days=2, end_ts=end)
        self.assertEqual(seen[0], seen[1])
        self.assertNotEqual(seen[1], seen[2])
        self.assertIn("endTime=%d" % (t * 1000), seen[0])

    def test_old_entries_and_broken_temp_files_are_deleted(self):
        cache = FileCache(self.tmp / "c")
        cache.set("https://api.binance.com/a", "old")
        cache.set("https://api.binance.com/b", "new")
        old = cache._file("https://api.binance.com/a")
        os.utime(str(old), (time.time() - 2 * 86400,) * 2)
        tmp = old.with_name("x.json.1.2.tmp")
        tmp.write_text("half")
        os.utime(str(tmp), (time.time() - 7200,) * 2)
        res = cache.prune(86400)
        self.assertEqual(res["files"], 2)
        self.assertFalse(old.exists())
        self.assertFalse(tmp.exists())
        self.assertEqual(cache.get("https://api.binance.com/b", 60)[0], "new")

    def test_a_geo_block_is_tried_again_after_hours(self):
        os.environ.pop("TRADER_OFFLINE", None)
        url = "https://api.binance.com/api/v3/ping"
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
            http._blocked_hosts["api.binance.com"] = ("HTTP 451", time.monotonic())
            with self.assertRaises(http.GeoBlocked):
                http.get_text(url, ttl=0, retries=0)
            http._blocked_hosts["api.binance.com"] = ("HTTP 451", time.monotonic() - http.BLOCK_RETRY_SEC - 1)
            with self.assertRaises(http.SourceError) as cm:
                http.get_text(url, ttl=0, retries=0)
        self.assertNotIsInstance(cm.exception, http.GeoBlocked)


class Files(TraderTestCase):
    def test_an_unchanged_file_is_not_written_again(self):
        state.write_json("x.json", {"a": 1})
        with mock.patch.object(config, "atomic_write", side_effect=AssertionError("written")):
            state.write_json("x.json", {"a": 1})
        with mock.patch.object(config, "atomic_write") as w:
            state.write_json("x.json", {"a": 2})
        self.assertEqual(w.call_count, 2)  # the file and its spare copy

    def test_desk_reviews_get_no_spare_copy(self):
        state.write_json("desk/i1/case.json", {"a": 1})
        self.assertFalse((self.tmp / "trader" / "desk" / "i1" / "case.json.bak").exists())
        state.write_json("journal.json", {"trades": []})
        self.assertTrue((self.tmp / "trader" / "journal.json.bak").exists())

    def test_the_newest_lines_are_read_from_the_end(self):
        rows = [{"i": i, "pad": "x" * (i % 300)} for i in range(3000)]
        p = config.ensure_home() / "t.jsonl"
        p.write_text("".join(json.dumps(r) + "\n" for r in rows) + "half a li")
        self.assertEqual([r["i"] for r in state.tail_jsonl("t.jsonl", 5)], list(range(2995, 3000)))
        self.assertEqual(len(state.tail_jsonl("t.jsonl", stop=lambda r: r["i"] < 2000)), 1000)
        self.assertEqual([r["i"] for r in state.tail_jsonl("t.jsonl")], list(range(3000)))

    @unittest.skipUnless(sys.platform.startswith("linux"), "file size limits need Linux")
    def test_a_full_disk_leaves_no_half_line(self):
        code = """
import os, resource, signal, sys
sys.path.insert(0, %r)
os.environ["TRADER_HOME"] = %r
from shared import state
state.append_jsonl("log.jsonl", {"n": 1})
size = os.path.getsize(state.path("log.jsonl"))
signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
resource.setrlimit(resource.RLIMIT_FSIZE, (size + 100, size + 100))
try:
    state.append_jsonl("log.jsonl", {"n": 2, "pad": "x" * 5000})
    print("no error")
except OSError:
    pass
print(open(state.path("log.jsonl")).read().count(chr(10)), os.path.getsize(state.path("log.jsonl")) == size)
""" % (str(ROOT), str(self.tmp / "trader"))
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
        self.assertEqual(out.stdout.split(), ["1", "True"], out.stderr)


def bar(t, o, h, low, c):
    return Candle(t, o, h, low, c, 1000.0)


class Simulator(TraderTestCase):
    NOW = "2026-10-20T16:00:00Z"

    def broker(self, bars):
        b = SimBroker(config.load_config())
        b._candles[("BTC/USD", "crypto")] = bars
        return b

    def test_each_bar_is_walked_once(self):
        t0 = int(mc.ts("2026-10-20T14:00:00Z"))
        bars = [bar(t0 + i * 300, 100, 101, 99.5, 100) for i in range(20)]
        b = self.broker(bars)
        b.book["positions"]["BTC/USD"] = {"symbol": "BTC/USD", "asset": "crypto", "qty": 1.0, "avg_entry": 100.0,
                                          "opened_at": "2026-10-20T13:00:00Z"}
        os.environ["TRADER_NOW"] = "2026-10-20T14:30:00Z"
        b.place_stop("BTC/USD", 1.0, 95.0)
        os.environ["TRADER_NOW"] = "2026-10-20T15:00:00Z"
        b.sync()
        first = b.book["walked"]["BTC/USD"]
        self.assertEqual(first, t0 + 11 * 300)  # the last bar that had closed by 15:00
        # a later bar falls through the stop: found on the next sync, which walks only the new bars
        bars[15] = bar(t0 + 15 * 300, 100, 100, 90, 92)
        os.environ["TRADER_NOW"] = "2026-10-20T15:40:00Z"
        b2 = self.broker(bars)
        b2.sync()
        self.assertEqual(b2.book["positions"], {})
        self.assertAlmostEqual(b2.book["fills"][-1]["price"], 95.0, delta=0.1)  # the stop, less slippage
        b2.sync()
        self.assertNotIn("BTC/USD", b2.book["walked"])  # nothing open on it any more: forgotten

    def test_old_finished_orders_move_to_the_archive(self):
        b = self.broker([bar(int(mc.ts("2026-10-20T15:00:00Z")), 100, 101, 99, 100)])
        old = {"id": "sim-000001", "symbol": "BTC/USD", "asset": "crypto", "side": "buy", "status": "filled",
               "submitted_at": "2026-08-01T10:00:00Z", "filled_at": "2026-08-01T10:05:00Z"}
        parent = dict(old, id="sim-000002")
        working_leg = {"id": "sim-000003", "parent_id": "sim-000002", "symbol": "BTC/USD", "asset": "crypto",
                       "side": "sell", "type": "stop", "stop_price": 1.0, "qty": 1.0, "status": "new",
                       "submitted_at": "2026-08-01T10:00:00Z", "active_from": 0}
        b.book["orders"] = [old, parent, working_leg]
        b.book["fills"] = [{"order_id": "sim-000001", "at": "2026-08-01T10:05:00Z"},
                           {"order_id": "sim-000009", "at": "2026-10-20T10:05:00Z"}]
        b.sync()
        self.assertEqual([o["id"] for o in b.book["orders"]], ["sim-000002", "sim-000003"])
        self.assertEqual(len(b.book["fills"]), 1)
        archived = state.read_jsonl("broker/sim-archive.jsonl")
        self.assertEqual({(r["kind"], r.get("id") or r.get("order_id")) for r in archived},
                         {("order", "sim-000001"), ("fill", "sim-000001")})

    def test_a_book_that_cannot_be_saved_does_not_stop_the_sync(self):
        b = self.broker([bar(int(mc.ts("2026-10-20T15:00:00Z")), 100, 101, 99, 100)])
        with mock.patch.object(state, "write_json", side_effect=OSError(28, "No space left on device")):
            b.sync()
        self.assertIn("No space left", b.save_error)


class FullDisk(TraderTestCase):
    def test_the_time_stop_still_runs_and_nothing_new_opens(self):
        a = ap()
        a.run_cycle("2026-10-20T15:00:00Z", approved=True)
        broker = a.brokers.get(config.load_config())
        broker.book["positions"]["NVDA"] = {"symbol": "NVDA", "asset": "stock", "qty": 10.0, "avg_entry": 100.0,
                                            "last": 101.0, "opened_at": "2026-10-20T14:02:00Z"}
        broker._save()
        state.write_json("autopilot/book.json", {"items": {"p1": {
            "plan_id": "p1", "order_id": "ord-p1", "broker_order_id": "e1", "broker": "simulator",
            "mode": "simulator", "symbol": "NVDA", "data_key": "NVDA", "asset": "stock", "qty": 10.0, "stop": 95.0,
            "target": 110.0, "time_stop": "2026-10-20T15:30:00Z", "status": "open",
            "placed_at": "2026-10-20T14:00:00Z", "filled_at": "2026-10-20T14:02:00Z"}}, "handled": {}})
        full = OSError(28, "No space left on device")
        with mock.patch.object(config, "atomic_write", side_effect=full), \
                mock.patch.object(state, "append_jsonl", side_effect=full), \
                mock.patch.object(a, "_free_mb", return_value=20):
            res = a.run_cycle("2026-10-20T15:35:00Z", approved=True)
        self.assertTrue(any("time exit for NVDA" in x for x in res["actions"]), res)
        self.assertTrue(any("disk almost full" in e for e in res["errors"]), res)
        self.assertEqual([d for d in res.get("decisions") or [] if d.get("action") == "taken"], [])


class Pruning(TraderTestCase):
    NOW = "2026-10-20T16:00:00Z"

    def test_old_records_move_to_the_archive_and_what_is_open_stays(self):
        old, new = "2026-08-01T10:00:00Z", "2026-10-19T10:00:00Z"
        state.write_json("autopilot/book.json", {"handled": {}, "items": {
            "gone": {"status": "closed", "placed_at": old, "closed_at": old, "plan_id": "gone", "order_id": "ord-gone"},
            "held": {"status": "open", "placed_at": old, "plan_id": "held", "order_id": "ord-held"},
            "fresh": {"status": "closed", "placed_at": new, "closed_at": new, "plan_id": "fresh"}}})
        state.write_json("plan.json", {"latest": "fresh", "plans": {
            "gone": {"id": "gone", "created_at": old}, "held": {"id": "held", "created_at": old},
            "alerted": {"id": "alerted", "created_at": old}, "fresh": {"id": "fresh", "created_at": new}}})
        state.write_json("alerts.json", {"alerts": [{"plan_id": "alerted"}]})
        state.write_json("orders.json", {"orders": [{"id": "ord-gone", "created_at": old},
                                                    {"id": "ord-held", "created_at": old}]})
        state.write_json("entries.json", {"entries": {"gone": {"id": "gone", "checked_at": old}}})
        stamp = time.time() - 60 * 86400
        for rel in ("desk/gone/desk.json", "desk/held/desk.json", "timemachine/NVDA-20260801.json",
                    "backtests/NVDA-orb15.json", "backtests/lab-crypto.json"):
            state.write_json(rel, {})
            p = state.path(*rel.split("/"))
            os.utime(str(p), (stamp, stamp))
            if rel.startswith("desk/"):
                os.utime(str(p.parent), (stamp, stamp))
        res = ap().prune_state()
        book = state.read_json("autopilot/book.json")
        self.assertEqual(sorted(book["items"]), ["fresh", "held"])
        self.assertEqual(sorted(state.read_json("plan.json")["plans"]), ["alerted", "fresh", "held"])
        self.assertEqual([o["id"] for o in state.read_json("orders.json")["orders"]], ["ord-held"])
        self.assertEqual(state.read_json("entries.json")["entries"], {})
        self.assertEqual([r["id"] for r in state.read_jsonl("archive/book.jsonl")], ["gone"])
        self.assertEqual([r["id"] for r in state.read_jsonl("archive/plan.jsonl")], ["gone"])
        home = self.tmp / "trader"
        self.assertFalse((home / "desk" / "gone").exists())
        self.assertTrue((home / "desk" / "held").exists())  # its position is still open
        self.assertFalse((home / "timemachine" / "NVDA-20260801.json").exists())
        self.assertFalse((home / "backtests" / "NVDA-orb15.json").exists())
        self.assertTrue((home / "backtests" / "lab-crypto.json").exists())
        self.assertEqual(res["book"], 1)

    def test_a_big_log_is_rotated_into_a_gzip_archive(self):
        p = config.ensure_home() / "autopilot" / "decisions.jsonl"
        p.parent.mkdir(parents=True, exist_ok=True)
        rows = [json.dumps({"i": i, "pad": "x" * 1000}) + "\n" for i in range(3000)]
        p.write_text("".join(rows))
        moved = ap().rotate_log("autopilot/decisions.jsonl", 1, 0.5)
        self.assertGreater(moved, 0)
        kept = state.read_jsonl("autopilot/decisions.jsonl")
        self.assertEqual(kept[-1]["i"], 2999)
        self.assertLess(p.stat().st_size, 0.6 * 1024 * 1024)
        gz = list((config.ensure_home() / "archive").glob("autopilot-decisions-*.jsonl.gz"))
        with gzip.open(str(gz[0]), "rt") as fh:
            archived = [json.loads(x) for x in fh]
        self.assertEqual(archived[0]["i"], 0)
        self.assertEqual(archived[-1]["i"] + 1, kept[0]["i"])  # nothing lost, nothing twice


class EquityPeak(TraderTestCase):
    NOW = "2026-10-20T16:00:00Z"

    def test_compaction_keeps_each_hours_peak_and_the_drawdown_still_counts(self):
        from shared import adapt
        t0 = int(mc.ts("2026-10-01T10:00:00Z"))
        lines = []
        for i in range(60):  # a 20-minute spike to 12,000 inside one hour, 10,000 the rest of it
            lines.append({"at": mc.iso(t0 + i * 60), "equity": 12000.0 if 20 <= i < 40 else 10000.0})
        lines.append({"at": "2026-10-20T15:59:00Z", "equity": 10800.0})
        p = config.ensure_home() / "broker" / "equity.jsonl"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("".join(json.dumps(r) + "\n" for r in lines))
        before = adapt._equity({}, mc.ts("2026-10-20T16:00:00Z"))
        self.assertEqual(before["peak"], 12000.0)
        removed = ap().compact_equity()
        self.assertGreater(removed, 50)
        kept = state.read_jsonl("broker/equity.jsonl")
        self.assertIn(12000.0, [r["equity"] for r in kept])
        after = adapt._equity({"_equity": before}, mc.ts("2026-10-20T16:00:00Z"))
        self.assertEqual(after["peak"], 12000.0)
        p.write_text(json.dumps({"at": "2026-10-20T15:59:00Z", "equity": 5000.0}) + "\n")  # a fresh simulator
        fresh = adapt._equity({"_equity": after}, mc.ts("2026-10-20T16:00:00Z"))
        self.assertEqual(fresh["peak"], 5000.0)


class OnceNotEveryMinute(TraderTestCase):
    def test_the_health_histories_are_simulated_once_per_record(self):
        from shared import health
        trades = [{"r": (-1.0 if i % 3 else 2.0), "setup": "trend_ema"} for i in range(40)]
        ref = [(-1.0 if i % 3 else 2.2) for i in range(400)]
        first = health.evaluate(trades, ref, {})
        with mock.patch.object(health, "_evaluate", side_effect=AssertionError("simulated again")):
            self.assertEqual(health.evaluate(trades, ref, {}), first)

    def test_old_approval_lines_read_the_orders_once(self):
        risk = load("trader-risk", "risk")
        for i in range(30):
            state.append_jsonl("approvals.jsonl", {"ts": "2026-10-20T14:%02d:00Z" % i, "order_id": "o%d" % i,
                                                   "approved": True})
        state.write_json("orders.json", {"orders": [{"id": "o%d" % i, "asset": "crypto"} for i in range(30)]})
        with mock.patch.object(risk, "_orders", wraps=risk._orders) as orders:
            n = risk.trades_today("2026-10-20T15:00:00Z", "crypto")
        self.assertEqual(n, 30)
        self.assertEqual(orders.call_count, 1)


class DeskList(DashboardCase):
    def test_only_the_newest_reviews_are_sent(self):
        server = load("app", "server")
        for i in range(server.DESK_ROWS + 15):
            state.write_json("desk/i%03d/desk.json" % i, {"id": "i%03d" % i, "verified_at": "2026-10-20T14:%02d:00Z"
                                                          % (i % 60)})
            p = state.path("desk", "i%03d" % i, "desk.json")
            os.utime(str(p), (1700000000 + i, 1700000000 + i))
        rows = server.desk_view()["desk"]
        self.assertEqual(len(rows), server.DESK_ROWS)
        self.assertNotIn("i000", {r["id"] for r in rows})
