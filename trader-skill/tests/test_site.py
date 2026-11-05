"""The landing page: the access list behind its form keeps only what a sign-up needs, and the page tracks nobody."""
from __future__ import annotations

import csv
import http.client
import io
import json
import os
import stat
import threading
from pathlib import Path

from tests.helpers import TraderTestCase, load

SITE = Path(__file__).resolve().parent.parent / "site"


class Form(TraderTestCase):
    def setUp(self):
        super().setUp()
        self.mod = load("site", "server")
        self.store = self.mod.Store(self.tmp / "site")

    def test_what_a_sign_up_needs(self):
        ok, err = self.mod.check({"email": "jana@example.sk", "plan": "pro", "has_server": True, "consent": True})
        self.assertIsNone(err)
        self.assertEqual((ok["email"], ok["plan"], ok["has_server"]), ("jana@example.sk", "pro", True))
        self.assertNotIn("ip", ok)
        for bad in ({"email": "jana", "consent": True}, {"email": "jana@example.sk"},
                    {"email": "jana@example.sk", "plan": "gold", "consent": True}, ["jana@example.sk"]):
            self.assertIsNone(self.mod.check(bad)[0], bad)

    def test_the_same_email_updates_its_first_sign_up(self):
        row = self.mod.check({"email": "Jana@Example.sk", "plan": "sim", "consent": True})[0]
        self.assertTrue(self.store.add(row))
        again = self.mod.check({"email": "jana@example.sk", "plan": "max", "consent": True})[0]
        self.assertFalse(self.store.add(again))
        doc = self.store.load()
        self.assertEqual(list(doc), ["jana@example.sk"])
        self.assertEqual(doc["jana@example.sk"]["plan"], "max")
        self.assertEqual(stat.S_IMODE(os.stat(str(self.store.path)).st_mode), 0o600)
        out = io.StringIO()
        self.mod.export(self.store, out)
        rows = list(csv.reader(io.StringIO(out.getvalue())))
        self.assertEqual(rows[0], ["email", "plan", "has_server", "first_at", "at"])
        self.assertEqual(rows[1][:3], ["jana@example.sk", "max", "no"])

    def test_the_endpoint(self):
        httpd = self.mod.make_server("127.0.0.1", 0, self.store)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (httpd.shutdown(), httpd.server_close()))
        port = httpd.server_address[1]

        def post(body, ctype="application/json", fwd="203.0.113.7"):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            raw = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
            conn.request("POST", "/api/waitlist", body=raw, headers={"Content-Type": ctype, "X-Forwarded-For": fwd})
            r = conn.getresponse()
            out = (r.status, json.loads(r.read().decode("utf-8")))
            conn.close()
            return out

        good = {"email": "peter@example.sk", "plan": "start", "consent": True}
        self.assertEqual(post(good), (200, {"ok": True, "new": True}))
        self.assertEqual(post(good)[1]["new"], False)
        self.assertEqual(post({"email": "x", "consent": True})[0], 400)
        self.assertEqual(post(good, ctype="text/plain")[0], 415)
        self.assertEqual(post(b"{" + b" " * 5000 + b"}")[0], 413)
        codes = [post(good)[0] for _ in range(3)]
        self.assertEqual(codes[-1], 429)  # five an hour from one client
        self.assertEqual(post(good, fwd="198.51.100.9")[0], 200)  # another client behind the same Caddy
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        conn.request("GET", "/healthz")
        self.assertEqual(conn.getresponse().status, 200)
        conn.close()


class Page(TraderTestCase):
    def test_prices_form_and_no_tracking(self):
        html = (SITE / "index.html").read_text(encoding="utf-8")
        self.assertTrue(html.startswith("<!doctype html>"))
        for price in ('data-m="19"', 'data-m="39"', 'data-m="79"', "190 € raz ročne", "390 € raz ročne", "790 € raz ročne"):
            self.assertIn(price, html)
        self.assertIn("fetch('api/waitlist'", html)
        self.assertIn("Upozornenie na riziko", html)
        for tracker in ("gtag(", "googletagmanager", "fbq(", "connect.facebook.net", "analytics"):
            self.assertNotIn(tracker, html)
        for img in ("graf-denny.jpg", "pozicia.jpg", "kontrola.jpg", "logo.svg"):
            self.assertTrue((SITE / "img" / img).is_file(), img)
        unit = (SITE.parent / "deploy" / "trader-site.service").read_text(encoding="utf-8")
        self.assertIn("InaccessiblePaths=-/var/lib/trader -/var/lib/trader-test -/etc/trader", unit)
        self.assertNotIn("EnvironmentFile", unit)
