#!/usr/bin/env python3
"""Is the autopilot alive? Exit 0 = yes, 1 = no heartbeat / stale / stopped. Stdlib only.

Reads <TRADER_HOME>/autopilot/heartbeat.json — the same rule as the dashboard: alive while the last
beat is younger than 3 × interval_sec, and never less than 3 minutes (15 while a cycle is running).

    python3 deploy/healthcheck.py                    # uses $TRADER_HOME (default ./trader)
    python3 deploy/healthcheck.py --home /var/lib/trader
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

MIN_STALE_SEC = 180
CYCLE_MAX_SEC = 900   # a cycle that started this long ago and never finished is a hung bot


def check(home: Path, now: datetime = None):
    now = now or datetime.now(timezone.utc)
    try:
        hb = json.loads((home / "autopilot" / "heartbeat.json").read_text(encoding="utf-8"))
        at = datetime.fromisoformat(str(hb["at"]).replace("Z", "+00:00"))
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return False, "no readable heartbeat in %s (%s)" % (home, type(exc).__name__)
    try:
        interval = float(hb.get("interval_sec") or 60)
    except (TypeError, ValueError):
        interval = 60.0
    limit = max(MIN_STALE_SEC, 3 * interval)
    if hb.get("status") == "cycling":  # mid-cycle: a slow data source is not a dead bot
        limit = max(limit, CYCLE_MAX_SEC)
    age = (now - at).total_seconds()
    if hb.get("status") == "stopped":
        return False, "the autopilot stopped at %s" % hb["at"]
    if age > limit:
        return False, "last heartbeat %d s ago (limit %d s) — status %s" % (age, limit, hb.get("status"))
    return True, "alive: beat %d s ago · %s · cycle %s · %s" % (max(0, age), hb.get("runner"), hb.get("cycle"),
                                                                hb.get("status"))


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--home", help="trader state folder (default $TRADER_HOME or ./trader)")
    p.add_argument("--quiet", action="store_true", help="no output, exit code only")
    args = p.parse_args(argv)
    home = Path(args.home or os.environ.get("TRADER_HOME") or "trader").expanduser()
    ok, msg = check(home)
    if not args.quiet:
        print(("OK  " if ok else "FAIL ") + msg)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
