"""Dashboard server: every endpoint, security rules (secrets, CSRF, path traversal, auth), controls."""
from __future__ import annotations

import http.client
import json
import os
import threading
import types
from unittest import mock

from tests.helpers import TraderTestCase, load

ENDPOINTS = ("summary", "equity", "equity?range=1d", "positions", "orders", "trades", "trades?status=closed",
             "decisions", "news", "news?kind=social", "setups", "reports", "desk", "control")
FAKE_SECRETS = {
    "ALPACA_PAPER_KEY_ID": "PKFAKEPAPERKEY0001", "ALPACA_PAPER_SECRET_KEY": "paper-secret-zz9-plural-z-alpha",
    "ALPACA_LIVE_KEY_ID": "AKFAKELIVEKEY0002", "ALPACA_LIVE_SECRET_KEY": "live-secret-do-not-leak-4242",
    "X_BEARER_TOKEN": "AAAAfake-x-bearer-token-9876543210", "TRADER_DASHBOARD_PASSWORD": "correct horse battery 7",
}


class DashboardCase(TraderTestCase):
    def start(self, host="127.0.0.1", password="", run_autopilot=False):
        server = load("app", "server")
        httpd, app = server.make_server(host, 0, password, run_autopilot, None)
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        self.addCleanup(lambda: (app.stop(), httpd.shutdown(), httpd.server_close()))
        self.server_mod, self.httpd, self.app = server, httpd, app
        self.port = httpd.server_address[1]
        return app

    def req(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        hdrs = dict(headers or {})
        data = None
        if body is not None:
            data = body if isinstance(body, (bytes, str)) else json.dumps(body)
            hdrs.setdefault("Content-Type", "application/json")
        conn.request(method, path, body=data, headers=hdrs)
        r = conn.getresponse()
        raw = r.read()
        out = (r.status, dict(r.getheaders()), raw.decode("utf-8", "replace"))
        conn.close()
        return out

    def get_json(self, path, **kw):
        code, hdrs, text = self.req("GET", path, **kw)
        self.assertEqual(code, 200, "%s → %s %s" % (path, code, text[:300]))
        self.assertIn("application/json", hdrs.get("Content-Type", ""))
        self.assertEqual(hdrs.get("Cache-Control"), "no-store")
        return json.loads(text)

    def control(self, body, csrf=True, extra=None):
        hdrs = {"X-Trader-CSRF": self.app.csrf} if csrf else {}
        hdrs.update(extra or {})
        return self.req("POST", "/api/control", body, hdrs)


class EmptyHome(DashboardCase):
    def test_every_endpoint_on_an_empty_home(self):
        self.start()
        for ep in ENDPOINTS:
            self.get_json("/api/" + ep)
        s = self.get_json("/api/summary")
        self.assertEqual(s["mode"]["mode"], "simulator")
        self.assertFalse(s["mode"]["live"])
        self.assertEqual(s["stats"]["closed"], 0)
        self.assertEqual(self.get_json("/api/equity")["points"], [])

    def test_index_page_embeds_csrf_and_strict_csp(self):
        self.start()
        code, hdrs, text = self.req("GET", "/")
        self.assertEqual(code, 200)
        self.assertIn(self.app.csrf, text)
        self.assertNotIn("{{CSRF}}", text)
        csp = hdrs.get("Content-Security-Policy", "")
        self.assertIn("script-src 'self'", csp)
        self.assertNotIn("unsafe-inline", csp)
        self.assertEqual(hdrs.get("X-Frame-Options"), "DENY")
        for asset in ("/static/app.js", "/static/app.css", "/static/favicon.svg"):
            self.assertEqual(self.req("GET", asset)[0], 200, asset)
        self.assertEqual(self.req("GET", "/static/../server.py")[0], 404)
        self.assertEqual(self.req("GET", "/static/index.html")[0], 404)  # only served with the CSRF filled in
        self.assertEqual(self.req("GET", "/api/nope")[0], 404)


class WithData(DashboardCase):
    def setUp(self):
        super().setUp()
        load("app", "devdata").generate(self.home, "2026-10-20T19:30:00Z")
        rep = self.home / "reports"
        rep.mkdir(parents=True, exist_ok=True)
        (rep / "scan-stock-20261020.html").write_text("<!doctype html><title>x</title><p>report</p>", encoding="utf-8")
        (self.home / "config.json").write_text(json.dumps({"account_size": 25000}), encoding="utf-8")

    def test_every_endpoint_on_sample_data(self):
        self.start()
        for ep in ENDPOINTS:
            self.get_json("/api/" + ep)
        s = self.get_json("/api/summary")
        self.assertEqual(s["bot"]["status"], "running")
        self.assertEqual(s["positions"], 2)
        self.assertGreater(s["account"]["equity"], 0)
        self.assertEqual(s["account"]["source"], "broker")
        eq = self.get_json("/api/equity")
        self.assertGreater(len(eq["points"]), 10)
        self.assertLessEqual(len(eq["points"]), 500)
        self.assertTrue(eq["daily"])
        one_day = self.get_json("/api/equity?range=1d")["points"]
        self.assertTrue(all(p["t"] >= "2026-10-19T20:00:00Z" for p in one_day))
        d = self.get_json("/api/decisions?limit=3")
        self.assertEqual(len(d["decisions"]), 3)
        self.assertGreaterEqual(d["counts"]["skipped"], 1)
        n = self.get_json("/api/news?symbol=TSLA")
        self.assertTrue(all(i["symbol"] == "TSLA" for i in n["items"]))
        self.assertIn("TSLA", n["sentiment"])
        self.assertEqual(self.get_json("/api/news?kind=social")["items"][0]["kind"], "social")
        self.assertTrue(all(i["url"] == "" or i["url"].startswith("http") for i in self.get_json("/api/news")["items"]))
        self.assertEqual([r["name"] for r in self.get_json("/api/reports")["reports"]], ["scan-stock-20261020.html"])

    def test_trade_endpoint_with_chart(self):
        self.start()
        trades = self.get_json("/api/trades")["trades"]
        self.assertTrue(trades)
        aapl = [t for t in trades if t["symbol"] == "AAPL"][0]
        d = self.get_json("/api/trade/" + aapl["id"])
        self.assertEqual(d["trade"]["id"], aapl["id"])
        self.assertIsInstance(d["candles"], list)
        self.assertTrue(d["candles"], d.get("candles_error"))
        self.assertEqual(self.req("GET", "/api/trade/nope-nope")[0], 404)
        self.assertEqual(self.req("GET", "/api/trade/%3Cscript%3E")[0], 400)

    def test_reports_are_served_sandboxed_and_traversal_is_refused(self):
        self.start()
        code, hdrs, text = self.req("GET", "/reports/scan-stock-20261020.html")
        self.assertEqual(code, 200)
        self.assertIn("sandbox", hdrs.get("Content-Security-Policy", ""))
        for bad in ("/reports/../config.json", "/reports/..%2Fconfig.json", "/reports/%2e%2e/config.json",
                    "/reports/config.json", "/reports/x.txt", "/reports//etc/passwd", "/reports/.hidden.html",
                    "/reports/missing.html"):
            self.assertEqual(self.req("GET", bad)[0], 404, bad)

    def test_controls_need_csrf_same_origin_and_kill_confirmation(self):
        self.start()
        self.assertEqual(self.control({"action": "pause"}, csrf=False)[0], 403)
        self.assertEqual(self.req("POST", "/api/control", {"action": "pause"}, {"X-Trader-CSRF": "wrong"})[0], 403)
        self.assertEqual(self.control({"action": "pause"}, extra={"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.control({"action": "explode"})[0], 400)
        self.assertEqual(self.control("not json")[0], 400)
        code, _, text = self.control({"action": "kill"})
        self.assertEqual(code, 400)
        self.assertIn("KILL", text)
        self.assertEqual(self.control({"action": "kill", "confirm": "kill"})[0], 400)
        code, _, _ = self.control({"action": "pause"}, extra={"Origin": "http://127.0.0.1:%d" % self.port})
        self.assertEqual(code, 200)
        c = json.loads((self.home / "autopilot" / "control.json").read_text(encoding="utf-8"))
        self.assertEqual((c["paused"], c["kill"], c["by"]), (True, False, "dashboard"))
        self.assertEqual(self.control({"action": "kill", "confirm": "KILL"})[0], 200)
        c = json.loads((self.home / "autopilot" / "control.json").read_text(encoding="utf-8"))
        self.assertEqual((c["paused"], c["kill"]), (True, True))
        self.control({"action": "resume"})
        self.control({"action": "run_once"})
        c = json.loads((self.home / "autopilot" / "control.json").read_text(encoding="utf-8"))
        self.assertEqual((c["paused"], c["kill"], c["run_once"]), (False, False, True))
        self.assertTrue(c["updated_at"].endswith("Z"))
        self.assertTrue(self.get_json("/api/summary")["control"]["run_once"])


class Security(DashboardCase):
    def test_secrets_never_appear_in_any_response(self):
        for k, v in FAKE_SECRETS.items():
            os.environ[k] = v
        load("app", "devdata").generate(self.home)
        self.start(password=FAKE_SECRETS["TRADER_DASHBOARD_PASSWORD"])
        self.assertEqual(self.req("GET", "/api/summary")[0], 401)
        code, hdrs, _ = self.req("GET", "/")
        self.assertEqual((code, hdrs.get("Location")), (303, "/login"))
        code, _, text = self.req("POST", "/login", "password=wrong", {"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(code, 401)
        code, hdrs, _ = self.req("POST", "/login", "password=correct+horse+battery+7",
                                 {"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(code, 303)
        cookie = hdrs.get("Set-Cookie", "")
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        jar = {"Cookie": cookie.split(";", 1)[0]}
        bodies = [self.req("GET", "/", headers=jar)[2]]
        for ep in ENDPOINTS:
            code, _, text = self.req("GET", "/api/" + ep, headers=jar)
            self.assertEqual(code, 200, ep)
            bodies.append(text)
        summary = json.loads(bodies[1])
        self.assertTrue(summary["secrets"]["alpaca_paper"] and summary["secrets"]["x_token"])
        blob = "\n".join(bodies)
        for name, value in FAKE_SECRETS.items():
            self.assertNotIn(value, blob, name)
            self.assertNotIn(value[-6:], blob, name)  # not even a tail

    def test_non_loopback_without_password_refuses_to_start(self):
        server = load("app", "server")
        with self.assertRaises(server.StartupError):
            server.make_server("0.0.0.0", 0, "", False, None)
        self.assertTrue(server.is_loopback("127.0.0.1") and server.is_loopback("::1") and server.is_loopback("localhost"))
        self.assertFalse(server.is_loopback("192.168.1.20"))
        self.assertEqual(server.main(["--host", "0.0.0.0", "--port", "0", "--home", str(self.home)]), 2)


class Background(DashboardCase):
    def test_missing_autopilot_and_news_are_reported_not_fatal(self):
        app = self.start()
        with mock.patch.object(self.server_mod.skills, "load", side_effect=ImportError("not here")):
            self.assertIsNone(app._autopilot_module())
            self.assertFalse(app.refresh_news_async())
            code, _, text = self.req("POST", "/api/news/refresh", {}, {"X-Trader-CSRF": app.csrf})
        self.assertEqual(code, 200)
        self.assertFalse(json.loads(text)["ok"])
        self.assertIn("not installed", app.autopilot["last_error"])

    def test_autopilot_loop_calls_run_cycle_and_survives_errors(self):
        app = self.start()
        calls = []

        def run_cycle(**kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                raise RuntimeError("boom")
            app.stop()
        fake = types.SimpleNamespace(run_cycle=run_cycle)
        app.wake.set()
        with mock.patch.object(self.server_mod.skills, "load", return_value=fake), \
                mock.patch.object(app.wake, "wait", return_value=True):
            app.autopilot_loop()
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], {"approved": True})  # started by the user → standing approval
        self.assertIsNone(app.autopilot["last_error"])
        self.assertEqual(app.autopilot["runs"], 1)

    def test_news_refresh_calls_refresh_feed(self):
        app = self.start()
        called = []
        fake = types.SimpleNamespace(refresh_feed=lambda: called.append(1))
        with mock.patch.object(self.server_mod.skills, "load", return_value=fake):
            self.assertTrue(app.refresh_news())
        self.assertEqual(called, [1])
        self.assertEqual(app.news["runs"], 1)


class DevData(TraderTestCase):
    def test_sample_files_are_marked(self):
        load("app", "devdata").generate(self.home)
        for rel in ("autopilot/state.json", "news_feed.json", "x_usage.json"):
            self.assertTrue(json.loads((self.home / rel).read_text(encoding="utf-8"))["sample"], rel)
        rows = (self.home / "broker" / "equity.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertTrue(all(json.loads(r)["sample"] for r in rows))

    def test_help(self):
        code, out, _ = self.run_tool("app", "server", ["--help"])
        self.assertEqual(code, 0)
        self.assertIn("password", out)
