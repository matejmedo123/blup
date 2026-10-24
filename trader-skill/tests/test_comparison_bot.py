"""The comparison bot of deploy/test-bot.sh: told apart on the dashboard, compared side by side, never the real keys."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
from pathlib import Path

from tests.helpers import TraderTestCase, load

DEPLOY = Path(__file__).resolve().parent.parent / "deploy"


def _compare():
    spec = importlib.util.spec_from_file_location("trader_compare", str(DEPLOY / "compare.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class SetupLabel(TraderTestCase):
    def write(self, cfg, limits=None):
        self.home.mkdir(parents=True, exist_ok=True)
        (self.home / "config.json").write_text(json.dumps(cfg), encoding="utf-8")
        if limits is not None:
            (self.home / "limits.json").write_text(json.dumps(limits), encoding="utf-8")

    def label(self):
        srv = load("app", "server")
        return srv.setup_info(srv.config.load_config())

    def test_risk_core_coins_and_leverage(self):
        self.write({"risk_per_trade_pct": 3, "risk_by_symbol": {"BTC": 4, "ETH": 4}, "leverage": {"crypto": 2},
                    "autopilot": {"broker": "simulator"}},
                   {"crypto": {"allow_leverage": True, "max_leverage": 2}})
        s = self.label()
        self.assertEqual(s["label"], "Risk 3 % · BTC/ETH 4 % · 2×")
        self.assertEqual((s["risk_pct"], s["crypto_leverage"]), (3.0, 2.0))
        self.assertEqual(s["risk_by_symbol"], {"BTC": 4.0, "ETH": 4.0})

    def test_the_leverage_the_bot_really_uses(self):
        # config asks for 1.5× but limits.json does not allow it: the bot trades 1×, so the label says 1×
        self.write({"risk_per_trade_pct": 2, "risk_by_symbol": {"BTC": 3, "ETH": 2}, "leverage": {"crypto": 1.5}},
                   {"crypto": {"allow_leverage": False}})
        self.assertEqual(self.label()["label"], "Risk 2 % · BTC 3 % · 1×")  # ETH at the base risk is not repeated
        self.write({"risk_per_trade_pct": 2, "leverage": {"crypto": 1.5}, "autopilot": {"broker": "bybit"}},
                   {"crypto": {"allow_leverage": True, "max_leverage": 2}})
        self.assertEqual(self.label()["label"], "Risk 2 % · 1.5×")
        self.write({"risk_per_trade_pct": 2, "leverage": {"crypto": 1.5}, "autopilot": {"broker": "alpaca"}},
                   {"crypto": {"allow_leverage": True, "max_leverage": 2}})
        self.assertEqual(self.label()["label"], "Risk 2 % · 1×")  # Alpaca has no crypto margin

    def test_summary_and_page_carry_it(self):
        self.write({"risk_per_trade_pct": 3, "risk_by_symbol": {"BTC": 4, "ETH": 4}, "leverage": {"crypto": 2}},
                   {"crypto": {"allow_leverage": True, "max_leverage": 2}})
        srv = load("app", "server")
        httpd, app = srv.make_server("127.0.0.1", 0, "", False, None)
        try:
            self.assertEqual(srv.summary_view(app)["setup"]["label"], "Risk 3 % · BTC/ETH 4 % · 2×")
        finally:
            app.stop()
            httpd.server_close()
        js = (Path(srv.__file__).parent / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn("js-setup", js)
        self.assertIn("' · Trader' + (setupLabel()", js)  # the browser tab tells the two dashboards apart


class Compare(TraderTestCase):
    def bot(self, name, cfg, rows):
        home = self.tmp / name
        (home / "broker").mkdir(parents=True)
        (home / "config.json").write_text(json.dumps(cfg), encoding="utf-8")
        (home / "broker" / "equity.jsonl").write_text(
            "".join(json.dumps({"at": at, "equity": eq, "account": "simulator"}) + "\n" for at, eq in rows),
            encoding="utf-8")
        return str(home)

    def test_side_by_side_from_the_same_start(self):
        sim = {"autopilot": {"broker": "simulator", "sim_starting_cash": 1000}}
        a = self.bot("trader", dict(sim, risk_per_trade_pct=2), [
            ("2026-10-01T00:00:00Z", 1000), ("2026-10-10T00:00:00Z", 1100), ("2026-10-20T00:00:00Z", 1050)])
        b = self.bot("trader-test", dict(sim, risk_per_trade_pct=3), [
            ("2026-10-10T00:00:00Z", 1000), ("2026-10-20T00:00:00Z", 1200)])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(_compare().main(["--home", a, "--home", b]), 0)
        rows = {line.split("  ")[0].strip(): line for line in out.getvalue().splitlines() if line.strip()}
        since = rows["Return since 2026-10-10"]
        self.assertLess(since.index("−4.5 %"), since.index("+20.0 %"))  # the real bot after the test bot started
        self.assertIn("+5.0 %", rows["Return in total"])
        self.assertIn("+20.0 %", rows["Return in total"])
        self.assertIn("−4.5 %", rows["Worst drop"])
        self.assertIn("Risk 3 %", rows["Setup"])
        self.assertEqual(os.environ["TRADER_HOME"], b)  # it switches folders; the test harness restores it

    def test_a_missing_bot_says_how_to_make_one(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(_compare().main(["--home", str(self.tmp / "nothing")]), 1)
        self.assertIn("test-bot.sh", err.getvalue())


class Units(TraderTestCase):
    """Same hardening as the real bot, its own folder, and no way to the real bot's keys or state."""

    def text(self, name):
        return (DEPLOY / name).read_text(encoding="utf-8")

    def test_units_mirror_the_real_ones_without_the_keys(self):
        for real, test in (("trader-autopilot.service", "trader-test-autopilot.service"),
                           ("trader-dashboard.service", "trader-test-dashboard.service")):
            r, t = self.text(real), self.text(test)
            for line in r.splitlines():
                if line.split("=")[0] in ("NoNewPrivileges", "ProtectSystem", "ProtectHome", "PrivateTmp",
                                          "PrivateDevices", "RestrictAddressFamilies", "CapabilityBoundingSet",
                                          "MemoryDenyWriteExecute", "UMask", "User", "Restart", "KillSignal"):
                    self.assertIn(line, t.splitlines(), "%s lost %s" % (test, line))
            self.assertNotIn("EnvironmentFile=/etc/trader/trader.env", t)
            self.assertIn("EnvironmentFile=-/etc/trader/trader-test.env", t)
            self.assertIn("ReadWritePaths=/var/lib/trader-test\n", t)
            self.assertIn("InaccessiblePaths=-/var/lib/trader -/etc/trader/trader.env\n", t)
            self.assertNotIn("--home /var/lib/trader ", t + " ")
        self.assertIn("daemon --approve --home /var/lib/trader-test", self.text("trader-test-autopilot.service"))
        self.assertIn("--host 127.0.0.1 --port 8766 --home /var/lib/trader-test --no-autopilot --news-every 0",
                      self.text("trader-test-dashboard.service"))

    def test_setup_script_takes_only_the_password_and_refuses_a_real_broker(self):
        sh = self.text("test-bot.sh")
        uses = [line for line in sh.splitlines() if 'trader.env"' in line and not line.lstrip().startswith("#")]
        self.assertEqual(len(uses), 1, uses)
        self.assertIn("grep -E '^TRADER_DASHBOARD_PASSWORD=' \"$ETC/trader.env\"", uses[0])
        self.assertIn('cp -a "$MAIN/backtests/." "$DATA/backtests/"', sh)  # the lab result, nothing else
        self.assertNotIn("$MAIN/config.json\" \"$DATA", sh)
        self.assertIn('ap.get("broker", "simulator") == "simulator" and ap.get("mode", "paper") != "live"', sh)
        self.assertIn("REFUSED", sh)
        self.assertIn('runuser -u "$USER_NAME"', sh)  # the state stays owned by the bot, not by root
        ctl = self.text("traderctl")
        self.assertIn("ENV_FILE=/etc/trader/trader-test.env", ctl)
        self.assertIn('exec runuser -u trader -- python3 "$PREFIX/deploy/compare.py"', ctl)
        inst = self.text("install-vps.sh")
        self.assertIn('if [ -f "/etc/systemd/system/$u.service" ]; then', inst)  # refreshed only when installed

    def test_scripts_parse(self):
        bash = shutil.which("bash")
        if not bash:
            self.skipTest("bash not available")
        for name in ("test-bot.sh", "install-vps.sh", "traderctl"):
            r = subprocess.run([bash, "-n", str(DEPLOY / name)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(r.returncode, 0, r.stderr)
