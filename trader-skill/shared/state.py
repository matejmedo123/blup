"""Read and write the shared ``trader/`` state folder.

Writes are atomic (temp file + rename) so a skill killed mid-write never
leaves half a JSON file for the next skill to choke on.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from . import config


def home() -> Path:
    return config.ensure_home()


def path(*parts: str) -> Path:
    p = home().joinpath(*parts)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def rel(p) -> str:
    """Path relative to trader/ for storing inside JSON files."""
    p = Path(p).resolve()
    try:
        return p.relative_to(home()).as_posix()
    except ValueError:
        return str(p)


def read_json(name: str, default=None):
    p = home() / name
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise SystemExit("trader: %s is not valid JSON (%s)" % (p, exc))


def write_json(name: str, obj) -> Path:
    p = path(name)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(str(tmp), str(p))
    return p


def append_jsonl(name: str, obj) -> Path:
    p = path(name)
    with p.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(obj, ensure_ascii=False) + "\n")
    return p


def read_jsonl(name: str) -> list:
    p = home() / name
    if not p.exists():
        return []
    rows = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    return rows
