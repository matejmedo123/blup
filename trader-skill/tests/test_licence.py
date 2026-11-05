"""Licences: the simulator is free, a real broker needs a plan, and nobody can edit or forge one."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
from datetime import timedelta
from pathlib import Path
from unittest import mock

from shared import config, licence, market_clock, state
from shared.brokers.simulator import SimBroker
from tests.helpers import TraderTestCase, load
from tests.test_autopilot import Day, decisions

DEPLOY = Path(__file__).resolve().parent.parent / "deploy"
_KEYS = {}


def key(name="seller"):
    if name not in _KEYS:  # small keys keep the tests fast; the tool makes 3072-bit ones
        _KEYS[name] = licence.keygen(1024)
    return _KEYS[name]


def soon(days):  # on the bot's clock, which the tests pin
    return (market_clock.now_utc().date() + timedelta(days=days)).isoformat()


class WithKey:
    def use_key(self):
        pub = self.tmp / "license_key.json"
        pub.write_text(json.dumps({"n": key()["n"], "e": key()["e"]}), encoding="utf-8")
        os.environ["TRADER_LICENSE_KEY"] = str(pub)


class Plans(WithKey, TraderTestCase):
    def test_a_build_without_a_key_locks_nothing(self):
        os.environ["TRADER_LICENSE_KEY"] = str(self.tmp / "none.json")
        st = licence.status()
        self.assertEqual((st["configured"], st["plan"]), (False, "max"))
        self.assertTrue(all(licence.allows(f, st)[0] for f in licence.NEEDS))

    def test_what_each_plan_unlocks(self):
        self.use_key()
        config.ensure_home()
        st = licence.status()
        self.assertEqual((st["plan"], st["valid"]), ("free", False))
        self.assertFalse(licence.allows("real_broker", st)[0])
        self.assertIn("Štart plan", licence.allows("real_broker", st)[1])
        licence.install(licence.issue(key(), "jana@example.sk", "start", soon(30)))
        st = licence.status()
        self.assertEqual((st["plan"], st["email"]), ("start", "ja…@example.sk"))
        self.assertTrue(licence.allows("real_broker", st)[0])
        for f in ("leverage", "funding_squeeze", "memes", "ai_desk", "comparison_bot"):
            self.assertFalse(licence.allows(f, st)[0], f)
        licence.install(licence.issue(key(), "jana@example.sk", "pro", soon(30)))
        self.assertTrue(all(licence.allows(f)[0] for f in licence.NEEDS))
        lic = licence.issue(key(), "firma@example.sk", "max", soon(365), instances=3)
        self.assertEqual(licence.install(lic)["instances"], 3)
        self.assertEqual(oct(os.stat(str(state.path(licence.FILE))).st_mode & 0o777), "0o600")

    def test_an_edited_or_foreign_licence_is_refused(self):
        self.use_key()
        config.ensure_home()
        doc = licence.issue(key(), "jana@example.sk", "start", soon(30))
        payload = json.loads(licence._unb64(doc["licence"]))
        payload["plan"] = "max"
        forged = dict(doc, licence=licence._b64(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()))
        with self.assertRaises(ValueError) as cm:
            licence.install(forged)
        self.assertIn("signature does not match", str(cm.exception))
        with self.assertRaises(ValueError):
            licence.install(licence.issue(key("someone else"), "jana@example.sk", "max", soon(30)))
        state.write_json(licence.FILE, forged)  # copied into the folder by hand
        st = licence.status()
        self.assertEqual(st["plan"], "free")
        self.assertIn("licence refused", st["reason"])

    def test_a_licence_that_ran_out(self):
        self.use_key()
        config.ensure_home()
        licence.install(licence.issue(key(), "jana@example.sk", "pro", soon(-1)))
        st = licence.status()
        self.assertEqual((st["plan"], st.get("expired")), ("free", True))
        self.assertIn("ran out", st["reason"])
        self.assertIn("open ones keep their stops and exits", st["reason"])
        self.assertFalse(licence.allows("real_broker", st)[0])

    def test_the_command(self):
        self.use_key()
        config.ensure_home()
        path = self.tmp / "lic.json"
        path.write_text(json.dumps(licence.issue(key(), "jana@example.sk", "pro", soon(30))), encoding="utf-8")
        a = load("trader-autopilot", "autopilot")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(a.main(["license", "--install", str(path)]), 0)
        text = out.getvalue()
        self.assertIn("Licence installed: Pro, valid until %s." % soon(30), text)
        self.assertIn("✓ leverage", text)
        self.assertIn("the simulator: every feature, no licence needed", text)
        path.write_text("{}", encoding="utf-8")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(a.main(["license", "--install", str(path)]), 1)
        self.assertIn("Licence refused: not a licence file", err.getvalue())


class RealBroker(WithKey, Day):
    """The fixture day's NVDA breakout, sent to a broker that is not the simulator."""

    def setUp(self):
        super().setUp()
        self.use_key()

    def cycle_on(self, name):
        broker = SimBroker(config.load_config())
        broker.name = name
        a = load("trader-autopilot", "autopilot")
        with mock.patch.object(a.brokers, "get", return_value=broker):
            res = a.run_cycle("2026-10-20T13:50:00Z", approved=True)
        return res, {d["id"]: d for d in decisions()}

    def test_no_licence_no_new_trade(self):
        res, ds = self.cycle_on("alpaca")
        nv = ds["NVDA-20261020-orb15"]
        self.assertEqual(nv["action"], "skipped")
        self.assertIn("licence: a real broker (Bybit, Alpaca) needs the Štart plan", nv["reasons"][0])

    def test_a_start_licence_trades(self):
        licence.install(licence.issue(key(), "jana@example.sk", "start", soon(30)))
        res, ds = self.cycle_on("alpaca")
        self.assertEqual(ds["NVDA-20261020-orb15"]["action"], "taken")

    def test_the_simulator_needs_none(self):
        res = load("trader-autopilot", "autopilot").run_cycle("2026-10-20T13:50:00Z", approved=True)
        self.assertEqual({d["id"]: d for d in decisions()}["NVDA-20261020-orb15"]["action"], "taken")



for _name in [n for n in dir(Day) if n.startswith("test") and n not in RealBroker.__dict__]:
    setattr(RealBroker, _name, None)  # the parent's own tests run in their own module


class SellerTool(TraderTestCase):
    def tool(self):
        spec = importlib.util.spec_from_file_location("license_tool", str(DEPLOY / "license-tool.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_keygen_issue_show(self):
        t = self.tool()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(t.main(["keygen", "--out", str(self.tmp / "vendor"), "--bits", "1024"]), 0)
        priv = self.tmp / "vendor" / "vendor-private.json"
        self.assertEqual(oct(os.stat(str(priv)).st_mode & 0o777), "0o600")
        pub = self.tmp / "vendor" / "license_key.json"
        self.assertNotIn('"d"', pub.read_text())
        lic = self.tmp / "jana.json"
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(t.main(["issue", "--key", str(priv), "--email", "jana@example.sk", "--plan", "max",
                                     "--until", "2027-12-31", "--instances", "3", "--out", str(lic)]), 0)
            self.assertEqual(t.main(["show", str(lic), "--pub", str(pub)]), 0)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):  # a second keygen would void every licence already sold
            self.assertEqual(t.main(["keygen", "--out", str(self.tmp / "vendor"), "--bits", "1024"]), 2)
            self.assertEqual(t.main(["keygen", "--out", str(DEPLOY / "x"), "--bits", "1024"]), 2)  # in the repo
        self.assertIn("inside a git checkout", err.getvalue())
        self.assertFalse((DEPLOY / "x").exists())

    def test_the_comparison_bot_and_traderctl_ask_for_it(self):
        sh = (DEPLOY / "test-bot.sh").read_text(encoding="utf-8")
        self.assertIn('licence.allows("comparison_bot")', sh)
        ctl = (DEPLOY / "traderctl").read_text(encoding="utf-8")
        self.assertIn('license --install - --home "$DATA" < "$3"', ctl)
        self.assertIn("vendor-private*.json", (DEPLOY.parent / ".gitignore").read_text(encoding="utf-8"))
