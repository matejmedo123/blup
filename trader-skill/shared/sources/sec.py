"""SEC EDGAR — ticker list and 8-K filings. SEC requires a User-Agent with a name + e-mail, max 10 req/s."""
from __future__ import annotations

from .. import config, http
from . import rss

NAME = "SEC EDGAR"
TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json"
US_EXCHANGES = {"Nasdaq", "NYSE", "NYSE American", "NYSE Arca", "CBOE", "BATS"}

# What an 8-K item usually means for a day trader.
ITEM_MEANING = {
    "1.01": ("deal", "material agreement (merger, partnership or big contract)"),
    "1.02": ("deal", "material agreement terminated"),
    "1.03": ("bankruptcy", "bankruptcy or receivership"),
    "2.01": ("merger", "acquisition or disposal completed"),
    "2.02": ("earnings", "results of operations (earnings)"),
    "2.05": ("restructuring", "exit or restructuring costs"),
    "2.06": ("impairment", "material impairment"),
    "3.01": ("delisting", "delisting notice or transfer of listing"),
    "3.02": ("dilution", "unregistered sale of equity (possible dilution)"),
    "4.01": ("auditor", "change of auditor"),
    "4.02": ("restatement", "prior financials can no longer be relied upon"),
    "5.01": ("control", "change in control"),
    "5.02": ("management", "director or officer departure/appointment (CEO change?)"),
    "7.01": ("guidance", "Regulation FD disclosure (often guidance or investor deck)"),
    "8.01": ("other", "other material event"),
}


def _headers(cfg: dict = None) -> dict:
    ua = config.sec_user_agent(cfg)
    if not ua and not config.is_offline():
        raise http.SourceError("sec", "set sec_user_agent (\"Name email@domain\") in trader/config.json "
                                      "or SEC_USER_AGENT — SEC refuses anonymous requests")
    return {"User-Agent": ua or "trader-skill offline", "Accept-Encoding": "gzip"}


def tickers(cfg: dict = None) -> list:
    d = http.get_json(TICKERS_URL, ttl=86400, headers=_headers(cfg))
    fields = d.get("fields") or ["cik", "name", "ticker", "exchange"]
    idx = {f: i for i, f in enumerate(fields)}
    out = []
    for row in d.get("data") or []:
        exch = row[idx["exchange"]] if "exchange" in idx else ""
        if exch and exch not in US_EXCHANGES:
            continue
        out.append({"ticker": str(row[idx["ticker"]]).upper(), "name": row[idx["name"]],
                    "cik": int(row[idx["cik"]]), "exchange": exch})
    return out


def cik_for(ticker: str, cfg: dict = None):
    t = ticker.upper().replace(".", "-")
    for row in tickers(cfg):
        if row["ticker"].replace(".", "-") == t:
            return row["cik"]
    return None


def filings_8k(cik: int, cfg: dict = None, count: int = 20) -> list:
    url = ("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=%010d&type=8-K&dateb=&owner=include"
           "&count=%d&output=atom" % (int(cik), count))
    return rss.parse(http.get_text(url, ttl=300, headers=_headers(cfg)), NAME)


def classify_items(items_desc: str) -> list:
    """'items 2.02 and 9.01' → [('earnings', 'results of operations (earnings)'), ...]"""
    import re
    found = []
    for code in re.findall(r"\d\.\d{2}", items_desc or ""):
        if code in ITEM_MEANING and ITEM_MEANING[code] not in found:
            found.append(ITEM_MEANING[code])
    return found
