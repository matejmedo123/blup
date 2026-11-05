#!/usr/bin/env bash
# Trader on a fresh Debian or Ubuntu server, in one command (deploy/release.sh fills in the address):
#
#   curl -fsSL __BASE__/install.sh | sudo bash
#
# Downloads the current version, checks its checksum, installs it as two services (deploy/install-vps.sh) and
# starts the guided set-up. Without a licence the bot runs on the simulator, free.
set -euo pipefail
BASE="__BASE__"

if [ "$(id -u)" -ne 0 ]; then
  echo "Spusti ako root: curl -fsSL $BASE/install.sh | sudo bash" >&2
  exit 1
fi
need=()
command -v curl >/dev/null 2>&1 || need+=(curl)
command -v python3 >/dev/null 2>&1 || need+=(python3)
if [ ${#need[@]} -gt 0 ]; then
  apt-get update -qq
  apt-get install -y -qq "${need[@]}"
fi

WORK="$(mktemp -d /tmp/trader-install.XXXXXX)"
trap 'rm -rf -- "${WORK:?}"' EXIT
echo "==> sťahujem Trader"
curl -fsSL "$BASE/download/trader.tar.gz" -o "$WORK/trader.tar.gz"
curl -fsSL "$BASE/download/trader.tar.gz.sha256" -o "$WORK/trader.tar.gz.sha256"
echo "$(tr -d ' \n' < "$WORK/trader.tar.gz.sha256")  $WORK/trader.tar.gz" | sha256sum -c --quiet -
mkdir -p "$WORK/src"
tar -xzf "$WORK/trader.tar.gz" -C "$WORK/src"

bash "$WORK/src/deploy/install-vps.sh"

echo
echo "==> nastavenie"
# the set-up reads the keyboard, not the pipe this script came through
if [ -r /dev/tty ]; then
  python3 /opt/trader/deploy/setup.py < /dev/tty
else
  echo "Spusti nastavenie: sudo traderctl setup"
fi
