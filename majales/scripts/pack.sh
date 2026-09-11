#!/usr/bin/env bash
# Zabalí web do ZIP-u na nahratie na Websupport.
# Do balíka sa nikdy nedostane config.php, databáza, logy ani testy.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OUT="$ROOT/../majales-web.zip"

command -v zip >/dev/null || { echo "Chýba príkaz zip."; exit 1; }

echo "Kontrolujem syntax PHP…"
find . -name '*.php' -not -path './storage/*' -print0 | xargs -0 -n1 php -l >/dev/null

echo "Púšťam testy…"
php tests/run.php >/dev/null || { echo "Testy zlyhali — balenie zastavené."; exit 1; }

rm -f "$OUT"

echo "Balím…"
zip -r -q "$OUT" . \
  -x 'config.php' \
  -x 'storage/*' \
  -x 'uploads/*' \
  -x 'tests/*' \
  -x 'scripts/*' \
  -x '.git/*' \
  -x '*.sqlite' -x '*.sqlite-wal' -x '*.sqlite-shm' \
  -x '*.log' -x '.DS_Store' -x '*/.DS_Store'

# Prázdne priečinky, ktoré na serveri musia existovať a byť zapisovateľné.
TMP="$(mktemp -d)"
mkdir -p "$TMP/uploads" "$TMP/storage/logs" "$TMP/storage/mail"
cp uploads/.htaccess "$TMP/uploads/.htaccess"
cp storage/.htaccess "$TMP/storage/.htaccess"
: > "$TMP/uploads/.gitkeep"
: > "$TMP/storage/logs/.gitkeep"
: > "$TMP/storage/mail/.gitkeep"
( cd "$TMP" && zip -r -q "$OUT" uploads storage )
rm -rf "$TMP"

# Poistka: keby sa do balíka predsa len dostalo niečo citlivé.
if unzip -l "$OUT" | grep -qE ' config\.php$|\.sqlite'; then
  echo "CHYBA: v balíku je config.php alebo databáza. Balík mažem."
  rm -f "$OUT"
  exit 1
fi

echo
echo "Hotovo: $(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
echo "Veľkosť: $(du -h "$OUT" | cut -f1)"
echo "Súborov: $(unzip -l "$OUT" | tail -1 | awk '{print $2}')"
