"""Nasdaq Trader symbol directory — fallback list of US tickers (pipe-delimited files)."""
from __future__ import annotations

from .. import http

NAME = "Nasdaq Trader"
FILES = {
    "nasdaq": "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt",
    "other": "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt",
}


def parse(text: str, kind: str) -> list:
    lines = [l for l in (text or "").splitlines() if l.strip()]
    if not lines:
        return []
    header = lines[0].split("|")
    idx = {h: i for i, h in enumerate(header)}
    sym_col = "Symbol" if "Symbol" in idx else "ACT Symbol"
    out = []
    for line in lines[1:]:
        if line.startswith("File Creation Time"):
            continue
        cols = line.split("|")
        if len(cols) < len(header):
            continue
        if "Test Issue" in idx and cols[idx["Test Issue"]] == "Y":
            continue
        if "ETF" in idx and cols[idx["ETF"]] == "Y":
            continue
        sym = cols[idx[sym_col]].strip().upper()
        if not sym or "$" in sym or len(sym) > 6:
            continue
        exch = "Nasdaq" if kind == "nasdaq" else {"N": "NYSE", "A": "NYSE American", "P": "NYSE Arca",
                                                     "Z": "CBOE", "V": "IEX"}.get(cols[idx.get("Exchange", 0)], "Other")
        out.append({"ticker": sym.replace(".", "-"), "name": cols[idx.get("Security Name", 1)], "cik": None,
                    "exchange": exch})
    return out


def tickers() -> list:
    out = []
    for kind, url in FILES.items():
        try:
            out.extend(parse(http.get_text(url, ttl=86400), kind))
        except http.SourceError:
            continue
    if not out:
        raise http.SourceError("nasdaq", "Nasdaq symbol directory unavailable")
    return out
