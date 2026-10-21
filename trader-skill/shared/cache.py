"""Tiny file cache for HTTP responses, so repeated runs don't hammer free APIs."""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

from . import config


class FileCache:
    def __init__(self, root: Path = None):
        self.root = Path(root) if root else config.ensure_home() / "cache" / "http"

    def _file(self, key: str) -> Path:
        host = urlsplit(key).netloc or "misc"
        digest = hashlib.sha1(key.encode("utf-8")).hexdigest()
        return self.root / host.replace(":", "_") / (digest + ".json")

    def get(self, key: str, ttl: float, allow_stale: bool = False):
        """Return (body, age_seconds) or None. ``ttl`` <= 0 disables fresh hits."""
        f = self._file(key)
        try:
            entry = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        age = time.time() - float(entry.get("fetched_at", 0))
        if (ttl > 0 and age <= ttl) or allow_stale:
            return entry.get("body", ""), age
        return None

    def set(self, key: str, body: str) -> None:
        f = self._file(key)
        # a name of its own: two threads fetching the same URL never write into one temp file
        tmp = f.with_name("%s.%d.%d.tmp" % (f.name, os.getpid(), threading.get_ident()))
        try:
            f.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps({"url": key, "fetched_at": time.time(), "body": body}), encoding="utf-8")
            os.replace(str(tmp), str(f))
        except OSError:  # a cache that can't write is just a slower cache — but no half-written file stays behind
            try:
                tmp.unlink()
            except OSError:
                pass

    def prune(self, max_age: float) -> dict:
        """Delete entries older than ``max_age`` seconds (and temp files left by a crash): kline URLs change with
        every bar, so without this the cache only grows — by gigabytes a week on a 24/7 bot."""
        n = size = 0
        cutoff = time.time() - max_age
        if self.root.exists():
            for f in self.root.rglob("*"):
                try:
                    st = f.stat()
                    if f.is_file() and st.st_mtime < (cutoff if f.suffix == ".json" else time.time() - 3600):
                        f.unlink()
                        n += 1
                        size += st.st_size
                except OSError:
                    pass
        return {"files": n, "bytes": size}

    def clear(self) -> int:
        n = 0
        if self.root.exists():
            for f in self.root.rglob("*.json"):
                try:
                    f.unlink()
                    n += 1
                except OSError:
                    pass
        return n
