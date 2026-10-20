"""Load another skill's module (e.g. the scanner runs every meme hit through rugcheck)."""
from __future__ import annotations

import importlib.util
import sys

from .config import PACK_ROOT


def load(skill_dir: str, module: str):
    name = "trader_%s_%s" % (skill_dir.replace("-", "_"), module)
    if name in sys.modules:
        return sys.modules[name]
    path = PACK_ROOT / skill_dir / (module + ".py")
    if not path.exists():
        raise ImportError("skill %s is not installed next to shared/ (%s missing)" % (skill_dir, path))
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod
