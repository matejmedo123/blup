#!/usr/bin/env bash
# Install or update Trader as two systemd services on an Ubuntu / Debian VPS.
#
#   sudo bash deploy/install-vps.sh             # install or update, then (re)start both services
#   sudo bash deploy/install-vps.sh --no-start  # install or update, start nothing
#
# Safe to run again for an update: the code in /opt/trader is replaced, while the state folder
# /var/lib/trader (config, journal, positions) and the keys in /etc/trader/trader.env are kept.
set -euo pipefail

PREFIX=/opt/trader
DATA=/var/lib/trader
ETC=/etc/trader
USER_NAME=trader
UNITS=(trader-autopilot trader-dashboard)
START=1

for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run it as root: sudo bash $0" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd not found — use the Docker setup instead (deploy/docker-compose.yml)" >&2
  exit 1
fi

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -f "$SRC/trader-autopilot/autopilot.py" ] || [ ! -d "$SRC/shared" ]; then
  echo "$SRC does not look like the trader-skill folder (no trader-autopilot/autopilot.py)" >&2
  exit 1
fi

echo "==> Python"
if ! command -v python3 >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq python3
fi
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'; then
  echo "Python 3.8 or newer is needed (found $(python3 --version 2>&1))" >&2
  exit 1
fi
python3 --version

echo "==> user '$USER_NAME' and folders"
if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
fi
install -d -o "$USER_NAME" -g "$USER_NAME" -m 700 "$DATA"
install -d -o root -g root -m 755 "$PREFIX"
install -d -o root -g root -m 700 "$ETC"

if [ "$SRC" != "$PREFIX" ]; then
  echo "==> code → $PREFIX"
  STAGE="$(mktemp -d "${PREFIX}.new.XXXXXX")"
  # never copy state, demo output, caches or real keys into the program folder — a trader/ folder or an
  # .env file anywhere in the tree (a tool run from inside a skill folder makes one there), not only at the top
  tar -C "$SRC" \
      --exclude='trader' --exclude='./demo' --exclude='./.git' --exclude='__pycache__' --exclude='*.pyc' \
      --exclude='*.env' --exclude='.env' --exclude='secrets.env' -cf - . | tar -C "$STAGE" -xf -
  chown -R root:root "$STAGE"
  chmod -R u=rwX,go=rX "$STAGE"
  OLD="${PREFIX}.old.$$"
  mv "$PREFIX" "$OLD"
  mv "$STAGE" "$PREFIX"
  rm -rf "$OLD"
else
  echo "==> running from $PREFIX itself — code left as it is"
fi

echo "==> settings file $ETC/trader.env"
if [ ! -f "$ETC/trader.env" ]; then
  install -o root -g root -m 600 "$PREFIX/deploy/trader.env.example" "$ETC/trader.env"
  echo "    created from trader.env.example — put your keys in it (sudo nano $ETC/trader.env)"
else
  chmod 600 "$ETC/trader.env"
  echo "    kept your existing file"
fi

echo "==> services"
for u in "${UNITS[@]}"; do
  install -o root -g root -m 644 "$PREFIX/deploy/$u.service" "/etc/systemd/system/$u.service"
done
install -o root -g root -m 755 "$PREFIX/deploy/traderctl" /usr/local/bin/traderctl
# the comparison bot of test-bot.sh, if there is one: its units follow the update too
TEST_UNITS=()
for u in trader-test-autopilot trader-test-dashboard; do
  if [ -f "/etc/systemd/system/$u.service" ]; then
    install -o root -g root -m 644 "$PREFIX/deploy/$u.service" "/etc/systemd/system/$u.service"
    TEST_UNITS+=("$u")
  fi
done
systemctl daemon-reload
systemctl enable "${UNITS[@]}" >/dev/null
if [ "$START" -eq 1 ]; then
  echo "    (re)starting — the autopilot finishes its current cycle first, which can take up to 2 minutes"
  systemctl restart "${UNITS[@]}" ${TEST_UNITS[@]+"${TEST_UNITS[@]}"}
  sleep 3
  systemctl --no-pager --lines=0 status "${UNITS[@]}" || true
fi

cat <<NEXT

Done. Trader is installed as two services:
  trader-autopilot   the 24/7 bot (crypto around the clock, US stocks 9:30–16:00 New York time)
  trader-dashboard   the web dashboard on 127.0.0.1:8765 of this server

It starts on the local SIMULATOR — no account, no real money.

Next steps:
  1. Keys and password:   sudo nano $ETC/trader.env      then: sudo traderctl restart
  2. Settings and limits: sudo -u $USER_NAME nano $DATA/config.json   (and limits.json)
  3. Is it alive?         sudo traderctl health    ·   sudo traderctl status   ·   sudo traderctl logs
  4. Dashboard from your computer:
       ssh -L 8765:127.0.0.1:8765 <you>@<this server>     then open http://127.0.0.1:8765
     (or HTTPS with your own domain: deploy/Caddyfile.example — needs TRADER_DASHBOARD_PASSWORD)
  5. Emergency stop: the KILL button on the dashboard, or  sudo traderctl kill --confirm KILL
  6. Optional, another setup on the simulator next to it:  sudo bash $PREFIX/deploy/test-bot.sh

Trading can lose money. Real money needs every live opt-in step in the README — never just a key.
NEXT
