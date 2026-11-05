"""The customer's set-up: one command to install, a guide that asks instead of files to edit, nothing secret shown."""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import stat
import subprocess
import types
from pathlib import Path

from tests.helpers import TraderTestCase

DEPLOY = Path(__file__).resolve().parent.parent / "deploy"


class Guide(TraderTestCase):
    def setUp(self):
        super().setUp()
        self.etc = self.tmp / "etc"
        self.data = self.tmp / "data"
        self.etc.mkdir()
        self.data.mkdir()
        self.env = self.etc / "trader.env"
        self.env.write_text("# keys\nTRADER_DASHBOARD_PASSWORD=\nBYBIT_LIVE_KEY=\nX_BEARER_TOKEN=keep-me\n",
                            encoding="utf-8")
        (self.data / "config.json").write_text(json.dumps({"autopilot": {"broker": "simulator"}}), encoding="utf-8")
        for k, v in (("TRADER_ENV_FILE", self.env), ("TRADER_DATA", self.data), ("TRADER_PREFIX", DEPLOY.parent)):
            self._saved_env.setdefault(k, os.environ.get(k))
            os.environ[k] = str(v)
        spec = importlib.util.spec_from_file_location("trader_setup", str(DEPLOY / "setup.py"))
        self.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.mod)

    def tearDown(self):
        for k in ("TRADER_ENV_FILE", "TRADER_DATA", "TRADER_PREFIX"):
            if self._saved_env.get(k) is None:
                os.environ.pop(k, None)
        super().tearDown()

    def guide(self, answers, secrets_, licensed=False):
        said, ran = [], []
        answers, secrets_ = list(answers), list(secrets_)

        def run(cmd, **kw):
            ran.append(cmd)
            out = json.dumps({"valid": licensed}) if "license" in cmd and "--json" in cmd else ""
            return types.SimpleNamespace(returncode=0, stdout=out, stderr="")
        w = self.mod.Wizard(ask=lambda q: answers.pop(0), secret=lambda q: secrets_.pop(0),
                            out=lambda *a: said.append(" ".join(str(x) for x in a)), run=run)
        self.assertEqual(w.run(), 0)
        self.assertEqual((answers, secrets_), ([], []), "every question was asked")
        return "\n".join(said), ran

    def test_a_first_run_on_the_simulator(self):
        # password: Enter → a strong one; licence: skip; Bybit: no; capital 1000; risk 2; Telegram: no
        said, ran = self.guide(["", "n", "", "", "n"], [""])
        env = self.env.read_text(encoding="utf-8")
        pw = [line.split("=", 1)[1] for line in env.splitlines() if line.startswith("TRADER_DASHBOARD_PASSWORD=")][0]
        self.assertGreaterEqual(len(pw), 16)
        self.assertIn("X_BEARER_TOKEN=keep-me", env)  # every other line kept
        self.assertEqual(stat.S_IMODE(os.stat(str(self.env)).st_mode), 0o600)
        profile = [c for c in ran if "profile" in c][0]
        self.assertEqual(profile[:4], ["runuser", "-u", "trader", "--"])  # the bot writes its own files
        for arg in ("--capital", "1000", "--risk", "2", "--venue", "bybit"):
            self.assertIn(arg, profile)
        self.assertNotIn("--leverage", profile)
        self.assertEqual(json.loads((self.data / "config.json").read_text())["autopilot"]["broker"], "simulator")
        self.assertIn(["systemctl", "restart", "trader-autopilot", "trader-dashboard"], ran)

    def test_keys_are_stored_never_shown_and_live_needs_the_phrase(self):
        key, sec = "AbCdEfGh12345678", "very-secret-value-0001"
        # password set: keep; licence skip; Bybit yes; capital; risk; leverage no; Telegram no; phrase wrong
        said, ran = self.guide(["", "a", "500", "1,5", "n", "n", "i accept"], ["correct horse battery", key, sec],
                               licensed=True)
        env = self.env.read_text(encoding="utf-8")
        self.assertIn("BYBIT_LIVE_KEY=" + key, env)
        self.assertIn("BYBIT_LIVE_SECRET=" + sec, env)
        self.assertNotIn(sec, said)
        self.assertNotIn(key, said)
        self.assertIn("AbCd…5678", said)
        self.assertIn("Zostávam na simulátore", said)
        cfg = json.loads((self.data / "config.json").read_text())
        self.assertNotIn("live_confirmation", cfg.get("autopilot", {}))
        profile = [c for c in ran if "profile" in c][0]
        self.assertIn("1.5", profile)  # the risk, typed with a decimal comma
        # the phrase typed exactly: the five live steps are set, and checked
        said, ran = self.guide(["n", "", "n", "", "", "n", "n", self.mod.CONFIRM], [], licensed=True)
        cfg = json.loads((self.data / "config.json").read_text())
        self.assertEqual((cfg["paper"], cfg["autopilot"]["broker"], cfg["autopilot"]["mode"]), (False, "bybit", "live"))
        self.assertEqual(cfg["autopilot"]["live_confirmation"], self.mod.CONFIRM)
        self.assertTrue(any("check-live" in c for c in ran))

    def test_without_a_licence_it_never_offers_live(self):
        said, ran = self.guide(["", "a", "", "", "n"], ["", "KEY12345678", "SECRET123456"], licensed=False)
        self.assertNotIn("Ostrý účet", said)
        self.assertIn("Bez licencie bot obchoduje len na simulátore", said)


class Scripts(TraderTestCase):
    def text(self, name):
        return (DEPLOY / name).read_text(encoding="utf-8")

    def test_the_one_command_install(self):
        sh = self.text("install-customer.sh")
        self.assertIn("sha256sum -c --quiet -", sh)  # a damaged download never installs
        self.assertIn('bash "$WORK/src/deploy/install-vps.sh"', sh)
        self.assertIn("python3 /opt/trader/deploy/setup.py < /dev/tty", sh)  # the guide reads the keyboard, not the pipe
        rel = self.text("release.sh")
        self.assertIn("vendor-private*.json", rel)  # never ships the signing key
        self.assertIn("shared/license_key.json is missing", rel)
        self.assertIn('sed "s#__BASE__#https://$DOMAIN#g"', rel)
        self.assertIn("exec python3 \"$PREFIX/deploy/setup.py\"", self.text("traderctl"))
        caddy = self.text("Caddyfile.example")
        self.assertIn("root * /var/lib/trader-release", caddy)
        bash = shutil.which("bash")
        if not bash:
            self.skipTest("bash not available")
        for name in ("install-customer.sh", "release.sh"):
            r = subprocess.run([bash, "-n", str(DEPLOY / name)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(r.returncode, 0, r.stderr)
        r = subprocess.run([bash, str(DEPLOY / "release.sh"), "not a domain"], stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE)
        self.assertEqual(r.returncode, 2)

    def test_the_landing_page_on_its_own_address(self):
        bash = shutil.which("bash")
        if not bash:
            self.skipTest("bash not available")
        site = DEPLOY / "site-on.sh"
        r = subprocess.run([bash, str(site), "--print", "Trader.Example.sk"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        block = r.stdout
        self.assertTrue(block.startswith("# trader-site: trader.example.sk\ntrader.example.sk {\n"))
        self.assertEqual(block.count("{"), block.count("}"))
        self.assertNotIn("\n#", block.split("\n", 1)[1].replace("\t#", ""))  # every line uncommented
        for part in ("reverse_proxy 127.0.0.1:8770", "root * /opt/trader/site", "handle @private {"):
            self.assertIn(part, block)
        # the private files are answered by their own handle, before the catch-all one serves the folder
        self.assertLess(block.index("handle @private"), block.rindex("handle {"))
        self.assertEqual(subprocess.run([bash, str(site), "no domain"], stdout=subprocess.PIPE, stderr=subprocess.PIPE).returncode, 2)
        if os.geteuid() != 0:
            self.skipTest("the install half runs as root")
        # the install half, with systemctl / caddy / hostname stood in for: one block, added once, put back if invalid
        bin_ = self.tmp / "bin"
        bin_.mkdir()
        calls = self.tmp / "calls"
        for name, body in (("systemctl", 'echo "systemctl $*" >> "%s"' % calls), ("hostname", "echo 192.0.2.1"),
                           ("ufw", "exit 0"), ("caddy", '[ -f "%s" ] && exit 1; exit 0' % (self.tmp / "invalid"))):
            (bin_ / name).write_text("#!/bin/sh\n" + body + "\n", encoding="utf-8")
            os.chmod(str(bin_ / name), 0o755)
        prefix = self.tmp / "opt"
        (prefix / "site").mkdir(parents=True)
        (prefix / "site" / "index.html").write_text("<!doctype html>", encoding="utf-8")
        unit = self.tmp / "trader-site.service"
        unit.write_text("[Unit]\n", encoding="utf-8")
        caddyfile = self.tmp / "Caddyfile"
        caddyfile.write_text("bot.example.sk {\n\treverse_proxy 127.0.0.1:8765\n}\n", encoding="utf-8")
        env = dict(os.environ, PATH="%s:%s" % (bin_, os.environ.get("PATH", "")), TRADER_PREFIX=str(prefix),
                   CADDYFILE=str(caddyfile), TRADER_SITE_UNIT=str(unit))

        def run():
            return subprocess.run([bash, str(site), "trader.example.invalid"], stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, universal_newlines=True, env=env)
        r = run()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("https://trader.example.invalid", r.stdout)
        self.assertIn("does not resolve yet", r.stdout)
        text = caddyfile.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("bot.example.sk {"))  # the dashboard's block untouched
        self.assertEqual(text.count("# trader-site: trader.example.invalid"), 1)
        self.assertIn("systemctl enable --now trader-site", calls.read_text(encoding="utf-8"))
        self.assertEqual(run().returncode, 0)
        self.assertEqual(caddyfile.read_text(encoding="utf-8"), text)  # a second run changes nothing
        # the dashboard's own address: its block is swapped for page + dashboard on one address
        one = self.tmp / "Caddyfile-one"
        one.write_text("# top\nbot.example.invalid {\n\tencode gzip\n\treverse_proxy 127.0.0.1:8765\n}\n#tail {\n#}\n",
                       encoding="utf-8")
        env["CADDYFILE"] = str(one)
        r = subprocess.run([bash, str(site), "bot.example.invalid"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("the dashboard's address", r.stdout)
        text = one.read_text(encoding="utf-8")
        self.assertEqual(text.count("bot.example.invalid {"), 1)  # one block for the address, not two
        self.assertNotIn("\tencode gzip\n", text)  # the old dashboard block is gone
        self.assertIn("# trader-site: bot.example.invalid (landing page + dashboard)", text)
        self.assertTrue(text.startswith("# top\n") and "#tail {" in text)  # the rest kept
        server = (DEPLOY.parent / "app" / "server.py").read_text(encoding="utf-8")
        self.assertIn('SESSION_COOKIE = "trader_session"', server)  # the cookie the @guest matcher looks for
        self.assertIn("not header Cookie *trader_session=*", text)
        other = self.tmp / "Caddyfile-other"
        other.write_text("shop.example.invalid {\n\trespond hi\n}\n", encoding="utf-8")
        env["CADDYFILE"] = str(other)
        r = subprocess.run([bash, str(site), "shop.example.invalid"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True, env=env)
        self.assertEqual(r.returncode, 1)
        self.assertIn("not the dashboard", r.stderr)
        self.assertEqual(other.read_text(encoding="utf-8"), "shop.example.invalid {\n\trespond hi\n}\n")
        (self.tmp / "invalid").write_text("", encoding="utf-8")
        env["CADDYFILE"] = str(self.tmp / "Caddyfile2")
        Path(env["CADDYFILE"]).write_text("bot.example.sk {\n}\n", encoding="utf-8")
        r = run()
        self.assertEqual(r.returncode, 1)
        self.assertIn("did not pass caddy validate", r.stderr)
        self.assertEqual(Path(env["CADDYFILE"]).read_text(encoding="utf-8"), "bot.example.sk {\n}\n")

