#!/usr/bin/env bash
# Prehliadačové testy proti čerstvej vývojovej inštancii.
# Použitie: bash tests/run-browser.sh [adresa testov]
set -euo pipefail

cd "$(dirname "$0")/.."
TESTY="${1:-tests/browser}"

if [ ! -d "$TESTY" ]; then
  echo "Priečinok so scenármi neexistuje: $TESTY"
  exit 1
fi

echo "▸ Vraciam vývojovú inštanciu do východiskového stavu…"
php tests/reset-dev.php
php tests/seed-photos.php

echo
for scenar in "$TESTY"/admin-test.mjs "$TESTY"/upload-test.mjs "$TESTY"/web-test.mjs "$TESTY"/role-test.mjs "$TESTY"/video-test.mjs; do
  [ -f "$scenar" ] || continue
  echo "▸ $(basename "$scenar")"
  node "$scenar"
  echo
done

echo "Všetky prehliadačové scenáre prešli."
