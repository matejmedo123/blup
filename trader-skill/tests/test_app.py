"""Dashboard server: every endpoint, security rules (secrets, CSRF, path traversal, auth), controls."""
from __future__ import annotations

import http.client
import json
import os
import threading
import types
from pathlib import Path
from unittest import mock

from tests.helpers import TraderTestCase, load

ENDPOINTS = ("summary", "equity", "equity?range=1d", "positions", "orders", "trades", "trades?status=closed",
             "decisions", "news", "news?kind=social", "setups", "reports", "desk", "control", "system")
FAKE_SECRETS = {
    "ALPACA_PAPER_KEY_ID": "PKFAKEPAPERKEY0001", "ALPACA_PAPER_SECRET_KEY": "paper-secret-zz9-plural-z-alpha",
    "ALPACA_LIVE_KEY_ID": "AKFAKELIVEKEY0002", "ALPACA_LIVE_SECRET_KEY": "live-secret-do-not-leak-4242",
    "X_BEARER_TOKEN": "AAAAfake-x-bearer-token-9876543210", "TRADER_DASHBOARD_PASSWORD": "correct horse battery 7",
    "TELEGRAM_BOT_TOKEN": "123456:fake-telegram-bot-token-abc", "TELEGRAM_CHAT_ID": "987654321012",
    "NTFY_TOKEN": "tk_fakentfytoken-w8y3qv", "ANTHROPIC_API_KEY": "sk-ant-fake-key-do-not-leak-q7zx",
}
NTFY_TOPIC = "trader-alerts-k3v9x2m8q7w1z5"


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

    def test_v3_views_have_sensible_empty_states(self):
        self.start()
        d = self.get_json("/api/system")
        self.assertEqual(d["health"]["state"], "never")
        self.assertIsNone(d["health"]["at"])
        self.assertFalse(d["universe"]["available"])
        self.assertEqual(d["universe"]["assets"], {})
        self.assertEqual(d["universe"]["mode"], "auto")  # config default
        self.assertFalse(d["adapt"]["available"])
        self.assertEqual((d["adapt"]["risk_mult"], d["adapt"]["setups"], d["adapt"]["drawdown_pause"]), (1.0, [], False))
        self.assertEqual(d["notify"]["recent"], [])
        self.assertFalse(d["notify"]["enabled"] or d["notify"]["ntfy"]["configured"])
        self.assertFalse(d["ai"]["enabled"] or d["ai"]["ready"] or d["ai"]["key"])
        self.assertEqual((d["ai"]["today"]["calls"], d["ai"]["recent"]), (0, []))
        self.assertEqual(d["sessions"]["crypto"]["label"], "open 24/7")
        s = self.get_json("/api/summary")
        self.assertEqual(s["health"]["state"], "never")
        self.assertEqual(s["universe_counts"], {})
        self.assertFalse(s["learned"]["available"])

    def test_broken_v3_files_do_not_break_the_page(self):
        ap = self.home / "autopilot"
        ap.mkdir(parents=True, exist_ok=True)
        for name in ("heartbeat.json", "universe.json", "adapt.json", "scan.json"):
            (ap / name).write_text("{not json", encoding="utf-8")
        (self.home / "ai_usage.json").write_text("[1, 2]", encoding="utf-8")
        (self.home / "notifications.jsonl").write_text("garbage\n{\"event\": \"started\", \"title\": \"ok\"}\n",
                                                       encoding="utf-8")
        self.start()
        d = self.get_json("/api/system")
        self.assertEqual(d["health"]["state"], "never")
        self.assertFalse(d["universe"]["available"])
        self.assertEqual([r["title"] for r in d["notify"]["recent"]], ["ok"])

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


class V3Views(DashboardCase):
    NOW = "2026-10-20T14:00:00Z"  # Tuesday 10:00 a.m. ET — regular session

    def beat(self, **fields):
        hb = {"at": "2026-10-20T13:59:30Z", "pid": 99999, "host": "elsewhere", "runner": "daemon", "cycle": 7,
              "status": "running", "interval_sec": 60}
        hb.update(fields)
        p = self.home / "autopilot" / "heartbeat.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(hb), encoding="utf-8")

    def health(self):
        return load("app", "server").health_view()

    def test_heartbeat_alive_stale_stopped(self):
        self.beat()
        h = self.health()
        self.assertEqual((h["state"], h["age_sec"], h["stale_after_sec"]), ("alive", 30, 180))
        self.beat(at="2026-10-20T13:57:01Z")  # 179 s
        self.assertEqual(self.health()["state"], "alive")
        self.beat(at="2026-10-20T13:56:59Z")  # 181 s > max(180, 3 × 60)
        self.assertEqual(self.health()["state"], "stale")
        self.beat(at="2026-10-20T13:50:00Z", interval_sec=300)  # 600 s < 3 × 300
        self.assertEqual(self.health()["state"], "alive")
        self.beat(at="2026-10-20T13:30:00Z", interval_sec=300)
        self.assertEqual(self.health()["state"], "stale")
        self.beat(status="stopped")
        self.assertEqual(self.health()["state"], "stopped")
        self.beat(at="not a time")
        self.assertEqual(self.health()["state"], "stale")

    def test_dashboard_loop_defers_to_a_live_daemon(self):
        app = self.start()
        self.beat()
        self.assertTrue(app.daemon_active())
        self.beat(at="2026-10-20T13:00:00Z")
        self.assertFalse(app.daemon_active())  # stale daemon → the dashboard may trade again
        self.beat(runner="dashboard")
        self.assertFalse(app.daemon_active())
        calls = []
        self.beat()
        fake = types.SimpleNamespace(run_cycle=lambda **kw: calls.append(kw))
        with mock.patch.object(self.server_mod.skills, "load", return_value=fake), \
                mock.patch.object(app.wake, "wait", side_effect=lambda *_: app.stop_event.set()):
            app.autopilot_loop()
        self.assertEqual(calls, [])
        self.assertTrue(app.autopilot["deferred_to_daemon"])

    def test_sessions_regular_hours_only(self):
        srv = load("app", "server")
        s = srv.sessions_view()
        self.assertEqual(s["crypto"], {"enabled": True, "state": "open", "label": "open 24/7", "bot_trading": True})
        st = s["stock"]
        self.assertEqual(st["state"], "open")
        self.assertTrue(st["bot_trading"])
        self.assertEqual(st["entries_until"], "2026-10-20T19:30:00Z")  # 3:30 p.m. ET
        self.assertEqual(st["closes_at"], "2026-10-20T20:00:00Z")
        self.assertEqual(st["next_change"], st["closes_at"])
        os.environ["TRADER_NOW"] = "2026-10-20T19:45:00Z"  # 3:45 p.m. ET: open, but no new entries
        st = srv.sessions_view()["stock"]
        self.assertEqual(st["state"], "open")
        self.assertFalse(st["bot_trading"])
        self.assertIn("exits only", st["label"])
        os.environ["TRADER_NOW"] = "2026-10-20T11:00:00Z"  # 7 a.m. ET
        st = srv.sessions_view()["stock"]
        self.assertEqual((st["state"], st["bot_trading"]), ("pre-market", False))
        self.assertEqual(st["next_change"], "2026-10-20T13:30:00Z")
        os.environ["TRADER_NOW"] = "2026-10-24T15:00:00Z"  # Saturday
        st = srv.sessions_view()["stock"]
        self.assertTrue(st["weekend"])
        self.assertEqual((st["state"], st["label"], st["next_open"]), ("closed", "closed — weekend", "2026-10-26T13:30:00Z"))
        (self.home / "config.json").write_text(json.dumps({"autopilot": {"assets": ["crypto"]}}), encoding="utf-8")
        os.environ["TRADER_NOW"] = "2026-10-20T14:00:00Z"
        s = srv.sessions_view()
        self.assertFalse(s["stock"]["enabled"] or s["stock"]["bot_trading"])
        self.assertTrue(s["crypto"]["bot_trading"])

    def test_sample_v3_data_is_shaped_for_the_ui(self):
        load("app", "devdata").generate(self.home, "2026-10-20T19:30:00Z")
        os.environ["TRADER_NOW"] = "2026-10-20T19:30:00Z"
        self.start()
        d = self.get_json("/api/system")
        self.assertEqual((d["health"]["state"], d["health"]["runner"]), ("alive", "daemon"))
        u = d["universe"]
        self.assertTrue(u["available"])
        self.assertEqual(u["mode"], "auto")
        self.assertGreaterEqual(u["assets"]["stock"]["count"], 20)
        self.assertEqual(u["assets"]["stock"]["symbols"][0], {"symbol": "NVDA", "reason": "watchlist"})
        self.assertIn({"symbol": "USDCUSDT", "reason": "stablecoin"}, u["excluded"])
        self.assertEqual(u["scan"]["crypto"]["pct"], 100.0)
        self.assertLess(u["scan"]["stock"]["done"], u["scan"]["stock"]["total"])
        self.assertTrue(u["scan"]["stock"]["bar"].endswith("Z"))
        a = d["adapt"]
        self.assertEqual((a["paused_setups"], a["cooling"], a["risk_mult"]), (1, 1, 0.5))
        self.assertEqual(a["setups"][0]["key"], "crypto:asia_range")  # what sits out comes first
        self.assertEqual(a["events"][0]["kind"], "risk_reduced")  # newest first
        self.assertEqual(d["ai"]["today"]["calls"], 6)
        self.assertEqual(d["ai"]["recent"][0]["status"], "NO-GO")
        self.assertEqual(d["notify"]["recent"][0]["event"], "trade_closed")  # newest first
        s = self.get_json("/api/summary")
        self.assertEqual(s["universe_counts"]["crypto"], 12)
        self.assertEqual(s["learned"]["risk_mult"], 0.5)
        self.assertIn("news_gate", s["autopilot_config"])
        reasons = [r for x in self.get_json("/api/decisions")["decisions"] for r in x["reasons"]]
        self.assertTrue(any(r.startswith("AI desk") for r in reasons))
        self.assertTrue(any(r.startswith("learned:") for r in reasons))

    def test_resume_writes_dd_reset_at_and_pause_keeps_it(self):
        self.start()
        self.assertEqual(self.control({"action": "pause"})[0], 200)
        c = json.loads((self.home / "autopilot" / "control.json").read_text(encoding="utf-8"))
        self.assertNotIn("dd_reset_at", c)
        self.assertEqual(self.control({"action": "resume"})[0], 200)
        c = json.loads((self.home / "autopilot" / "control.json").read_text(encoding="utf-8"))
        self.assertEqual(c["dd_reset_at"], "2026-10-20T14:00:00Z")
        self.assertFalse(c["paused"])
        os.environ["TRADER_NOW"] = "2026-10-20T15:00:00Z"
        self.control({"action": "pause"})
        self.control({"action": "run_once"})
        c = json.loads((self.home / "autopilot" / "control.json").read_text(encoding="utf-8"))
        self.assertEqual(c["dd_reset_at"], "2026-10-20T14:00:00Z")  # only a resume moves the baseline
        self.assertEqual(self.get_json("/api/control")["dd_reset_at"], "2026-10-20T14:00:00Z")

    def test_reverse_proxy_without_password_is_refused(self):
        self.start()
        for hdr in ({"X-Forwarded-For": "203.0.113.9"}, {"Forwarded": "for=203.0.113.9"}, {"X-Real-IP": "203.0.113.9"}):
            code, _, text = self.req("GET", "/api/summary", headers=hdr)
            self.assertEqual(code, 403, hdr)
            self.assertIn("TRADER_DASHBOARD_PASSWORD", text)
            self.assertEqual(self.req("POST", "/api/control", {"action": "pause"},
                                     dict(hdr, **{"X-Trader-CSRF": self.app.csrf}))[0], 403)
        self.assertEqual(self.req("GET", "/api/summary")[0], 200)  # SSH tunnel / local browser: no proxy headers

    def test_reverse_proxy_with_password_works_and_cookie_is_secure(self):
        self.start(password="hunter2-but-longer")
        hdr = {"X-Forwarded-For": "203.0.113.9", "X-Forwarded-Proto": "https",
               "Content-Type": "application/x-www-form-urlencoded"}
        code, hdrs, _ = self.req("POST", "/login", "password=hunter2-but-longer", hdr)
        self.assertEqual(code, 303)
        self.assertIn("; Secure", hdrs.get("Set-Cookie", ""))
        jar = {"Cookie": hdrs["Set-Cookie"].split(";", 1)[0], "X-Forwarded-For": "203.0.113.9"}
        self.assertEqual(self.req("GET", "/api/system", headers=jar)[0], 200)
        code, hdrs, _ = self.req("POST", "/login", "password=hunter2-but-longer",
                                 {"Content-Type": "application/x-www-form-urlencoded"})
        self.assertNotIn("Secure", hdrs.get("Set-Cookie", ""))  # plain http on loopback


class LabView(DashboardCase):
    def test_no_lab_yet(self):
        v = load("app", "server").lab_view()
        self.assertEqual((v["available"], v["playbook"], v["required"]), (False, None, True))

    def test_playbook_and_last_run(self):
        e = {"symbol": "BTCUSDT", "display": "BTC/USDT", "setup": "oversold_bounce", "interval": "1h",
             "exit_text": "1R target · 3×ATR stop · 24h",
             "test": {"n": 45, "win_rate": 0.62, "expectancy_r": 0.14, "profit_chance": 0.91, "profit_factor": 1.6}}
        weak = dict(e, symbol="ETHUSDT", display="ETH/USDT", test=dict(e["test"], profit_chance=0.6))
        self.write_state("backtests/playbook.json", {"generated_at": "2026-10-20T00:00:00Z",
                                                     "valid_until": "2026-11-03T00:00:00Z",
                                                     "entries": {"BTCUSDT:oversold_bounce@1h": e,
                                                                 "ETHUSDT:oversold_bounce@1h": weak}})
        self.write_state("backtests/lab-crypto.json", {
            "generated_at": "2026-10-20T00:00:00Z", "universe": "top 30", "timeframes": ["5m", "1h", "4h"],
            "costs": {"round_trip_pct": 0.26}, "summary": {"families": 14, "families_validated": 1,
                                                           "per_coin_survival_rate": 0.26},
            "families": [{"setup": "oversold_bounce", "timeframe": "1h", "validated": True, "verdict": "held",
                          "exit": {"text": "1R target"}, "train": {"win_rate": 0.6, "expectancy_r": 0.1},
                          "test": {"win_rate": 0.62, "expectancy_r": 0.14, "profit_chance": 0.9},
                          "highest_win": {"exit": {"text": "0.5R"}, "test": {"win_rate": 0.7, "expectancy_r": -0.1}}}]})
        v = load("app", "server").lab_view()
        self.assertTrue(v["available"])
        mults = {x["display"]: x["risk_mult"] for x in v["playbook"]["entries"]}
        self.assertEqual(mults, {"BTC/USDT": 2.0, "ETH/USDT": 0.5})
        self.assertEqual(v["highest_win"][0]["edge_test"], -0.1)
        self.assertIn("lab", load("app", "server").system_view())


class Security(DashboardCase):
    def test_secrets_never_appear_in_any_response(self):
        for k, v in FAKE_SECRETS.items():
            os.environ[k] = v
        load("app", "devdata").generate(self.home)
        (self.home / "config.json").write_text(json.dumps({
            "notify": {"enabled": True, "ntfy_topic": NTFY_TOPIC, "telegram": True},
            "ai_desk": {"enabled": True}}), encoding="utf-8")
        # a sloppy notifier that logged a URL with the bot token must still not leak it through the dashboard
        with open(str(self.home / "notifications.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps({"at": "2026-10-20T19:00:00Z", "event": "error", "title": "telegram failed",
                                "text": "POST https://api.telegram.org/bot%s/sendMessage → 401 (topic %s)"
                                        % (FAKE_SECRETS["TELEGRAM_BOT_TOKEN"], NTFY_TOPIC),
                                "channels": {"telegram": "error: bot%s" % FAKE_SECRETS["TELEGRAM_BOT_TOKEN"]}}) + "\n")
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
        self.assertTrue(summary["secrets"]["telegram"] and summary["secrets"]["anthropic"] and summary["secrets"]["ntfy_token"])
        system = json.loads(bodies[1 + ENDPOINTS.index("system")])
        self.assertTrue(system["notify"]["ntfy"]["configured"] and system["notify"]["telegram"]["bot_token"])
        self.assertTrue(system["ai"]["key"])
        self.assertIn("[redacted]", json.dumps(system["notify"]["recent"]))
        blob = "\n".join(bodies)
        for name, value in list(FAKE_SECRETS.items()) + [("ntfy topic", NTFY_TOPIC)]:
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
        self.assertEqual(calls[0], {"approved": True, "runner": "dashboard"})  # started by the user → standing approval
        self.assertIsNone(app.autopilot["last_error"])
        self.assertEqual(app.autopilot["runs"], 1)

    def test_old_run_cycle_without_runner_still_works(self):
        app = self.start()
        calls = []

        def run_cycle(now=None, approved=None):
            calls.append(approved)
            app.stop()
        with mock.patch.object(self.server_mod.skills, "load", return_value=types.SimpleNamespace(run_cycle=run_cycle)), \
                mock.patch.object(app.wake, "wait", return_value=True):
            app.autopilot_loop()
        self.assertEqual(calls, [True])
        self.assertIsNone(app.autopilot["last_error"])

    def test_no_autopilot_flag_beats_config(self):
        server = load("app", "server")
        self.home.mkdir(parents=True, exist_ok=True)
        (self.home / "config.json").write_text(json.dumps({"autopilot": {"enabled": True}}), encoding="utf-8")
        seen = {}

        def fake_make_server(host, port, password, run_ap, news_every):
            seen["run_ap"] = run_ap
            raise server.StartupError("stop here")
        with mock.patch.object(server, "make_server", fake_make_server):
            self.assertEqual(server.main(["--home", str(self.home), "--no-autopilot", "--port", "0"]), 2)
            self.assertFalse(seen["run_ap"])
            self.assertEqual(server.main(["--home", str(self.home), "--port", "0"]), 2)
            self.assertTrue(seen["run_ap"])

    def test_news_loop_leaves_the_feed_to_a_live_daemon(self):
        app = self.start()
        hb = {"at": "2026-10-20T19:29:30Z", "pid": 1, "host": "other", "runner": "daemon", "status": "running",
              "interval_sec": 60}
        (self.home / "autopilot").mkdir(parents=True, exist_ok=True)
        (self.home / "autopilot" / "heartbeat.json").write_text(json.dumps(hb), encoding="utf-8")
        os.environ["TRADER_NOW"] = "2026-10-20T19:30:00Z"
        called = []
        fake = types.SimpleNamespace(refresh_feed=lambda: called.append(1))
        with mock.patch.object(self.server_mod.skills, "load", return_value=fake), \
                mock.patch.object(app.stop_event, "wait", side_effect=lambda *_: app.stop_event.set()):
            app.news_loop()
        self.assertEqual(called, [])
        self.assertTrue(app.news["deferred_to_daemon"])

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
        for rel in ("autopilot/state.json", "news_feed.json", "x_usage.json", "autopilot/heartbeat.json",
                    "autopilot/universe.json", "autopilot/scan.json", "autopilot/adapt.json", "ai_usage.json"):
            self.assertTrue(json.loads((self.home / rel).read_text(encoding="utf-8"))["sample"], rel)
        for rel in ("broker/equity.jsonl", "notifications.jsonl"):
            rows = (self.home / rel).read_text(encoding="utf-8").splitlines()
            self.assertTrue(rows and all(json.loads(r)["sample"] for r in rows), rel)

    def test_help(self):
        code, out, _ = self.run_tool("app", "server", ["--help"])
        self.assertEqual(code, 0)
        self.assertIn("password", out)


class Deploy(TraderTestCase):
    """The VPS kit: stops wait for the running cycle, the dashboard never trades twice, no real env file."""
    ROOT = Path(__file__).resolve().parent.parent / "deploy"

    def text(self, name):
        return (self.ROOT / name).read_text(encoding="utf-8")

    def test_units_and_compose_give_the_daemon_time_to_finish_its_cycle(self):
        ap = self.text("trader-autopilot.service")
        for line in ("KillSignal=SIGTERM", "TimeoutStopSec=120", "Restart=always", "User=trader",
                     "ProtectSystem=strict", "ReadWritePaths=/var/lib/trader", "NoNewPrivileges=true",
                     "EnvironmentFile=/etc/trader/trader.env", "autopilot.py daemon --approve"):
            self.assertIn(line, ap)
        dash = self.text("trader-dashboard.service")
        self.assertIn("--host 127.0.0.1", dash)
        self.assertIn("--no-autopilot --news-every 0", dash)
        compose = self.text("docker-compose.yml")
        self.assertIn("stop_grace_period: 2m", compose)
        self.assertIn('"127.0.0.1:8765:8765"', compose)
        self.assertIn('"--no-autopilot", "--news-every", "0"', compose)
        self.assertIn("env_file: trader.env", compose)

    def test_no_real_env_file_and_examples_are_empty(self):
        self.assertFalse((self.ROOT / "trader.env").exists(), "a real deploy/trader.env must never be in the tree")
        for line in self.text("trader.env.example").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                self.assertTrue(line.endswith("="), "placeholder with a value: %s" % line)
        self.assertIn("trader.env", self.text(".gitignore"))

    def test_shell_scripts_parse(self):
        import shutil
        import subprocess
        bash = shutil.which("bash")
        if not bash:
            self.skipTest("bash not available")
        for name in ("install-vps.sh", "traderctl"):
            r = subprocess.run([bash, "-n", str(self.ROOT / name)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(r.returncode, 0, r.stderr)

    def test_healthcheck_matches_the_dashboard_rule(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("trader_healthcheck", str(self.ROOT / "healthcheck.py"))
        hc = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hc)
        from datetime import datetime, timezone
        now = datetime(2026, 10, 20, 14, 0, tzinfo=timezone.utc)
        ap = self.home / "autopilot"
        ap.mkdir(parents=True, exist_ok=True)
        self.assertFalse(hc.check(self.home, now)[0])  # no heartbeat yet

        def beat(at, **kw):
            hb = {"at": at, "interval_sec": 60, "status": "running", "runner": "daemon", "cycle": 1}
            hb.update(kw)
            (ap / "heartbeat.json").write_text(json.dumps(hb), encoding="utf-8")
            return hc.check(self.home, now)[0]
        self.assertTrue(beat("2026-10-20T13:57:01Z"))
        self.assertFalse(beat("2026-10-20T13:56:59Z"))
        self.assertTrue(beat("2026-10-20T13:50:00Z", interval_sec=300))
        self.assertFalse(beat("2026-10-20T13:59:59Z", status="stopped"))
        self.assertEqual(hc.main(["--home", str(self.home), "--quiet"]), 1)  # real clock: 2026-10-20 is long gone
