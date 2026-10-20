"""Tiny file cache for HTTP responses, so repeated runs don't hammer free APIs."""
from __future__ import annotations

import hashlib
import json
import os
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
        try:
            f.parent.mkdir(parents=True, exist_ok=True)
            tmp = f.with_name(f.name + ".tmp")
            tmp.write_text(json.dumps({"url": key, "fetched_at": time.time(), "body": body}), encoding="utf-8")
            os.replace(str(tmp), str(f))
        except OSError:
            pass  # a cache that can't write is just a slower cache

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
