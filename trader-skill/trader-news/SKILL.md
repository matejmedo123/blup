---
name: trader-news
description: News monitor for day trading — shows only what is new since the last check, newest first, and why each item matters. Stocks: Yahoo/Google News headlines and SEC 8-K filings (earnings, merger, guidance, CEO change). Crypto: CoinDesk, Cointelegraph, The Block (listings, delistings, ETF flows, hacks, token unlocks, regulation, macro). Meme coins: DexScreener profile updates, boosts, new social links, sudden liquidity changes. Use for "any news on TSLA?", "what's the catalyst?", "check crypto news", "what changed on this meme coin", "news since my last check".
---

# Trader · News Monitor

Fetches free RSS/JSON news per symbol, merges duplicates (the same story from
Yahoo and Google News shows once), classifies each item with simple keyword
rules (tags + a one-line "why it matters" + importance `[!!!]`/`[!! ]`/`[!  ]`)
and shows **only items you have not seen yet**. The first check of a symbol
shows the last 24 hours. Designed to run repeatedly — during market hours
for stocks, 24/7 on a schedule for crypto and meme coins, e.g.
`/loop 15m /trader-news --asset crypto`.

Sources: Yahoo Finance RSS, Google News RSS, SEC EDGAR 8-K Atom feed
(needs `sec_user_agent` = "Your Name you@domain.com" in `trader/config.json`
or `SEC_USER_AGENT`; otherwise SEC is skipped with a note), CoinDesk,
Cointelegraph, The Block, DexScreener. A failing source becomes a note,
never a crash.

## Run

```bash
python3 "${CLAUDE_SKILL_DIR}/news.py" --asset stock --symbols TSLA,NVDA
python3 "${CLAUDE_SKILL_DIR}/news.py" --asset crypto                 # watchlist coins + market-wide items
python3 "${CLAUDE_SKILL_DIR}/news.py" --asset meme --symbols SOL:<mint>
python3 "${CLAUDE_SKILL_DIR}/news.py" --asset stock --symbols TSLA --all   # include already-seen items
```

Offline demo: `python3 "${CLAUDE_SKILL_DIR}/news.py" --asset stock --symbols TSLA --offline --now 2026-10-20T14:15:00Z`

| Option | Meaning |
|---|---|
| `--asset stock\|crypto\|meme` | which feeds (default stock) |
| `--symbols …` | tickers / coins / `SOL:<mint>` (default: watchlists; meme also uses tokens from `setups.json`) |
| `--all` | show seen items too |
| `--since ISO` | only items published after this time |
| `--limit N` | max items per symbol (default 12) |
| `--json`, `--no-html`, `--open`, `--offline`, `--now`, `--home` | common options |

## Reads / writes

* reads `trader/config.json` (watchlists, `sec_user_agent`), `trader/setups.json` (meme tokens)
* writes `trader/news.json` (this batch) and `trader/news_seen.json` (seen ids per `asset:symbol`, meme snapshots)
* writes `trader/reports/news-{asset}-{YYYYMMDD}.html`

## How to present results

Per symbol: "TSLA — 3 new since last check", then the `[!!!]` items first
with time, headline, source and the why-it-matters line. Call out catalysts
that change the trade (merger talk, earnings, 8-K, hacks, delistings,
liquidity drops on a meme coin). If nothing is new, say so in one line.
Mention notes about skipped sources. End with the disclaimer.

## Never

* Never invent, summarise beyond, or "fill in" a headline — quote what the feed says.
* Never treat a headline as a trade signal on its own, or claim to know its price impact.
* Never ask for API keys or log in anywhere; never place orders.
