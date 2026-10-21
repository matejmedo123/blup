"""Test helpers: offline mode, a temporary trader/ folder, and no network — ever."""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shared import http, skills  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))
DEMOS = MANIFEST["demos"]
TOKENS = MANIFEST["tokens"]
MEME_PASS = "SOL:" + TOKENS["PUPKIN"]["address"]
MEME_FAIL = "SOL:" + TOKENS["MLAMBO"]["address"]
MEME_NEW = "base:" + TOKENS["NEWT"]["address"]

_ENV_KEYS = ("TRADER_HOME", "TRADER_OFFLINE", "TRADER_FIXTURES", "TRADER_NOW", "TRADER_OFFLINE_FAIL",
             "TRADER_OFFLINE_BLOCK", "SEC_USER_AGENT", "X_BEARER_TOKEN", "ALPACA_PAPER_KEY_ID",
             "ALPACA_PAPER_SECRET_KEY", "ALPACA_LIVE_KEY_ID", "ALPACA_LIVE_SECRET_KEY", "TRADER_DASHBOARD_PASSWORD",
             "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "NTFY_TOKEN", "ANTHROPIC_API_KEY")


class NetworkBlocked(AssertionError):
    pass


def _no_network(*args, **kwargs):
    raise NetworkBlocked("tests must never touch the network (offline fixtures only)")


def load(skill_dir: str, module: str):
    """Import a skill script, e.g. load('trader-scanner', 'scan')."""
    return skills.load(skill_dir, module)


class TraderTestCase(unittest.TestCase):
    NOW = None  # ISO time pinned for the whole test case (default: fixtures' default_now)

    def setUp(self):
        self._saved_env = {k: os.environ.get(k) for k in _ENV_KEYS}
        self.tmp = Path(tempfile.mkdtemp(prefix="trader-test-"))
        os.environ["TRADER_HOME"] = str(self.tmp / "trader")
        os.environ["TRADER_OFFLINE"] = "1"
        os.environ["TRADER_FIXTURES"] = str(FIXTURES)
        os.environ["TRADER_NOW"] = self.NOW or MANIFEST["default_now"]
        for k in _ENV_KEYS[4:]:  # never let a real key from the developer's shell leak into a test
            os.environ.pop(k, None)
        http.reset()
        self._urlopen = urllib.request.urlopen
        urllib.request.urlopen = _no_network

    def tearDown(self):
        urllib.request.urlopen = self._urlopen
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(str(self.tmp), ignore_errors=True)
        http.reset()

    @property
    def home(self) -> Path:
        return Path(os.environ["TRADER_HOME"])

    def set_now(self, iso: str) -> None:
        os.environ["TRADER_NOW"] = iso

    def read_state(self, name: str):
        p = self.home / name
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None

    def write_state(self, name: str, obj) -> None:
        p = self.home / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(obj, indent=2), encoding="utf-8")

    def run_tool(self, skill_dir: str, module: str, argv):
        """Run a tool's main(argv) in-process → (exit_code, stdout, stderr)."""
        mod = load(skill_dir, module)
        out, err = io.StringIO(), io.StringIO()
        code = 0
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = mod.main(list(argv))
            except SystemExit as exc:
                code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
        return (code or 0), out.getvalue(), err.getvalue()

    def run_json(self, skill_dir: str, module: str, argv):
        code, out, err = self.run_tool(skill_dir, module, list(argv) + ["--json"])
        self.assertEqual(code, 0, "exit %s\nstdout:\n%s\nstderr:\n%s" % (code, out, err))
        return json.loads(out)
