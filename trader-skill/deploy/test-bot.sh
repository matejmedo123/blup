#!/usr/bin/env bash
# A comparison bot on the local SIMULATOR next to the real one: another setup on the same market, its own dashboard.
#
#   sudo bash /opt/trader/deploy/test-bot.sh                    # 3 % risk, BTC/ETH 4 %, 2× (the default)
#   sudo bash /opt/trader/deploy/test-bot.sh --risk 2 --core-risk 3 --leverage 1    # any other setup
#   sudo bash /opt/trader/deploy/test-bot.sh --remove           # stop and remove it (its state folder is kept)
#
# It never trades real money: its own state folder /var/lib/trader-test on the simulator, no broker keys (it never
# reads /etc/trader/trader.env and cannot see /var/lib/trader), no phone notifications. Run it again to change the
# setup or after an update. Dashboard on 127.0.0.1:8766; side by side in the terminal: sudo traderctl compare
set -euo pipefail

PREFIX=/opt/trader
DATA=/var/lib/trader-test
MAIN=/var/lib/trader
ETC=/etc/trader
USER_NAME=trader
UNITS=(trader-test-autopilot trader-test-dashboard)
RISK=3
CORE=4
LEV=2
CAPITAL=""
REMOVE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --risk) RISK="${2:?--risk needs a number}"; shift 2 ;;
    --core-risk) CORE="${2:?--core-risk needs a number}"; shift 2 ;;
    --leverage) LEV="${2:?--leverage needs a number}"; shift 2 ;;
    --capital) CAPITAL="${2:?--capital needs a number}"; shift 2 ;;
    --remove) REMOVE=1; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run it as root: sudo bash $0" >&2
  exit 1
fi

if [ "$REMOVE" -eq 1 ]; then
  systemctl disable --now "${UNITS[@]}" 2>/dev/null || true
  for u in "${UNITS[@]}"; do rm -f "/etc/systemd/system/$u.service"; done
  rm -f "$ETC/trader-test.env"
  systemctl daemon-reload
  echo "Comparison bot stopped and removed. Its record stays in $DATA (delete it: sudo rm -rf $DATA)."
  exit 0
fi

if [ ! -f "$PREFIX/trader-autopilot/autopilot.py" ] || ! id "$USER_NAME" >/dev/null 2>&1; then
  echo "Install the real bot first: sudo bash deploy/install-vps.sh" >&2
  exit 1
fi

# the same capital as the real bot, so the two compare euro for euro
if [ -z "$CAPITAL" ]; then
  CAPITAL="$(python3 -c 'import json,sys
try:
    c = json.load(open(sys.argv[1]))
    print(float((c.get("autopilot") or {}).get("sim_starting_cash") or c.get("account_size") or 1000))
except Exception:
    print(1000)' "$MAIN/config.json")"
fi

echo "==> state folder $DATA"
FRESH=0
[ -f "$DATA/config.json" ] || FRESH=1
install -d -o "$USER_NAME" -g "$USER_NAME" -m 700 "$DATA"
if [ "$FRESH" -eq 1 ] && [ -f "$MAIN/backtests/playbook.json" ]; then
  # the real bot's lab result, so both start from the same validated coins instead of a 5–30 min lab run;
  # only the backtests — config, keys and positions are never copied
  install -d -o "$USER_NAME" -g "$USER_NAME" -m 700 "$DATA/backtests"
  cp -a "$MAIN/backtests/." "$DATA/backtests/"
  chown -R "$USER_NAME:$USER_NAME" "$DATA/backtests"
fi

echo "==> setup: risk $RISK %, BTC/ETH $CORE %, crypto ${LEV}×, capital $CAPITAL, Bybit costs"
cd "$PREFIX"
if ! OUT="$(runuser -u "$USER_NAME" -- env TRADER_HOME="$DATA" python3 "$PREFIX/trader-autopilot/autopilot.py" profile \
    --risk "$RISK" --core-risk "$CORE" --leverage "$LEV" --capital "$CAPITAL" --fixed-risk --venue bybit --write \
    --home "$DATA" 2>&1)"; then
  printf '%s\n' "$OUT" >&2
  echo "The setup was not saved — nothing was started." >&2
  exit 1
fi
printf '%s\n' "$OUT" | grep -E '^(PROFILE|Not touched)' || true

# the whole point: this folder trades the simulator and nothing else — refuse anything that says otherwise
if ! python3 -c 'import json,sys
c = json.load(open(sys.argv[1]))
ap = c.get("autopilot") or {}
sys.exit(0 if ap.get("broker", "simulator") == "simulator" and ap.get("mode", "paper") != "live" else 1)' \
    "$DATA/config.json"; then
  echo "REFUSED: $DATA/config.json is not on the simulator — the comparison bot never uses a real broker." >&2
  echo "Set autopilot.broker to \"simulator\" there (or remove the folder) and run this again." >&2
  exit 1
fi

echo "==> dashboard password ($ETC/trader-test.env)"
umask 077
grep -E '^TRADER_DASHBOARD_PASSWORD=' "$ETC/trader.env" > "$ETC/trader-test.env" 2>/dev/null || : > "$ETC/trader-test.env"
chmod 600 "$ETC/trader-test.env"

echo "==> services"
for u in "${UNITS[@]}"; do
  install -o root -g root -m 644 "$PREFIX/deploy/$u.service" "/etc/systemd/system/$u.service"
done
systemctl daemon-reload
systemctl enable "${UNITS[@]}" >/dev/null
echo "    (re)starting — a running cycle finishes first, up to 2 minutes"
systemctl restart "${UNITS[@]}"
sleep 3
systemctl --no-pager --lines=0 status "${UNITS[@]}" || true

cat <<NEXT

Done. The comparison bot runs on the SIMULATOR with its own dashboard on 127.0.0.1:8766.
  Side by side:  sudo traderctl compare
  Its status:    sudo traderctl test status      (any traderctl command works after "test")
  Dashboard:     ssh -L 8766:127.0.0.1:8766 <you>@<this server>   then http://127.0.0.1:8766
                 or Tailscale: sudo tailscale serve --bg --https=8443 8766   → https://….ts.net:8443
                 or your domain: the second block in /opt/trader/deploy/Caddyfile.example
  Remove it:     sudo bash $PREFIX/deploy/test-bot.sh --remove
NEXT
