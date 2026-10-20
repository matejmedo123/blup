---
name: trader-scanner
description: Scans thousands of charts on 5-minute candles and ranks day-trading setups — US stocks (opening-range breakout, VWAP reclaim, gap-and-go, bull flag, high relative volume), crypto (Asia / US-open / UTC-day range breakouts, VWAP reclaim, volume spikes, funding-rate extremes, breakouts with rising open interest) and DEX meme coins (volume and buy-pressure spikes, momentum breakouts, first-hour launches, all rug-checked). Use for "scan the market", "find me setups", "what's breaking out", "scan crypto", "any meme coins pumping?", "run the scanner on TSLA, NVDA".
---

# Trader · Chart Scanner

Scans a universe and writes ranked setups to `trader/setups.json` — the
starting point of every workflow (scanner → news → entry → exit → …).

* **Stocks** — the full US ticker list (SEC EDGAR, Nasdaq Trader fallback).
  Big universes are pre-filtered with Yahoo's bulk spark endpoint (20 tickers
  per call) and the top movers get a full 5-min scan within a time budget, so
  the header reads like *"1,526 of 5,259 US stocks scanned, 7 setups"*.
* **Crypto** — top N coins by volume (CoinGecko, Binance fallback), plus
  funding rate and open interest (Binance futures, OKX fallback).
* **Meme coins** — DexScreener boosted/trending tokens and fresh profiles on
  your `meme_chains`. **Every meme hit is run through trader-rugcheck; DANGER
  hits are hidden** (listed under "hidden" with the reasons), RISKY ones are
  flagged. If rugcheck cannot run, the hit is hidden (fail closed).

Statuses: `triggered` (fresh trigger), `extended` (triggered a while ago or
already back below the level), `watching` (within 0.5 % of the trigger),
`forming`, `flag` (no candle rule of its own — the entry timer watches a
momentum breakout instead; see `entry_setup`).

## Run

```bash
python3 "${CLAUDE_SKILL_DIR}/scan.py" --asset stock
python3 "${CLAUDE_SKILL_DIR}/scan.py" --asset stock --symbols TSLA,NVDA,AMD
python3 "${CLAUDE_SKILL_DIR}/scan.py" --asset stock --watchlist --setups orb15,vwap_reclaim
python3 "${CLAUDE_SKILL_DIR}/scan.py" --asset crypto --top 10
python3 "${CLAUDE_SKILL_DIR}/scan.py" --asset meme
```

Offline demo on fixtures:

```bash
python3 "${CLAUDE_SKILL_DIR}/scan.py" --asset stock  --offline --now 2026-10-20T14:15:00Z
python3 "${CLAUDE_SKILL_DIR}/scan.py" --asset crypto --offline --now 2026-10-20T14:40:00Z
python3 "${CLAUDE_SKILL_DIR}/scan.py" --asset meme   --offline --now 2026-10-20T15:55:00Z
```

| Option | Meaning |
|---|---|
| `--asset stock\|crypto\|meme` | what to scan (default stock) |
| `--symbols A,B` / `--watchlist` | scan a list instead of the whole universe |
| `--setups orb15,bull_flag,…` | only these rules/flags |
| `--max-symbols N` | stocks given a full scan after the pre-filter (config default 300) |
| `--time-budget SEC` | stop after this long (config default 240 s) |
| `--top N` | keep the best N hits (default 25) |
| `--interval 1m\|5m\|15m` | candle size (default 5m) |
| `--json`, `--no-html`, `--open`, `--offline`, `--now`, `--home` | common options |

## Reads / writes

* reads `trader/config.json` (`scanner`, `watchlists`, `meme_chains`, `quote_currency`)
* writes `trader/setups.json` (latest scan) and `trader/setups-{asset}.json`
* writes `trader/rugcheck/*.json` for every meme hit (via trader-rugcheck)
* writes `trader/reports/scan-{asset}-{YYYYMMDD}.html` — grid of mini-charts

## How to present results

Start with the header line ("N of M … scanned, K setups"), then the top 3–5
hits as a short list: symbol, setup, status, the rule with its level and the
trigger time, plus relative volume / flags. For meme coins always state the
rugcheck verdict and how many tokens were hidden and why. Point to the HTML
report. Suggest the next step (`/trader-news`, then `/trader-entry --id <id>`).
End with the disclaimer (the meme one for meme scans).

## Never

* Never present a hit as a recommendation to buy — it is a pattern match on past candles.
* Never show a meme hit that rugcheck marked DANGER, or one rugcheck could not check.
* Never place orders or touch wallets; never ask for API keys.
* Never hide that data was partial (time budget hit, symbols without data, fallbacks used).
