#!/usr/bin/env python3
"""The landing page's one dynamic part: the access list behind its form. Stdlib only.

Caddy serves the static page and passes POST /api/waitlist here (deploy/Caddyfile.example). Each sign-up keeps the
e-mail, the plan, whether the person has a server and when they agreed — no IP address, no tracking. A second
sign-up with the same e-mail updates the first.

    python3 site/server.py --data /var/lib/trader-site            # serve on 127.0.0.1:8770
    python3 site/server.py --data /var/lib/trader-site export     # the list as CSV, for the owner
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PLANS = ("sim", "start", "pro", "max")
EMAIL = re.compile(r"^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$")
MAX_BODY = 4096
PER_HOUR = 5  # sign-ups per client an hour: enough for a typo or two, not for a script
CONSENT = "Súhlasím, aby ste môj e-mail použili na zaslanie návodu a ponuky. Súhlas môžem kedykoľvek odvolať."
FILE = "waitlist.json"


class Store:
    def __init__(self, data: Path):
        self.path = data / FILE
        self.lock = threading.Lock()
        data.mkdir(parents=True, exist_ok=True)
        os.chmod(str(data), 0o700)

    def load(self) -> dict:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def add(self, row: dict) -> bool:
        """True for a new e-mail, False when an earlier sign-up was updated."""
        with self.lock:
            doc = self.load()
            key = row["email"].lower()
            new = key not in doc
            if not new:
                row["first_at"] = doc[key].get("first_at") or doc[key].get("at")
            doc[key] = row
            tmp = self.path.with_name(self.path.name + ".tmp")
            fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(doc, fh, ensure_ascii=False, indent=1)
            os.replace(str(tmp), str(self.path))
            return new


def check(body: dict):
    """(row, None) for a valid sign-up, (None, message) otherwise. Messages are for the person, in Slovak."""
    if not isinstance(body, dict):
        return None, "Nesprávny formát."
    email = str(body.get("email") or "").strip()
    if not EMAIL.match(email):
        return None, "Skontroluj e-mail."
    if body.get("consent") is not True:
        return None, "Bez súhlasu nemôžeme poslať návod ani ponuku."
    plan = str(body.get("plan") or "sim")
    if plan not in PLANS:
        return None, "Neznámy plán."
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return {"email": email, "plan": plan, "has_server": bool(body.get("has_server")), "at": now,
            "first_at": now, "consent": CONSENT}, None


def make_server(host: str, port: int, store: Store) -> ThreadingHTTPServer:
    hits, hits_lock = {}, threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        server_version = "trader-site"
        sys_version = ""

        def log_message(self, fmt, *args):  # no addresses in the logs
            pass

        def _json(self, code: int, obj: dict):
            raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)

        def _client(self) -> str:
            # behind Caddy on this machine the real client is in X-Forwarded-For; anyone else is who they are
            ip = self.client_address[0]
            fwd = self.headers.get("X-Forwarded-For", "")
            if ip in ("127.0.0.1", "::1") and fwd:
                ip = fwd.split(",")[-1].strip()
            return ip

        def do_GET(self):
            if self.path == "/healthz":
                return self._json(200, {"ok": True})
            return self._json(404, {"ok": False, "error": "not found"})

        def do_POST(self):
            if self.path.split("?")[0] != "/api/waitlist":
                return self._json(404, {"ok": False, "error": "not found"})
            if "application/json" not in (self.headers.get("Content-Type") or ""):
                return self._json(415, {"ok": False, "error": "Nesprávny formát."})
            try:
                size = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                size = MAX_BODY + 1
            if size <= 0 or size > MAX_BODY:
                return self._json(413, {"ok": False, "error": "Príliš veľa údajov."})
            who, now = self._client(), time.time()
            with hits_lock:
                recent = [t for t in hits.get(who, []) if now - t < 3600]
                if len(recent) >= PER_HOUR:
                    hits[who] = recent
                    return self._json(429, {"ok": False, "error": "Priveľa pokusov, skús to o hodinu."})
                hits[who] = recent + [now]
                if len(hits) > 10000:  # a long-running server forgets old clients
                    for k in [k for k, v in hits.items() if not v or now - v[-1] > 3600]:
                        del hits[k]
            try:
                body = json.loads(self.rfile.read(size).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return self._json(400, {"ok": False, "error": "Nesprávny formát."})
            row, err = check(body)
            if err:
                return self._json(400, {"ok": False, "error": err})
            new = store.add(row)
            return self._json(200, {"ok": True, "new": new})

    return ThreadingHTTPServer((host, port), Handler)


def export(store: Store, out=sys.stdout) -> int:
    rows = sorted(store.load().values(), key=lambda r: r.get("first_at") or "")
    w = csv.writer(out)
    w.writerow(["email", "plan", "has_server", "first_at", "at"])
    for r in rows:
        w.writerow([r.get("email"), r.get("plan"), "yes" if r.get("has_server") else "no", r.get("first_at"), r.get("at")])
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("action", nargs="?", default="serve", choices=("serve", "export"))
    ap.add_argument("--data", default=os.environ.get("TRADER_SITE_DATA", "/var/lib/trader-site"))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8770)
    args = ap.parse_args(argv)
    store = Store(Path(args.data))
    if args.action == "export":
        return export(store)
    httpd = make_server(args.host, args.port, store)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
