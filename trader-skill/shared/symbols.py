"""Asset-class detection and symbol normalisation.

``TSLA`` → stock · ``BTCUSDT`` / ``BTC-USD`` / ``BTC/USDT`` / ``BTC`` → crypto ·
``SOL:<mint>`` / ``base:0x…`` / a bare Solana mint or 0x address → meme coin.
``--asset`` always wins over detection.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass

ASSETS = ("stock", "crypto", "meme")

KNOWN_COINS = {
    "BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "DOGE", "AVAX", "DOT", "LINK", "LTC", "TRX", "TON",
    "MATIC", "POL", "SHIB", "PEPE", "BONK", "WIF", "FLOKI", "ATOM", "NEAR", "APT", "ARB", "OP", "SUI",
    "SEI", "INJ", "TIA", "FIL", "ICP", "HBAR", "XLM", "ETC", "BCH", "UNI", "AAVE", "MKR", "LDO", "RNDR",
    "RENDER", "FET", "TAO", "JUP", "PYTH", "WLD", "ENA", "ONDO", "TRUMP", "HYPE", "XMR", "ALGO", "VET",
    "GRT", "IMX", "STX", "KAS", "CRV", "SAND", "MANA", "AXS", "GALA", "CHZ", "EGLD", "FLOW", "XTZ",
    "1000PEPE", "1000BONK", "1000SHIB", "BOME", "POPCAT", "MEW", "PENGU", "FARTCOIN", "VIRTUAL",
}
STABLECOINS = {"USDT", "USDC", "BUSD", "FDUSD", "DAI", "TUSD", "USDE", "PYUSD", "USDD", "USDS", "EURC",
               "USD1", "USDP", "GUSD", "FRAX", "LUSD", "RLUSD", "USDTB", "USDF", "USDG", "USD0", "AUSD",
               "BFUSD", "USDX", "USDQ", "EURI"}
# meme coins that trade on the big exchanges like any other coin — the autopilot never buys them either
MEME_BASES = {"DOGE", "SHIB", "PEPE", "BONK", "WIF", "FLOKI", "TRUMP", "MELANIA", "BOME", "POPCAT", "MEW", "PENGU",
              "FARTCOIN", "1000PEPE", "1000BONK", "1000SHIB", "1000SATS", "1000FLOKI", "1MBABYDOGE", "BABYDOGE",
              "NEIRO", "TURBO", "MOG", "BRETT", "PNUT", "ACT", "GOAT", "SPX", "MOODENG", "DOGS", "MEME", "PEOPLE",
              "CHILLGUY", "AI16Z", "GIGA", "PONKE", "MYRO", "WEN", "SLERF", "BOOK", "LADYS", "COQ", "ELON", "SAMO",
              "CAT", "CHEEMS", "BROCCOLI714", "BROCCOLI", "MUBARAK", "TUT", "BANANAS31", "PUMP", "TROLL", "WOJAK",
              "SUNDOG", "FWOG", "MICHI", "HIPPO", "RATS", "ORDI", "SATS", "LUNC", "USTC", "PEIPEI", "NEIROCTO",
              "MOTHER", "DADDY", "KEKIUS", "SNEK", "MANEKI", "RETARDIO", "MOODENG", "GME", "AMC", "BODEN", "TREMP"}
# exchanges list tiny-priced coins in lots of 1,000 or a million: 1000PEPE, 1MBABYDOGE, KPEPE (Hyperliquid's "kilo")
_LOT_PREFIX = re.compile(r"^(?:1000000|100000|10000|1000|1M|K)(?=[A-Z])")


def is_meme_base(base) -> bool:
    """A meme coin listed on the big exchanges, however the exchange spells its lot size. Auto-traded only when
    ``autopilot.memes.enabled`` (see ``memes_policy``); a DEX token (asset "meme") never is."""
    b = str(base or "").strip().upper()
    return b in MEME_BASES or _LOT_PREFIX.sub("", b) in MEME_BASES


def memes_policy(cfg: dict):
    """The established-meme-coin settings when switched on (autopilot.memes.enabled), else None."""
    m = ((cfg or {}).get("autopilot") or {}).get("memes") or {}
    if m.get("enabled") is not True:
        return None
    return {"max_rank": int(m.get("max_rank") or 40), "min_listed_days": int(m.get("min_listed_days") or 365),
            "risk_mult": min(1.0, max(0.1, float(m.get("risk_mult") if m.get("risk_mult") is not None else 0.5)))}


def block_keys(text) -> set:
    """Every spelling a block list entry stands for: "SOL/USD", "SOL-USD", "solusd", "SOLUSDT" and "SOL" all mean
    SOL — a blocked coin stays blocked whichever quote or separator the list or the order uses."""
    t = re.sub(r"[\s/\-_:.]", "", str(text or "").upper())
    out = {t} if t else set()
    for q in MONEY_QUOTES:  # never BTC or ETH: "ETH/BTC" is that pair, not all of ETH; "WBTC" is no coin "W"
        if t.endswith(q) and len(t) > len(q):
            out.add(t[: -len(q)])
    return out


def blocked_hits(names, blocked) -> list:
    """The names (an order's symbol, key, base, display…) that the block list covers, in any spelling."""
    keys = set()
    for b in blocked or []:
        keys |= block_keys(b)
    return sorted({str(n) for n in names if n and block_keys(n) & keys})
WRAPPED = {"WBTC", "WETH", "STETH", "WSTETH", "WEETH", "CBBTC", "RETH", "WBETH", "BTCB", "WSOL",
           "JITOSOL", "MSOL", "BSOL", "SUSDE", "LBTC", "SOLVBTC", "EZETH", "RSETH"}
QUOTES = ("FDUSD", "USDT", "USDC", "BUSD", "USD", "EUR", "BTC", "ETH")
MONEY_QUOTES = QUOTES[:6]  # the dollar and euro quotes

CHAIN_ALIASES = {
    "sol": "solana", "solana": "solana",
    "eth": "ethereum", "ethereum": "ethereum", "mainnet": "ethereum",
    "base": "base",
    "bsc": "bsc", "bnb": "bsc", "binance": "bsc",
}
EVM_CHAINS = ("ethereum", "base", "bsc")
GT_NETWORK = {"solana": "solana", "ethereum": "eth", "base": "base", "bsc": "bsc"}
HONEYPOT_CHAIN_ID = {"ethereum": 1, "bsc": 56, "base": 8453}
EXPLORER_TOKEN_URL = {
    "solana": "https://solscan.io/token/{a}",
    "ethereum": "https://etherscan.io/token/{a}",
    "base": "https://basescan.org/token/{a}",
    "bsc": "https://bscscan.com/token/{a}",
}
# Kraken's own names. Its LUNA is Terra Classic (Binance's LUNC); Terra 2.0 — Binance's LUNA — it doesn't list, so
# that asks for a pair Kraken refuses instead of a coin worth a thousandth as much
KRAKEN_BASE = {"BTC": "XBT", "DOGE": "XDG", "LUNC": "LUNA", "LUNA": "LUNA2"}

_SOL_ADDR = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
_EVM_ADDR = re.compile(r"^0x[0-9a-fA-F]{40}$")
_STOCK = re.compile(r"^[A-Z]{1,5}([.\-][A-Z]{1,2})?$")
_PAIR_SEP = re.compile(r"^([A-Z0-9]{2,15})[/\-_:]([A-Z]{3,5})$")


class SymbolError(ValueError):
    pass


def is_solana_address(s: str) -> bool:
    return bool(_SOL_ADDR.match(s or ""))


def is_evm_address(s: str) -> bool:
    return bool(_EVM_ADDR.match(s or ""))


def normalize_chain(chain: str) -> str:
    c = CHAIN_ALIASES.get((chain or "").strip().lower())
    if not c:
        raise SymbolError("unknown chain %r — use solana, base, ethereum or bsc" % chain)
    return c


@dataclass
class Symbol:
    raw: str
    asset: str
    base: str
    quote: str = ""
    chain: str = ""
    address: str = ""
    name: str = ""
    note: str = ""

    # -- identity -------------------------------------------------------------
    @property
    def key(self) -> str:
        """Filesystem-safe id used in state files and setup ids."""
        if self.asset == "meme":
            return "%s-%s" % (self.chain or "unknown", self.address or self.base)
        if self.asset == "crypto":
            return self.base + self.quote
        return self.base.replace(".", "-")

    @property
    def display(self) -> str:
        if self.asset == "meme":
            label = self.name or (self.address[:4] + "…" + self.address[-4:] if self.address else self.base)
            return "%s (%s)" % (label, self.chain or "?")
        if self.asset == "crypto":
            return "%s/%s" % (self.base, self.quote)
        return self.base

    @property
    def short(self) -> str:
        if self.asset == "meme":
            return self.name or (self.address[:6] if self.address else self.base)
        if self.asset == "crypto":
            return self.base + self.quote
        return self.base

    # -- per-source names --------------------------------------------------------
    @property
    def yahoo(self) -> str:
        return self.base.replace(".", "-")

    @property
    def stooq(self) -> str:
        return self.base.replace(".", "-").lower() + ".us"

    @property
    def binance(self) -> str:
        quote = "USDT" if self.quote == "USD" else self.quote
        return self.base + quote

    @property
    def coinbase(self) -> str:
        quote = "USD" if self.quote in ("USDT", "USDC", "FDUSD", "BUSD") else self.quote
        return "%s-%s" % (self.base, quote)

    @property
    def kraken(self) -> str:
        quote = "USD" if self.quote in ("USDC", "FDUSD", "BUSD") else self.quote
        return KRAKEN_BASE.get(self.base, self.base) + quote

    @property
    def alpaca(self) -> str:
        if self.asset == "crypto":
            quote = "USD" if self.quote in ("USD", "USDT") else self.quote
            return "%s/%s" % (self.base, quote)
        return self.base

    @property
    def okx_swap(self) -> str:
        return "%s-USDT-SWAP" % self.base

    @property
    def gt_network(self) -> str:
        return GT_NETWORK.get(self.chain, self.chain)

    @property
    def explorer_url(self) -> str:
        tpl = EXPLORER_TOKEN_URL.get(self.chain)
        return tpl.format(a=self.address) if tpl and self.address else ""

    def to_dict(self) -> dict:
        d = asdict(self)
        d.update(key=self.key, display=self.display)
        return d


def _default_quote(quote: str = None) -> str:
    return (quote or "USDT").upper()


def _crypto_from(raw_upper: str, quote: str = None):
    """Return (base, quote) if the string looks like a CEX pair, else None."""
    m = _PAIR_SEP.match(raw_upper)
    if m and m.group(2) in QUOTES:
        return m.group(1), m.group(2)
    for q in QUOTES:
        if raw_upper.endswith(q) and len(raw_upper) > len(q):
            base = raw_upper[: -len(q)]
            if q in ("USD", "EUR", "BTC", "ETH"):
                if base in KNOWN_COINS:
                    return base, q
                continue
            if len(base) >= 2 and re.match(r"^[A-Z0-9]+$", base):
                return base, q
    if raw_upper in KNOWN_COINS:
        return raw_upper, _default_quote(quote)
    return None


def detect_asset(raw: str) -> str:
    return parse(raw).asset


def parse(raw: str, asset: str = None, quote: str = None) -> Symbol:
    if raw is None or not str(raw).strip():
        raise SymbolError("empty symbol")
    text = str(raw).strip()
    if asset and asset not in ASSETS:
        raise SymbolError("unknown asset class %r — use stock, crypto or meme" % asset)

    # chain:address (SOL:<mint>, base:0x...)
    if ":" in text:
        prefix, rest = text.split(":", 1)
        if prefix.strip().lower() in CHAIN_ALIASES and (is_solana_address(rest) or is_evm_address(rest)):
            chain = normalize_chain(prefix)
            if chain == "solana" and not is_solana_address(rest):
                raise SymbolError("%s is not a Solana address" % rest)
            if chain in EVM_CHAINS and not is_evm_address(rest):
                raise SymbolError("%s is not an EVM (0x…) address" % rest)
            if asset and asset != "meme":
                raise SymbolError("%s is a token address — that is a meme coin, not %s" % (text, asset))
            return Symbol(raw=text, asset="meme", base=rest, chain=chain, address=rest)

    if is_evm_address(text):
        if asset and asset != "meme":
            raise SymbolError("%s is a token address — use --asset meme" % text)
        return Symbol(raw=text, asset="meme", base=text, chain="", address=text,
                      note="EVM address without chain — resolved via DexScreener")
    if is_solana_address(text) and (asset in (None, "meme")) and not _STOCK.match(text):
        return Symbol(raw=text, asset="meme", base=text, chain="solana", address=text)

    upper = text.upper()
    if asset == "meme":
        # a name/ticker to search on DexScreener
        return Symbol(raw=text, asset="meme", base=upper, note="name search — resolved via DexScreener")

    if asset == "stock":
        if not _STOCK.match(upper.replace("/", ".")):
            raise SymbolError("%r does not look like a US stock ticker" % text)
        return Symbol(raw=text, asset="stock", base=upper.replace("/", "."))

    crypto = _crypto_from(upper, quote)
    if asset == "crypto":
        if crypto is None:
            if re.match(r"^[A-Z0-9]{2,15}$", upper):
                crypto = (upper, _default_quote(quote))
            else:
                raise SymbolError("%r does not look like a crypto symbol (try BTCUSDT or BTC-USD)" % text)
        return Symbol(raw=text, asset="crypto", base=crypto[0], quote=crypto[1])
    if crypto is not None:
        note = ""
        if upper in KNOWN_COINS:
            note = "bare coin ticker read as crypto — pass --asset stock for the stock ticker"
        return Symbol(raw=text, asset="crypto", base=crypto[0], quote=crypto[1], note=note)

    if _STOCK.match(upper):
        return Symbol(raw=text, asset="stock", base=upper)
    raise SymbolError("cannot tell what %r is — pass --asset stock|crypto|meme" % text)


def from_dict(d: dict) -> Symbol:
    return Symbol(raw=d.get("raw", ""), asset=d["asset"], base=d.get("base", ""), quote=d.get("quote", ""),
                  chain=d.get("chain", ""), address=d.get("address", ""), name=d.get("name", ""),
                  note=d.get("note", ""))


def meme_symbol(chain: str, address: str, name: str = "") -> Symbol:
    chain = normalize_chain(chain)
    return Symbol(raw="%s:%s" % (chain, address), asset="meme", base=address, chain=chain,
                  address=address, name=name)
