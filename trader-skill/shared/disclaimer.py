"""The disclaimers every output carries."""
from __future__ import annotations

BASE = "Educational tool, not financial advice. Quotes from free public sources may be delayed or wrong."
MEME = ("Meme coins: most go to zero. Liquidity can vanish in seconds, and volume can be faked. "
        "Only risk what you can afford to lose entirely.")


def text(asset=None) -> str:
    assets = asset if isinstance(asset, (list, tuple, set)) else [asset]
    return BASE + (" " + MEME if "meme" in assets else "")
