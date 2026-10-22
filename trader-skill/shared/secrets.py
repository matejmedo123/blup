"""API keys and passwords: environment first, then trader/secrets.env — never git, never logs.

Only the autopilot (broker keys), the X source (bearer token), notifications (Telegram / ntfy),
the optional AI desk (Anthropic key) and the dashboard (password) read secrets. Nothing ever
prints, logs or returns a secret's value — use ``masked()`` to show that one is set.
"""
from __future__ import annotations

import os
import stat

from . import config

KNOWN = ("ALPACA_PAPER_KEY_ID", "ALPACA_PAPER_SECRET_KEY", "ALPACA_LIVE_KEY_ID", "ALPACA_LIVE_SECRET_KEY",
         "X_BEARER_TOKEN", "TRADER_DASHBOARD_PASSWORD", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "NTFY_TOKEN",
         "ANTHROPIC_API_KEY", "SNIPER_SOL_SECRET")


def _file_values() -> dict:
    path = config.trader_home() / "secrets.env"
    out = {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip().strip('"').strip("'")
    return out


def get(name: str) -> str:
    value = os.environ.get(name)
    if value:
        return value.strip()
    return _file_values().get(name, "")


def has(name: str) -> bool:
    return bool(get(name))


def masked(name: str) -> str:
    v = get(name)
    return ("set (…%s)" % v[-4:]) if len(v) >= 8 else ("set" if v else "not set")


def file_warning() -> str:
    """Warn when secrets.env is readable by other users (POSIX only)."""
    path = config.trader_home() / "secrets.env"
    try:
        mode = path.stat().st_mode
    except OSError:
        return ""
    if os.name == "posix" and mode & (stat.S_IRGRP | stat.S_IROTH):
        return "%s is readable by other users — run: chmod 600 %s" % (path, path)
    return ""
