#!/usr/bin/env bash
# The seller's step: turn this installation into the download customers install with one command.
#
#   sudo bash /opt/trader/deploy/release.sh tvoja-domena.sk
#
# Writes /var/lib/trader-release/install.sh and download/trader.tar.gz (+ .sha256); Caddy serves them next to the
# landing page (deploy/Caddyfile.example). Run it again after every update. The licence signing key is never in
# /opt/trader (deploy/license-tool.py keeps it in ~/trader-vendor), so it cannot end up in the download.
set -euo pipefail
DOMAIN="${1:-}"
if ! printf '%s' "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'; then
  echo "usage: sudo bash $0 your-domain.sk" >&2
  exit 2
fi
SRC=/opt/trader
OUT=/var/lib/trader-release
if [ ! -f "$SRC/trader-autopilot/autopilot.py" ]; then
  echo "no installation in $SRC — run deploy/install-vps.sh first" >&2
  exit 1
fi
if [ ! -f "$SRC/shared/license_key.json" ]; then
  echo "WARNING: shared/license_key.json is missing — customers would get every plan for free." >&2
  echo "         Make the key with deploy/license-tool.py keygen and ship the public half first." >&2
  exit 1
fi
if find "$SRC" -name 'vendor-private*.json' | grep -q .; then
  echo "REFUSED: a licence signing key is inside $SRC — move it out before releasing" >&2
  exit 1
fi
install -d -o root -g root -m 755 "$OUT" "$OUT/download"
tar -C "$SRC" --exclude='__pycache__' --exclude='*.pyc' --exclude='*.env' --exclude='./trader' \
    -czf "$OUT/download/trader.tar.gz.tmp" .
mv "$OUT/download/trader.tar.gz.tmp" "$OUT/download/trader.tar.gz"
sha256sum "$OUT/download/trader.tar.gz" | cut -d' ' -f1 > "$OUT/download/trader.tar.gz.sha256"
sed "s#__BASE__#https://$DOMAIN#g" "$SRC/deploy/install-customer.sh" > "$OUT/install.sh"
chmod 644 "$OUT/install.sh" "$OUT/download/trader.tar.gz" "$OUT/download/trader.tar.gz.sha256"
echo "Released: https://$DOMAIN/install.sh"
echo "Customers run:  curl -fsSL https://$DOMAIN/install.sh | sudo bash"
