#!/usr/bin/env python3
"""The seller's licence tool: make the signing key once, then a licence file for every customer. Stdlib only.

    python3 deploy/license-tool.py keygen                      # once: ~/trader-vendor/ (keep vendor-private.json safe)
    python3 deploy/license-tool.py issue --email jana@example.sk --plan pro --months 1
    python3 deploy/license-tool.py issue --email firma@example.sk --plan max --until 2027-12-31 --instances 3
    python3 deploy/license-tool.py show jana-example-sk-pro.json

keygen writes two files. license_key.json is public: it goes into shared/license_key.json of the code customers
install, and from then on a real broker needs a licence. vendor-private.json signs licences: whoever has it can make
them, so it never goes into git, a chat or an e-mail. The customer installs a licence with
``sudo traderctl license --install FILE``.
"""
from __future__ import annotations

import argparse
import calendar
import json
import os
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from shared import licence  # noqa: E402

DEFAULT_DIR = Path.home() / "trader-vendor"


def _inside_git(path: Path) -> bool:
    for p in [path] + list(path.parents):
        if (p / ".git").exists():
            return True
    return False


def keygen(out: Path, force: bool, bits: int = 3072) -> int:
    out = out.expanduser().resolve()
    if _inside_git(out) and not force:
        print("refused: %s is inside a git checkout — the private key must never be committed; choose a folder "
              "outside it (default %s)" % (out, DEFAULT_DIR), file=sys.stderr)
        return 2
    priv = out / "vendor-private.json"
    if priv.exists() and not force:
        print("refused: %s already exists — a new key makes every licence you issued invalid (--force to replace)"
              % priv, file=sys.stderr)
        return 2
    out.mkdir(parents=True, exist_ok=True)
    os.chmod(str(out), 0o700)
    print("making a %d-bit key (a few seconds)…" % bits, flush=True)
    key = licence.keygen(bits)
    fd = os.open(str(priv), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(key, fh)
    pub = out / "license_key.json"
    pub.write_text(json.dumps({"n": key["n"], "e": key["e"]}) + "\n", encoding="utf-8")
    print("private key: %s  (keep it; back it up offline; never share it)" % priv)
    print("public key:  %s  (copy it to shared/license_key.json of the code you sell)" % pub)
    return 0


def _add_months(d: date, months: int) -> date:
    y, m = divmod(d.month - 1 + months, 12)
    y, m = d.year + y, m + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def issue(args) -> int:
    key = json.loads(Path(args.key).expanduser().read_text(encoding="utf-8"))
    if "d" not in key:
        print("refused: %s is not the private key" % args.key, file=sys.stderr)
        return 2
    until = args.until or _add_months(date.today(), args.months).isoformat()
    doc = licence.issue(key, args.email, args.plan, until, args.instances)
    out = Path(args.out or "%s-%s.json" % (re.sub(r"[^a-z0-9]+", "-", args.email.lower()).strip("-"), args.plan))
    out.write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    lic = licence.read(doc, {"n": key["n"], "e": key["e"]})
    print("%s: %s for %s, valid until %s, %d server(s) · id %s" % (out, licence.LABEL[lic["plan"]], lic["email"],
                                                                   lic["expires"], lic["instances"], lic["id"]))
    return 0


def show(args) -> int:
    doc = json.loads(Path(args.file).read_text(encoding="utf-8"))
    pub = json.loads(Path(args.pub).read_text(encoding="utf-8")) if args.pub else licence.public_key()
    try:
        lic = licence.read(doc, pub)
    except ValueError as exc:
        print("refused: %s" % exc, file=sys.stderr)
        return 1
    print(json.dumps(lic, indent=1, ensure_ascii=False))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    k = sub.add_parser("keygen", help="make the signing key pair (once)")
    k.add_argument("--out", default=str(DEFAULT_DIR))
    k.add_argument("--force", action="store_true")
    k.add_argument("--bits", type=int, default=3072, help=argparse.SUPPRESS)
    i = sub.add_parser("issue", help="a licence file for one customer")
    i.add_argument("--key", default=str(DEFAULT_DIR / "vendor-private.json"))
    i.add_argument("--email", required=True)
    i.add_argument("--plan", required=True, choices=licence.PLANS[1:])
    g = i.add_mutually_exclusive_group()
    g.add_argument("--months", type=int, default=1)
    g.add_argument("--until", help="last valid day, YYYY-MM-DD")
    i.add_argument("--instances", type=int, default=1, help="servers it is for (Max: 3)")
    i.add_argument("--out")
    s = sub.add_parser("show", help="check a licence file and print it")
    s.add_argument("file")
    s.add_argument("--pub", help="public key file (default: shared/license_key.json)")
    args = ap.parse_args(argv)
    if args.cmd == "keygen":
        return keygen(Path(args.out), args.force, args.bits)
    if args.cmd == "issue":
        return issue(args)
    return show(args)


if __name__ == "__main__":
    sys.exit(main())
