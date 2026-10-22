#!/bin/sh
# Everything this study ran, in order (2026-10-22, UTC). Re-running "collect"/"history" samples
# whatever is live/listable on the day you run it; "backtest" alone works offline on data/.
#
#   sh reproduce.sh backtest    # unit tests + both reports from data/ (offline)
#   sh reproduce.sh collect     # forward sample (today's pools), ~6 h wall clock
#   sh reproduce.sh history     # historical pump.fun sample, ~1-2 h
set -e
cd "$(dirname "$0")"

case "$1" in
collect)
  # 1) backward sample at 09:45: GT new_pools 10 pages x solana/bsc/base (depth: ~9 min / ~70 min
  #    / ~170 min), pump.fun newest ~1000 coins (~50 min), newest ~1000 graduated coins (~26 h)
  python3 -I collect.py discover --sources gt-new pump-new pump-grad --networks solana bsc base
  # 2) forward recorder (ran 09:47-10:00, then restarted 10:01-12:07 with DexScreener liquidity
  #    attached to each snapshot): GT solana every 20 min (3 pages), bsc 45 min, base 120 min,
  #    pump.fun new every 40 min, graduated every 6 h
  python3 -I collect.py ds --snapshot      # DexScreener liquidity for pools found before 10:00
  python3 -I collect.py record --hours 2.1 --networks solana bsc base &
  # 3) bars. Graduated PumpSwap pools whose coin was >= 8 h old: GeckoTerminal 1-min OHLCV
  python3 -I collect.py bars --sources pump-grad --min-age-h 8
  # then, for everything created before 11:00 UTC as it turns 4 h old (loops until 15:05 UTC):
  #   pump.fun curve coins: pump.fun 1-min candles, 30 % hash sample
  python3 -I collect.py bars --sources pump-new --min-age-h 4 --sample 0.3 \
      --created-before 1792666800 --loop-until 1792681500 &
  #   remaining graduated pools: pump.fun 1-min candles + DexScreener liquidity (GeckoTerminal's
  #   free quota was taken by the user's running paper sniper from 11:15)
  python3 -I collect.py bars --sources pump-grad --grad-via-pump --min-age-h 4 \
      --created-before 1792666800 --loop-until 1792681500 &
  #   BSC / Base / other Solana new pools: GeckoTerminal 1-min OHLCV, BSC 60 % hash sample
  GT_INTERVAL=8 python3 -I collect.py bars --sources gt-new --min-age-h 4 --net-sample bsc=0.6 \
      --created-before 1792666800 --loop-until 1792681500
  wait
  python3 -I collect.py ds                 # current DexScreener liquidity for GT pools with bars
  ;;
history)
  # all PumpSwap migrations (MigrateV2 via the pump.fun migration account) back 62 days, public RPC
  python3 -I history.py list --days 62
  # 40 graduated coins per UTC day, evenly spaced in time; 20 curve coins per day (5 evenly spaced
  # out of the 1000 creates before 00/06/12/18 UTC)
  python3 -I history.py sample --grad-per-day 40 --curve-per-day 20
  python3 -I history.py resolve            # getTransaction: mint, pool, starting reserves
  python3 -I history.py enrich             # DexScreener pairs (graduation time of curve coins)
  python3 -I history.py bars               # pump.fun 5-min candles (newest 1000)
  GT_INTERVAL=10 python3 -I history.py bars --gt   # GeckoTerminal for coins whose start was cut off
  python3 -I moonbag.py fetch              # hourly candles: each graduated coin's life after its first 80 h
  curl -sS "https://api.kraken.com/0/public/OHLC?pair=SOLUSD&interval=1440" -o data/hist/kraken_solusd_1d.json
  curl -sS "https://api.kraken.com/0/public/OHLC?pair=SOLUSD&interval=60" -o data/hist/kraken_solusd_1h.json
  ;;
backtest|"")
  mkdir -p results
  python3 -B -m unittest -q test_backtest test_replay test_moonbag
  python3 -I backtest.py > results/forward_report.txt
  python3 -I replay.py > results/history_report.txt
  if [ -f data/hist/bars1h.jsonl ]; then python3 -I moonbag.py > results/moonbag_report.txt; fi
  ;;
esac
