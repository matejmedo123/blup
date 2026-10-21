"""Read and write the shared ``trader/`` state folder.

Writes are atomic (a temp file of their own, flushed to disk, then renamed) so a skill killed mid-write
never leaves half a JSON file for the next skill to choke on, and the dashboard, the daemon and a CLI run
writing the same file at once can't truncate each other. Each write also keeps ``<name>.bak``, the last good
copy, which a read falls back to when the file itself is broken. ``locked(name)`` serialises
read-modify-write updates across threads and processes.
"""
from __future__ import annotations

import errno
import json
import os
import socket
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from . import config

try:
    import fcntl
except ImportError:  # Windows: threads are still serialised, processes are not
    fcntl = None


class StateError(ValueError):
    """A state file that is not valid JSON and has no good copy to fall back to."""


class LockTimeout(StateError):
    """Someone else held a lock longer than the caller would wait (the message says who)."""


_HELD = (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES)


recovered = []   # "<file>: ..." for every broken file a read fell back from — the autopilot reports them


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
        bak = p.with_name(p.name + ".bak")
        try:
            text = bak.read_text(encoding="utf-8")
            doc = json.loads(text)
        except (OSError, ValueError):
            raise StateError("%s is not valid JSON (%s) and has no good copy — fix or delete it" % (p, exc))
        try:  # put the good copy back, keep the broken one to look at: the next read is clean again
            os.replace(str(p), str(p.with_name(p.name + ".broken")))
            config.atomic_write(p, text)
            where = " — restored from its last good copy (the broken file is %s.broken)" % name
        except OSError:
            where = " — using its last good copy"
        note = "%s was not valid JSON (%s)%s" % (name, exc, where)
        if note not in recovered:
            recovered.append(note)
            del recovered[:-20]
        return doc


def write_json(name: str, obj) -> Path:
    p = path(name)
    text = json.dumps(obj, indent=2, ensure_ascii=False) + "\n"
    config.atomic_write(p, text)
    if name.startswith("cache/"):
        return p  # downloaded data is fetched again if it breaks — no spare copy of gigabytes of candles
    try:
        config.atomic_write(p.with_name(p.name + ".bak"), text)
    except OSError:
        pass  # the file itself is written; only its spare copy is a write behind
    return p


_LOCKS = {}
_LOCKS_GUARD = threading.Lock()


class _Lock:
    def __init__(self):
        self.thread = threading.RLock()
        self.depth = 0
        self.fh = None


def _holder(p) -> str:
    try:
        return Path(p).read_text(encoding="utf-8").strip() or "unknown"
    except OSError:
        return "unknown"


def _flock(fh, name: str, p, deadline, stop) -> None:
    if fcntl is None:
        return
    while True:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | (0 if deadline is None and stop is None else fcntl.LOCK_NB))
            return
        except OSError as exc:
            if exc.errno not in _HELD:  # e.g. ENOLCK: NFS without lockd, some FUSE / CIFS mounts
                raise StateError("cannot lock %s (%s) — keep the trader/ folder on a local disk" % (p, exc))
        if (deadline is not None and time.monotonic() >= deadline) or (stop is not None and stop()):
            raise LockTimeout("%s is held by pid/host %s" % (name, _holder(p)))
        time.sleep(0.2)


@contextmanager
def locked(name: str, timeout: float = None, stop=None):
    """Hold ``name`` for a read-modify-write: other threads and other processes (the dashboard, the daemon, a
    CLI run) wait, so no update is lost. Re-entrant within a thread. With ``timeout`` (seconds) or ``stop`` (a
    function that says "give up now", e.g. on SIGTERM) a lock held elsewhere raises LockTimeout instead of
    waiting forever; the lock file says which process holds it."""
    p = path(".locks", name.replace("/", "__") + ".lock")
    with _LOCKS_GUARD:
        lk = _LOCKS.setdefault(str(p), _Lock())
    deadline = None if timeout is None else time.monotonic() + max(0.0, timeout)
    if not lk.thread.acquire(timeout=-1 if timeout is None else max(0.0, timeout)):
        raise LockTimeout("%s is held by another thread of this process" % name)
    try:
        if lk.depth == 0:
            fh = open(str(p), "a+")
            try:
                _flock(fh, name, p, deadline, stop)
            except BaseException:
                fh.close()
                raise
            lk.fh = fh
            try:
                fh.seek(0)
                fh.truncate()
                fh.write("%d@%s\n" % (os.getpid(), socket.gethostname()))
                fh.flush()
            except OSError:
                pass
        lk.depth += 1
        try:
            yield
        finally:
            lk.depth -= 1
            if lk.depth == 0:
                try:
                    if fcntl is not None:
                        fcntl.flock(lk.fh.fileno(), fcntl.LOCK_UN)
                finally:
                    lk.fh.close()
                    lk.fh = None
    finally:
        lk.thread.release()


def update_json(name: str, fn, default=None):
    """Read ``name``, let ``fn`` change it (or return a replacement) and write it back, all under its lock."""
    with locked(name):
        doc = read_json(name, default)
        out = fn(doc)
        doc = doc if out is None else out
        write_json(name, doc)
        return doc


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
