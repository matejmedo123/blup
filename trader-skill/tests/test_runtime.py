"""Runtime: a broken or half-written file, two writers at once, two traders at once — the exits keep running."""
from __future__ import annotations

import json
import os
import threading

from tests.helpers import TraderTestCase, load
from tests.test_app import DashboardCase
from shared import config, data, http, state


def ap():
    return load("trader-autopilot", "autopilot")


class BrokenFiles(TraderTestCase):
    def test_a_broken_file_falls_back_to_its_last_good_copy(self):
        state.write_json("autopilot/book.json", {"items": {"p": {"status": "open"}}, "handled": {}})
        (self.home / "autopilot" / "book.json").write_text("")   # a power cut, or a typo
        self.assertEqual(state.read_json("autopilot/book.json")["items"]["p"]["status"], "open")
        self.assertIn("book.json", state.recovered[-1])
        state.recovered.clear()

    def test_without_a_good_copy_it_is_an_error_not_an_exit(self):
        (self.home / "autopilot").mkdir(parents=True, exist_ok=True)
        (self.home / "autopilot" / "control.json").write_text("{oops")
        with self.assertRaises(state.StateError) as cm:   # a ValueError: callers catch it, the daemon lives on
            state.read_json("autopilot/control.json")
        self.assertIsInstance(cm.exception, ValueError)
        res = ap().run_cycle("2026-10-20T15:00:00Z", approved=True)
        self.assertEqual(res["status"], "paused", res)   # no new trades; the exits still ran
        self.assertTrue(any("control.json" in e for e in res["errors"]), res)
        state.recovered.clear()

    def test_a_typo_in_config_json_is_a_message(self):
        config.ensure_home()
        (self.home / "config.json").write_text('{"autopilot": {"enabled": tru}}')
        with self.assertRaises(config.ConfigError):
            config.load_config()
        code, out, err = self.run_tool("trader-autopilot", "autopilot", ["status"])
        self.assertEqual(code, 2)
        self.assertIn("config.json", err)

    def test_the_cycle_keeps_the_last_good_settings_and_takes_no_new_entries(self):
        config.ensure_home()
        good = ap().run_cycle("2026-10-20T15:00:00Z", approved=True)
        self.assertNotEqual(good["status"], "error", good)
        (self.home / "config.json").write_text('{"autopilot": ')   # saved halfway through an edit
        res = ap().run_cycle("2026-10-20T15:05:00Z", approved=True)
        self.assertNotEqual(res["status"], "error", res)
        self.assertTrue(any("last good settings" in e for e in res["errors"]), res)
        self.assertEqual(res["decisions"], [])


class TwoWritersAtOnce(TraderTestCase):
    def test_concurrent_writes_never_fail_or_leave_a_broken_file(self):
        problems = []
        stop = threading.Event()

        def writer(n):
            for i in range(150):
                try:
                    state.write_json("news_feed.json", {"writer": n, "i": i, "pad": "x" * 2000})
                except Exception as exc:  # noqa: BLE001
                    problems.append(repr(exc))

        def reader():
            while not stop.is_set():
                try:
                    doc = json.loads((self.home / "news_feed.json").read_text(encoding="utf-8"))
                    assert "writer" in doc
                except FileNotFoundError:
                    continue
                except Exception as exc:  # noqa: BLE001
                    problems.append("read: %r" % exc)
        state.write_json("news_feed.json", {"writer": -1})
        r = threading.Thread(target=reader)
        r.start()
        ws = [threading.Thread(target=writer, args=(n,)) for n in range(4)]
        for w in ws:
            w.start()
        for w in ws:
            w.join()
        stop.set()
        r.join()
        self.assertEqual(problems, [])
        self.assertEqual([p.name for p in self.home.glob(".*.tmp")], [])   # no temp files left behind

    def test_read_modify_write_loses_no_update(self):
        state.write_json("x_usage.json", {"reads": 0})

        def bump():
            for _ in range(50):
                state.update_json("x_usage.json", lambda d: d.update(reads=d["reads"] + 1), {})
        ts = [threading.Thread(target=bump) for _ in range(4)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(state.read_json("x_usage.json")["reads"], 200)


class OneTraderPerFolder(TraderTestCase):
    def test_a_live_daemon_is_seen_by_its_os_lock_however_long_it_waits(self):
        import fcntl
        fh = open(str(state.path("autopilot/daemon.flock")), "a")
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)   # another process's daemon, 20 minutes into a back-off
        state.write_json("autopilot/daemon.lock", {"pid": 4242, "host": "elsewhere", "flock": True,
                                                   "started_at": "2020-01-01T00:00:00Z"})
        try:
            self.assertEqual(ap().lock_holder()["pid"], 4242)
            code, _, err = self.run_tool("trader-autopilot", "autopilot", ["daemon", "--max-cycles", "1"])
            self.assertEqual(code, 2)
            self.assertIn("already running", err)
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            fh.close()
        self.assertIsNone(ap().lock_holder())   # it died: a new container may take over at once

    def test_replay_never_runs_against_a_real_broker_or_a_running_daemon(self):
        config.ensure_home()
        config.update_file("config.json", {"autopilot": {"broker": "alpaca"}})
        code, _, err = self.run_tool("trader-autopilot", "autopilot", ["replay", "--from", "2026-10-20T14:00:00Z",
                                                                       "--to", "2026-10-20T14:10:00Z"])
        self.assertEqual(code, 2)
        self.assertIn("only on the simulator", err)


class OneSignalOneTrade(TraderTestCase):
    def test_a_daily_signal_is_remembered_the_next_day(self):
        book = {"items": {}, "handled": {"2026-10-19": {"SOLUSDT-20261018T0000-trend_breakout": "skipped"},
                                         "2026-10-01": {"old": "taken"}}}
        seen = ap()._recent_handled(book, "2026-10-20T00:05:00Z")
        self.assertIn("SOLUSDT-20261018T0000-trend_breakout", seen)
        self.assertIn("2026-10-20", book["handled"])

    def test_a_signal_already_in_the_book_is_not_traded_again(self):
        sid = "SOLUSDT-20261018T0000-trend_breakout"
        book = {"items": {sid: {"status": "closed", "data_key": "SOLUSDT"}}, "handled": {}}
        c = {"id": sid, "sym": data.as_symbol("SOLUSDT", "crypto"), "asset": "crypto", "setup": "trend_breakout"}
        d = ap().judge(c, config.load_config(), config.load_limits(), None, book, True, {})
        self.assertEqual(d["action"], "skipped")
        self.assertIn("already traded", d["reasons"][0])

    def test_exchange_listed_meme_coins_are_never_judged(self):
        c = {"id": "x", "sym": data.as_symbol("DOGEUSDT", "crypto"), "asset": "crypto", "setup": "trend_ema"}
        d = ap().judge(c, config.load_config(), config.load_limits(), None, {"items": {}, "handled": {}}, True, {})
        self.assertIn("meme coin", d["reasons"][0])


class DataWarnings(TraderTestCase):
    def test_warnings_are_kept_once_and_only_the_latest(self):
        for i in range(50):
            http.note("served a cached copy of host%d" % (i % 30))
        self.assertEqual(len(http.warnings), http.MAX_WARNINGS)
        self.assertEqual(len(set(http.warnings)), len(http.warnings))


class DashboardHost(DashboardCase):
    def test_dns_rebinding_is_refused_without_a_password(self):
        self.start()
        code, _, text = self.req("GET", "/", headers={"Host": "attacker.example:%d" % self.port})
        self.assertEqual(code, 403)
        self.assertNotIn(self.app.csrf, text)
        self.assertEqual(self.req("POST", "/api/control", {"action": "resume"},
                                  {"Host": "attacker.example", "Origin": "http://attacker.example",
                                   "X-Trader-CSRF": self.app.csrf})[0], 403)
        self.assertEqual(self.req("GET", "/api/summary", headers={"Host": "localhost:%d" % self.port})[0], 200)
        self.assertEqual(self.req("GET", "/api/summary", headers={"Host": "[::1]:%d" % self.port})[0], 200)
        os.environ["TRADER_DASHBOARD_HOSTS"] = "trader.lan"
        self.addCleanup(os.environ.pop, "TRADER_DASHBOARD_HOSTS", None)
        self.assertEqual(self.req("GET", "/api/summary", headers={"Host": "trader.lan:%d" % self.port})[0], 200)

    def test_kill_from_the_dashboard_wakes_the_daemon_now(self):
        self.start()
        self.assertEqual(self.control({"action": "kill", "confirm": "KILL"})[0], 200)
        c = json.loads((self.home / "autopilot" / "control.json").read_text(encoding="utf-8"))
        self.assertEqual((c["kill"], c["run_once"]), (True, True))
