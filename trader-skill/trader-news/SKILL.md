---
name: trader-news
description: News monitor for day trading — only what is new since the last check, newest first, with why it matters. Headlines (Yahoo, Google News, CoinDesk, Cointelegraph, The Block), SEC 8-K filings, DexScreener meme-coin changes, X posts (official API, pay-per-use, daily read budget) and StockTwits crowd sentiment, plus a ranked feed of the best items across all sources. Use for "any news on TSLA?", "what's the catalyst?", "what is X saying about BTC?", "check crypto news", "best news right now", "news since my last check".
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

### Social: X and StockTwits

* **X (Twitter)** — official API v2 recent search only (never scraping). Two kinds of queries:
  a cashtag search per watched symbol (`($TSLA OR "Tesla") -is:retweet -is:reply lang:en`,
  crypto `($BTC OR #bitcoin) …`) and one **breaking** query over curated wire-style accounts
  (`news.x.accounts` in `trader/config.json`, e.g. DeItaone, FirstSquawk, tier10k, WatcherGuru).
  X is **pay-per-use** since 2026: every post a search returns is billed to your token
  (check the price in your X Developer Console). So:
  * set `X_BEARER_TOKEN` in the environment or in `trader/secrets.env` (`X_BEARER_TOKEN=…`,
    `chmod 600`; `trader/` is git-ignored). Without it X is skipped with the note
    "no token — add X_BEARER_TOKEN (X API is pay-per-use)";
  * `news.x.max_reads_per_day` (default 300) is a hard cap — counted per UTC day in
    `trader/x_usage.json`; a request that could overrun it is refused before it is sent;
  * each query is cached for `news.x.poll_minutes` (default 15) so repeated checks cost nothing;
  * statuses you may see: `ok`, `no token …`, `budget exhausted (N reads today)`,
    `token rejected (401)`, `plan/credits do not allow search (402/403)`, `rate limited (429)`.
  The token is only ever sent in the Authorization header — it is never printed, logged or saved.
* **StockTwits** — free public symbol streams (crypto as `BTC.X`). Shown as a crowd line per symbol:
  "TSLA on StockTwits: 12 messages in the last hour, 67% bullish — crowd mood, not information",
  plus (in the feed) at most two substantive top messages. Crowd sentiment is **not information**:
  it is what retail posters feel, often after the move.
* Credibility decides what ranks first: SEC filings > curated wire-style X accounts > major outlets >
  ordinary X posts > StockTwits chatter. A small account's post that mentions "merger" is chatter about
  the story, not the story, so it never gets `[!!!]`.

### The feed (`--feed`)

`news.py --feed` (and the dashboard, via `refresh_feed()`) fetches every source once, folds
near-duplicates across sources (the X copy of a Yahoo headline shows once, with "also: X @…"),
scores each item (credibility, importance, unusual engagement for that X author, recency) and keeps a
rolling `trader/news_feed.json` (newest first, `news.feed_max_items`, default 500). It prints the best
20 and a per-source status line.

## Run

```bash
python3 "${CLAUDE_SKILL_DIR}/news.py" --asset stock --symbols TSLA,NVDA
python3 "${CLAUDE_SKILL_DIR}/news.py" --asset crypto                 # watchlist coins + market-wide items
python3 "${CLAUDE_SKILL_DIR}/news.py" --asset meme --symbols SOL:<mint>
python3 "${CLAUDE_SKILL_DIR}/news.py" --asset stock --symbols TSLA --all   # include already-seen items
python3 "${CLAUDE_SKILL_DIR}/news.py" --feed                               # best news across every source
python3 "${CLAUDE_SKILL_DIR}/news.py" --symbols TSLA --no-social           # headlines and filings only
```

Offline demo: `python3 "${CLAUDE_SKILL_DIR}/news.py" --asset stock --symbols TSLA --offline --now 2026-10-20T14:15:00Z`

| Option | Meaning |
|---|---|
| `--asset stock\|crypto\|meme` | which feeds (default stock) |
| `--symbols …` | tickers / coins / `SOL:<mint>` (default: watchlists; meme also uses tokens from `setups.json`) |
| `--all` | show seen items too |
| `--since ISO` | only items published after this time |
| `--limit N` | max items per symbol (default 12; with `--feed`: how many to print, default 20) |
| `--social` / `--no-social` | include X posts and StockTwits crowd mood (default on) / headlines only |
| `--feed` | refresh `trader/news_feed.json` from all sources and print the best items |
| `--json`, `--no-html`, `--open`, `--offline`, `--now`, `--home` | common options |

## Reads / writes

* reads `trader/config.json` (watchlists, `sec_user_agent`, `news.x`, `news.stocktwits`, `news.feed_max_items`),
  `trader/setups.json` (meme tokens), `X_BEARER_TOKEN` (env or `trader/secrets.env`)
* writes `trader/news.json` (this batch, with `crowd` summaries) and `trader/news_seen.json` (seen ids per
  `asset:symbol`, meme snapshots)
* writes `trader/news_feed.json` (the ranked rolling feed, per-source statuses) and `trader/x_usage.json`
  (X reads today vs the budget)
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
* Never ask the user to paste an API key or token into the chat — point them to `trader/secrets.env` or an
  environment variable; never print, log or save the X token.
* Never scrape x.com or use unofficial mirrors (Nitter etc.); never raise the X read budget on your own.
* Never present StockTwits or X chatter as information or as a signal — it is crowd mood.
* Never place orders.
