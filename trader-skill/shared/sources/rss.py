"""RSS 2.0 / Atom parsing for news feeds (Yahoo, Google News, CoinDesk, Cointelegraph, The Block, SEC).

Feeds are untrusted input: documents with a DOCTYPE/ENTITY declaration are
refused (no entity-expansion tricks), and only http(s) links are kept.
"""
from __future__ import annotations

import hashlib
import html as _html
import re
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from urllib.parse import quote

from .. import http, market_clock

CRYPTO_FEEDS = {
    "CoinDesk": "https://www.coindesk.com/arc/outboundfeeds/rss/",
    "Cointelegraph": "https://cointelegraph.com/rss",
    "The Block": "https://www.theblock.co/rss.xml",
}
_TAG = re.compile(r"<[^>]+>")


def google_news_url(query: str) -> str:
    return "https://news.google.com/rss/search?q=%s&hl=en-US&gl=US&ceid=US:en" % quote(query)


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _text(el) -> str:
    return "".join(el.itertext()).strip() if el is not None else ""


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", _html.unescape(_TAG.sub(" ", text or ""))).strip()


def _when(value: str):
    if not value:
        return None
    try:
        return market_clock.iso(parsedate_to_datetime(value.strip()))
    except (TypeError, ValueError, IndexError):
        pass
    try:
        return market_clock.iso(market_clock.parse_iso(value.strip()))
    except ValueError:
        return None


def _safe_link(url: str) -> str:
    url = (url or "").strip()
    return url if url.lower().startswith(("http://", "https://")) else ""


def item_id(source: str, link: str, title: str) -> str:
    return hashlib.sha1(("%s|%s|%s" % (source, link, title.lower())).encode("utf-8")).hexdigest()[:16]


def parse(text: str, source: str) -> list:
    if not text:
        return []
    head = text[:4096].upper()
    if "<!DOCTYPE" in head or "<!ENTITY" in text.upper():
        raise ValueError("feed declares a DOCTYPE/ENTITY — refused")
    try:
        root = ET.fromstring(text.encode("utf-8") if isinstance(text, str) else text)
    except ET.ParseError as exc:
        raise ValueError("bad XML from %s: %s" % (source, exc))
    items = []
    for el in root.iter():
        name = _local(el.tag)
        if name not in ("item", "entry"):
            continue
        fields = {}
        link = ""
        for child in el:
            cname = _local(child.tag)
            if cname == "link":
                link = child.get("href") or _text(child) or link
            elif cname == "content" and child.get("type") == "text/xml":
                for sub in child:
                    fields[_local(sub.tag)] = _text(sub)
            else:
                fields[cname] = _text(child)
        title = clean(fields.get("title", ""))
        if not title:
            continue
        link = _safe_link(link or fields.get("filing-href", "") or fields.get("guid", ""))
        published = (_when(fields.get("pubDate")) or _when(fields.get("published")) or _when(fields.get("updated"))
                     or _when(fields.get("filing-date")))
        summary = clean(fields.get("description") or fields.get("summary") or fields.get("items-desc") or "")
        items.append({"id": item_id(source, link, title), "source": source, "title": title, "url": link,
                      "published": published, "summary": summary[:400],
                      "items_desc": fields.get("items-desc", ""), "form": fields.get("filing-type", "")})
    return items


def fetch(url: str, source: str, ttl: float = 120) -> list:
    return parse(http.get_text(url, ttl=ttl), source)
