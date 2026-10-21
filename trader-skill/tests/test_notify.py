"""Notifications: logged always, sent only when enabled, never offline, never leaking a token."""
from __future__ import annotations

import io
import json
import os
import urllib.error
from unittest import mock

from tests.helpers import TraderTestCase
from shared import config, notify

TOKEN = "123456789:AAF-secret-telegram-token_xyz"


class Resp(io.BytesIO):
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class Notify(TraderTestCase):
    NOW = "2026-10-20T15:00:00Z"

    def setUp(self):
        super().setUp()
        self.calls = []

    def online(self):
        os.environ.pop("TRADER_OFFLINE", None)

    def cfg(self, **n):
        self.write_state("config.json", {"notify": n})
        return config.load_config()

    def fake(self, fail=None):
        def urlopen(req, timeout=0):
            self.calls.append({"url": req.full_url, "headers": {k.lower(): v for k, v in req.header_items()},
                               "body": req.data.decode("utf-8"), "timeout": timeout})
            if fail:
                raise fail
            return Resp(b"{}")
        return mock.patch("urllib.request.urlopen", urlopen)

    def log(self):
        p = self.home / "notifications.jsonl"
        return [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines()] if p.exists() else []

    def test_disabled_is_logged_not_sent(self):
        self.online()
        with self.fake():
            rec = notify.send("trade_opened", "NVDA bought", "32 @ 194.49", self.cfg(ntfy_topic="t"))
        self.assertEqual(self.calls, [])
        self.assertEqual(rec["channels"], {"ntfy": "off", "telegram": "off"})
        self.assertEqual(self.log()[0]["title"], "NVDA bought")

    def test_offline_never_sends(self):
        with self.fake():
            rec = notify.send("kill", "KILLED", "daily loss", self.cfg(enabled=True, ntfy_topic="t", telegram=True))
        self.assertEqual(self.calls, [])
        self.assertEqual(rec["channels"], {"ntfy": "offline — not sent", "telegram": "offline — not sent"})

    def test_ntfy_request_shape(self):
        self.online()
        os.environ["NTFY_TOKEN"] = "tk_ntfy_secret_99"
        cfg = self.cfg(enabled=True, ntfy_topic="trader-x9f2k", ntfy_server="https://ntfy.example.com/")
        with self.fake():
            rec = notify.send("trade_closed", "NVDA closed +0.80R", "P&L +$75.52", cfg, priority="high")
        c = self.calls[0]
        self.assertEqual(c["url"], "https://ntfy.example.com/trader-x9f2k")
        self.assertEqual(c["body"], "P&L +$75.52")
        self.assertEqual((c["headers"]["title"], c["headers"]["priority"]), ("NVDA closed +0.80R", "high"))
        self.assertEqual(c["headers"]["authorization"], "Bearer tk_ntfy_secret_99")
        self.assertEqual(c["timeout"], 10)
        self.assertEqual(rec["channels"], {"ntfy": "sent", "telegram": "off"})
        self.assertNotIn("tk_ntfy_secret_99", (self.home / "notifications.jsonl").read_text(encoding="utf-8"))

    def test_non_latin_title_is_encoded(self):
        self.online()
        with self.fake():
            notify.send("trade_opened", "Kúpil som NVDA — 32 ks", "ok", self.cfg(enabled=True, ntfy_topic="t"))
        self.assertTrue(self.calls[0]["headers"]["title"].startswith("=?UTF-8?B?"))

    def test_telegram_token_never_leaks(self):
        self.online()
        os.environ["TELEGRAM_BOT_TOKEN"] = TOKEN
        os.environ["TELEGRAM_CHAT_ID"] = "4242"
        cfg = self.cfg(enabled=True, telegram=True)
        with self.fake():
            rec = notify.send("daily_summary", "Day done", "+$120", cfg)
        self.assertEqual(rec["channels"]["telegram"], "sent")
        self.assertEqual(self.calls[0]["url"], "https://api.telegram.org/bot%s/sendMessage" % TOKEN)
        self.assertEqual(json.loads(self.calls[0]["body"])["chat_id"], "4242")
        err = urllib.error.URLError("cannot reach https://api.telegram.org/bot%s/sendMessage" % TOKEN)
        with self.fake(fail=err):
            rec = notify.send("daily_summary", "Day done 2", "+$1", cfg)
        self.assertTrue(rec["channels"]["telegram"].startswith("error:"))
        self.assertNotIn(TOKEN, json.dumps(rec))
        self.assertNotIn("AAF-secret", (self.home / "notifications.jsonl").read_text(encoding="utf-8"))
        os.environ.pop("TELEGRAM_BOT_TOKEN")
        with self.fake():
            rec = notify.send("daily_summary", "Day done 3", "+$1", cfg)
        self.assertIn("not configured", rec["channels"]["telegram"])

    def test_events_filter_error_dedup_and_hourly_cap(self):
        self.online()
        cfg = self.cfg(enabled=True, ntfy_topic="t", events=["error", "trade_opened"], max_per_hour=3)
        with self.fake():
            r = notify.send("learned", "paused orb15", "x", cfg)
            self.assertIn("not in notify.events", r["suppressed"])
            notify.send("error", "data source down", "x", cfg)
            self.set_now("2026-10-20T15:20:00Z")
            r = notify.send("error", "data source down", "x", cfg)
            self.assertIn("same error", r["suppressed"])
            self.set_now("2026-10-20T15:40:00Z")
            r = notify.send("error", "data source down", "x", cfg)  # 40 min after the first: sent again
            self.assertEqual(r["channels"]["ntfy"], "sent")
            notify.send("trade_opened", "A", "x", cfg)
            r = notify.send("trade_opened", "B", "x", cfg)
            self.assertIn("hourly cap", r["suppressed"])
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(len(self.log()), 6)

    def test_send_never_raises(self):
        self.online()
        with self.fake(fail=RuntimeError("boom")):
            rec = notify.send("trade_opened", "x", "y", self.cfg(enabled=True, ntfy_topic="t"))
        self.assertTrue(rec["channels"]["ntfy"].startswith("error:"))
        with mock.patch.object(notify.state, "append_jsonl", side_effect=ValueError("disk")), \
                mock.patch.object(notify, "_settings", side_effect=KeyError("bad config")):
            rec = notify.send("trade_opened", "x", "y", {})
        self.assertIn("error", rec)

    def test_test_message_ignores_the_events_list(self):
        self.online()
        cfg = self.cfg(enabled=True, ntfy_topic="t", events=[])
        with self.fake():
            rec = notify.test(cfg)
        self.assertEqual(rec["channels"]["ntfy"], "sent")
        self.assertIn("can reach you (ntfy)", self.calls[0]["body"])
        rec = notify.test(self.cfg(ntfy_topic="t"))
        self.assertIn("notify.enabled is false", rec["hint"])
