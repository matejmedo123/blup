"""Tell the owner what the bot did — on their phone, via ntfy and/or Telegram. Opt-in.

Every notification is appended to ``trader/notifications.jsonl`` whether it is sent or not.
Sending needs ``notify.enabled`` and the event in ``notify.events``; offline mode never sends.

* ntfy: POST ``{ntfy_server}/{ntfy_topic}`` — free, no account. Anyone who knows the topic can
  read it, so pick a long random one (or run your own server and set ``NTFY_TOKEN``).
* Telegram: your own bot (``TELEGRAM_BOT_TOKEN``) messaging your chat (``TELEGRAM_CHAT_ID``).

The bot token sits inside the Telegram URL, so no URL, exception text or log line from here ever
carries it. ``send`` never raises — a notification must not be able to stop the autopilot.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request

from . import config, market_clock, secrets, state

FILE = "notifications.jsonl"
TIMEOUT = 10
SUPPRESS_ERROR_MIN = 30
EVENTS = ("started", "stopped", "trade_opened", "trade_closed", "kill", "paused", "learned", "error", "daily_summary")
TAGS = {"trade_opened": "chart_with_upwards_trend", "trade_closed": "white_check_mark", "kill": "rotating_light",
        "paused": "pause_button", "learned": "brain", "error": "warning", "daily_summary": "bar_chart",
        "started": "robot", "stopped": "stop_sign", "test": "bell"}
USER_AGENT = "trader-skill/3 notifications"


def _settings(cfg: dict) -> dict:
    n = dict((config.DEFAULT_CONFIG.get("notify") or {}))
    n.update((cfg or {}).get("notify") or {})
    return n


def _scrub(text: str) -> str:
    """Remove anything that could be a credential from an error message."""
    text = str(text or "")
    for name in ("TELEGRAM_BOT_TOKEN", "NTFY_TOKEN"):
        v = secrets.get(name)
        if v:
            text = text.replace(v, "***")
    text = re.sub(r"bot\d+:[A-Za-z0-9_-]+", "bot***", text)
    return text[:200]


def _post(url: str, body: bytes, headers: dict) -> int:
    keep = {k: v for k, v in headers.items() if k.lower() != "authorization"}
    req = urllib.request.Request(url, data=body, method="POST", headers=keep)
    for k, v in headers.items():
        if k.lower() == "authorization":  # never sent on to the server a redirect points at
            req.add_unredirected_header(k, v)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:  # looked up at call time: tests patch it
        resp.read(4096)
        return getattr(resp, "status", 200)


def _error(exc) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        return "error: HTTP %s" % exc.code
    reason = getattr(exc, "reason", None) or exc
    return "error: %s" % _scrub("%s: %s" % (type(exc).__name__, reason))


def _header_safe(text: str) -> str:
    """HTTP headers are latin-1; ntfy reads RFC 2047 for anything else."""
    try:
        text.encode("latin-1")
        return text
    except UnicodeEncodeError:
        import base64
        return "=?UTF-8?B?%s?=" % base64.b64encode(text.encode("utf-8")).decode("ascii")


def _ntfy(n: dict, title: str, text: str, priority: str, tag: str) -> str:
    topic = (n.get("ntfy_topic") or "").strip().strip("/")
    if not topic:
        return "off"
    server = (n.get("ntfy_server") or "https://ntfy.sh").rstrip("/")
    headers = {"Title": _header_safe(title), "Priority": "high" if priority == "high" else "default",
               "Tags": tag or "bell", "User-Agent": USER_AGENT, "Content-Type": "text/plain; charset=utf-8"}
    tok = secrets.get("NTFY_TOKEN")
    if tok:
        headers["Authorization"] = "Bearer " + tok
    try:
        _post("%s/%s" % (server, topic), text.encode("utf-8"), headers)
        return "sent"
    except Exception as exc:
        return _error(exc)


def _telegram(n: dict, title: str, text: str) -> str:
    if not n.get("telegram"):
        return "off"
    tok, chat = secrets.get("TELEGRAM_BOT_TOKEN"), secrets.get("TELEGRAM_CHAT_ID")
    if not tok or not chat:
        return "not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID"
    body = json.dumps({"chat_id": chat, "text": "%s\n%s" % (title, text), "disable_web_page_preview": True})
    try:
        _post("https://api.telegram.org/bot%s/sendMessage" % tok, body.encode("utf-8"),
              {"Content-Type": "application/json", "User-Agent": USER_AGENT})
        return "sent"
    except Exception as exc:
        return _error(exc)


def _recent(now_ts: float, seconds: float) -> list:
    """Notifications written in the last ``seconds`` (reads only the tail of the log)."""
    path = state.home() / FILE
    try:
        with path.open("rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - 256 * 1024))
            lines = fh.read().decode("utf-8", errors="ignore").splitlines()
    except OSError:
        return []
    out = []
    for line in reversed(lines):
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        try:
            age = now_ts - market_clock.ts(rec.get("at"))
        except (TypeError, ValueError):
            continue
        if age > seconds:
            break
        if age >= 0:
            out.append(rec)
    return out


def _sent(rec: dict) -> bool:
    return any(v == "sent" for v in (rec.get("channels") or {}).values())


def _attempted(rec: dict) -> bool:
    """Sent, or tried and failed — either way the owner doesn't need it again every minute."""
    return not rec.get("suppressed") and any(v == "sent" or str(v).startswith("error")
                                             for v in (rec.get("channels") or {}).values())


def send(event: str, title: str, text: str, cfg: dict = None, priority: str = "default", _force: bool = False) -> dict:
    """Record a notification and send it where configured. Never raises."""
    try:
        cfg = cfg if cfg is not None else config.load_config()
        n = _settings(cfg)
        now = market_clock.now_utc()
        rec = {"at": market_clock.iso(now), "event": event, "title": str(title), "text": str(text),
               "priority": "high" if priority == "high" else "default", "channels": {}, "suppressed": None}
        wanted = _force or event in (n.get("events") or [])
        if not n.get("enabled"):
            rec["channels"] = {"ntfy": "off", "telegram": "off"}
        elif not wanted:
            rec["channels"] = {"ntfy": "off", "telegram": "off"}
            rec["suppressed"] = "event %r is not in notify.events" % event
        elif config.is_offline():
            rec["channels"] = {"ntfy": "offline — not sent" if n.get("ntfy_topic") else "off",
                               "telegram": "offline — not sent" if n.get("telegram") else "off"}
        else:
            now_ts = now.timestamp()
            recent = _recent(now_ts, 3600)
            cap = int(n.get("max_per_hour") or 30)
            if not _force and event == "error" and any(
                    r.get("event") == "error" and r.get("title") == rec["title"] and _attempted(r)
                    and now_ts - market_clock.ts(r["at"]) <= SUPPRESS_ERROR_MIN * 60 for r in recent):
                rec["suppressed"] = "same error within %d min" % SUPPRESS_ERROR_MIN
            elif not _force and sum(1 for r in recent if _sent(r)) >= cap:
                rec["suppressed"] = "hourly cap of %d notifications reached" % cap
            if rec["suppressed"]:
                rec["channels"] = {"ntfy": "off", "telegram": "off"}
            else:
                tag = TAGS.get(event, "bell")
                rec["channels"] = {"ntfy": _ntfy(n, rec["title"], rec["text"], rec["priority"], tag),
                                   "telegram": _telegram(n, rec["title"], rec["text"])}
        try:
            state.append_jsonl(FILE, rec)
        except OSError:
            pass
        return rec
    except Exception as exc:  # never let a notification stop the bot
        return {"event": event, "title": str(title), "channels": {}, "suppressed": None,
                "error": _scrub("%s: %s" % (type(exc).__name__, exc))}


def test(cfg: dict = None) -> dict:
    """Send a test message to every configured channel (still needs notify.enabled; never offline)."""
    cfg = cfg if cfg is not None else config.load_config()
    n = _settings(cfg)
    channels = [c for c, on in (("ntfy", n.get("ntfy_topic")), ("telegram", n.get("telegram"))) if on]
    text = "If you can read this, the autopilot can reach you (%s)." % (", ".join(channels) or "no channel set")
    rec = send("test", "Trader: test notification", text, cfg, _force=True)
    if not n.get("enabled"):
        rec["hint"] = "notify.enabled is false in trader/config.json — nothing was sent"
    elif not (n.get("ntfy_topic") or n.get("telegram")):
        rec["hint"] = "set notify.ntfy_topic and/or notify.telegram (+ TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)"
    return rec
