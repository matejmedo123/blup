"""Common command-line plumbing: flags every tool shares, the disclaimer, JSON/text output."""
from __future__ import annotations

import argparse
import json
import os
import sys
import webbrowser
from dataclasses import dataclass
from pathlib import Path

from . import config, disclaimer, http, market_clock, state
from .symbols import ASSETS, SymbolError

EXIT_OK, EXIT_INPUT, EXIT_DATA = 0, 2, 3


@dataclass
class Context:
    args: argparse.Namespace
    cfg: dict
    limits: dict
    home: Path

    @property
    def now(self):
        return market_clock.now_utc()


def parser(prog: str, description: str, epilog: str = "") -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog=prog, description=description, epilog=epilog,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    add_common(p)
    return p


def add_common(p: argparse.ArgumentParser) -> None:
    g = p.add_argument_group("common options")
    g.add_argument("--asset", choices=ASSETS, help="asset class (default: detected from the symbol)")
    g.add_argument("--offline", action="store_true",
                   help="serve every request from tests/fixtures (no network) — demos and tests")
    g.add_argument("--fixtures", metavar="DIR", help="fixture folder for --offline (default: tests/fixtures)")
    g.add_argument("--now", metavar="ISO", help="pin the clock, e.g. 2026-10-20T14:15:00Z (also TRADER_NOW)")
    g.add_argument("--home", metavar="DIR", help="state folder (default ./trader, also TRADER_HOME)")
    g.add_argument("--json", action="store_true", help="print machine-readable JSON instead of text")
    g.add_argument("--no-html", action="store_true", help="do not write the HTML report")
    g.add_argument("--open", action="store_true", help="open the HTML report in your browser")


def _fixture_now() -> str:
    try:
        manifest = json.loads((config.fixtures_dir() / "manifest.json").read_text(encoding="utf-8"))
        return manifest.get("default_now") or ""
    except (OSError, ValueError):
        return ""


def init(args: argparse.Namespace) -> Context:
    if getattr(args, "home", None):
        os.environ["TRADER_HOME"] = str(Path(args.home).expanduser().resolve())
    if getattr(args, "fixtures", None):
        os.environ["TRADER_FIXTURES"] = str(Path(args.fixtures).expanduser().resolve())
    if getattr(args, "offline", False):
        os.environ["TRADER_OFFLINE"] = "1"
    if getattr(args, "now", None):
        try:
            os.environ["TRADER_NOW"] = market_clock.iso(market_clock.parse_iso(args.now))
        except ValueError:
            fail("--now must be an ISO time like 2026-10-20T14:15:00Z (got %r)" % args.now)
    elif config.is_offline() and not os.environ.get("TRADER_NOW"):
        # fixtures are a frozen snapshot: default "now" to the end of that snapshot
        pinned = _fixture_now()
        if pinned:
            os.environ["TRADER_NOW"] = pinned
    home = config.ensure_home()
    return Context(args=args, cfg=config.load_config(), limits=config.load_limits(), home=home)


def fail(message: str, code: int = EXIT_INPUT) -> None:
    sys.stderr.write("trader: %s\n" % message)
    raise SystemExit(code)


def disclaimer_line(asset=None) -> str:
    return "⚠ " + disclaimer.text(asset)


def emit(args, text: str, payload: dict, asset=None) -> None:
    """Print the text summary (plus disclaimer), or JSON with the disclaimer embedded."""
    if getattr(args, "json", False):
        out = dict(payload)
        out.setdefault("disclaimer", disclaimer.text(asset))
        if http.warnings:
            out.setdefault("data_warnings", list(http.warnings))
        print(json.dumps(out, indent=2, ensure_ascii=False, default=str))
        return
    print(text.rstrip())
    for w in http.warnings:
        print("  note: " + w)
    print("\n" + disclaimer_line(asset))


def maybe_open(args, path) -> None:
    if path and getattr(args, "open", False):
        try:
            webbrowser.open(Path(path).resolve().as_uri())
        except Exception:
            pass


def report_line(path) -> str:
    return "Report: %s" % Path(path).resolve() if path else ""


def entrypoint(fn):
    """Decorate ``main(argv=None)``: uniform error messages and exit codes (2 = bad input, 3 = no data)."""
    def wrapper(argv=None):
        from .data import DataUnavailable
        from .setups import SetupError
        try:
            return fn(argv) or 0
        except (SymbolError, SetupError, ValueError) as exc:
            sys.stderr.write("trader: %s\n" % exc)
            return EXIT_INPUT
        except DataUnavailable as exc:
            sys.stderr.write("trader: %s\n" % exc)
            return EXIT_DATA
        except KeyboardInterrupt:
            return 130
    wrapper.__name__ = getattr(fn, "__name__", "main")
    wrapper.__doc__ = getattr(fn, "__doc__", None)
    return wrapper


def run(main) -> None:
    """``if __name__ == "__main__": cli.run(main)``"""
    raise SystemExit(main() or 0)


def rel(path) -> str:
    return state.rel(path) if path else None
