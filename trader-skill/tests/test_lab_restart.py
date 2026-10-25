"""A restart while the first backtest lab runs (the guide's steps 6–7 do that) must not cost the user 6 hours."""
from __future__ import annotations

import contextlib
import io
import os
import types
from datetime import datetime, timezone
from unittest import mock

from shared import config, state
from tests.helpers import TraderTestCase, load

NOW = datetime(2026, 10, 25, 12, 30, tzinfo=timezone.utc)


def ap():
    return load("trader-autopilot", "autopilot")


class StoppedLab(TraderTestCase):
    def test_a_stop_signal_is_an_interruption_not_a_failure(self):
        a = ap()
        for code in (-15, -2, -1):
            with mock.patch.object(a.subprocess, "run", return_value=types.SimpleNamespace(
                    returncode=code, stdout="", stderr="")):
                with self.assertRaises(a.LabInterrupted):
                    a._run_lab(["--top", "10"], "backtests/lab-crypto.json")
        for code in (-9, 1):  # killed for memory, or a real error: those stay failures
            with mock.patch.object(a.subprocess, "run", return_value=types.SimpleNamespace(
                    returncode=code, stdout="", stderr="boom")):
                with self.assertRaises(RuntimeError) as cm:
                    a._run_lab(["--top", "10"], "backtests/lab-crypto.json")
                self.assertNotIsInstance(cm.exception, a.LabInterrupted)

    def test_interrupted_lab_is_tried_again_at_the_next_start(self):
        a = ap()
        state.write_json(a.HK_STATE, {"lab_tried": NOW.timestamp() - 600, "lab_running": True})
        with mock.patch.object(a, "_run_lab", side_effect=a.LabInterrupted("stopped by signal 15")):
            a._refresh_lab(config.load_config())
        last = state.tail_jsonl("autopilot/housekeeping.jsonl", 1)[-1]
        self.assertEqual(last["task"], "lab")
        self.assertIn("signal 15", last["interrupted"])
        self.assertEqual(state.read_json(a.HK_STATE, {}), {})

    def test_a_failed_lab_still_waits_six_hours(self):
        a = ap()
        state.write_json(a.HK_STATE, {"lab_tried": NOW.timestamp() - 600, "lab_running": True})
        with mock.patch.object(a, "_run_lab", side_effect=RuntimeError("the lab exited with 1: no data")):
            a._refresh_lab(config.load_config())
        self.assertIn("no data", state.tail_jsonl("autopilot/housekeeping.jsonl", 1)[-1]["error"])
        self.assertEqual(state.read_json(a.HK_STATE, {}), {"lab_tried": NOW.timestamp() - 600})


class NextStart(TraderTestCase):
    """The daemon's housekeeping after a restart: a lab still marked running was cut off, so it runs again."""

    def setUp(self):
        super().setUp()
        os.environ.pop("TRADER_OFFLINE", None)  # the lab never starts offline

    def started(self, hk):
        a = ap()
        state.write_json(a.HK_STATE, hk)
        calls = []
        with mock.patch.object(a, "_refresh_lab", side_effect=lambda cfg: calls.append(cfg)):
            h = a.Housekeeping()
            h._lab(config.load_config(), NOW)
            if h.lab_thread is not None:
                h.lab_thread.join(5)
        return bool(calls), state.read_json(a.HK_STATE, {})

    def test_cut_off_lab_runs_again(self):
        ran, hk = self.started({"lab_tried": NOW.timestamp() - 600, "lab_running": True})
        self.assertTrue(ran)
        self.assertEqual(hk, {"lab_tried": NOW.timestamp(), "lab_running": True})

    def test_a_lab_that_failed_by_itself_waits(self):
        ran, _ = self.started({"lab_tried": NOW.timestamp() - 600})
        self.assertFalse(ran)
        ran, _ = self.started({"lab_tried": NOW.timestamp() - 7 * 3600})
        self.assertTrue(ran)


class LabCommand(TraderTestCase):
    def run_cli(self, outcome):
        a = ap()
        out = io.StringIO()
        with mock.patch.object(a, "_run_lab", **outcome), contextlib.redirect_stdout(out):
            code = a.main(["lab"])
        return code, out.getvalue()

    def test_runs_now_and_says_what_came_out(self):
        doc = {"summary": {"coins_validated": 3, "seconds": 412}, "validated": [], "coins": 10}
        code, out = self.run_cli({"return_value": doc})
        self.assertEqual(code, 0)
        self.assertIn("Done: 3 validated combination(s) in 412s", out)
        code, out = self.run_cli({"side_effect": ap().LabInterrupted("stopped by signal 2 before it finished")})
        self.assertEqual(code, 1)
        self.assertIn("The lab did not finish: stopped by signal 2", out)
