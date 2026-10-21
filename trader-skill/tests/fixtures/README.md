# Offline fixtures

Everything in `http/` is **synthetic** test data written by `make_fixtures.py`
(fixed seeds — rerun it and you get the same bytes). Each file is in the raw
response format of the public API it stands in for, and `shared/offline.py`
maps URLs onto these files when `TRADER_OFFLINE=1` (or `--offline`).

The headlines, prices, token names and addresses are made up. The meme-coin
addresses are random strings, not real contracts.

| Fixture | Stands in for | Demo moment (2026-10-20) |
|---|---|---|
| `yahoo/chart/TSLA.json` | Yahoo chart, 60 sessions of 5-min bars + today | Opening range 9:30–9:45 ET high $362.18 / low $358.32; the 10:10 candle closes above at $364.18 |
| `yahoo/chart/NVDA.json` | Yahoo chart, 60 sessions + today | Opening-range breakout on the 9:45 ET candle at $193.92. Its history is generated with a built-in opening-range **follow-through**, so this is the one setup whose backtest shows an edge — the demo's GO case. Real edges are rarely this clean. |
| `yahoo/chart/{PLTR,AAPL,META}.json`, `stooq/amd.us_5.csv` | Yahoo / Stooq (AMD only on Stooq → fallback) | PLTR bull flag, AMD VWAP reclaim |
| `binance/klines/BTCUSDT_5m.json` | Binance klines, 30 days | Asia range high $67,420; the 14:35 UTC candle closes above it |
| `binance_futures/*` | funding + open interest | OI rising into the breakout, ETH funding extreme |
| `coinbase/*`, `kraken/*` | crypto fallbacks | — |
| `dexscreener/*`, `geckoterminal/*` | DEX pairs, boosts, profiles, pool OHLCV | PUPKIN (Solana) momentum breakout on the 15:50 UTC candle |
| `rugcheck/*`, `honeypot/*` | safety data | PUPKIN passes; MLAMBO fails (LP unlocked, top holder 40 %); NEWT (Base) risky |
| `rss/*`, `sec/*`, `nasdaq/*` | news feeds, 8-K filings, ticker lists | "Tesla–SpaceX merger mania strikes Wall Street ahead of earnings" |

`manifest.json` lists the demo times and token addresses used by tests and `scripts/demo.sh`.
