#!/usr/bin/env bash
#
# Postaví lokálnu inštanciu ENZO (web + backend) na SQLite a spustí ju.
# Netreba MySQL ani nič inštalovať — stačí PHP.
#
#   bash scripts/dev-server.sh            # postaví a spustí na :8080
#   bash scripts/dev-server.sh --no-build # preskočí `npm run build`
#
# Maily sa neodosielajú, ukladajú sa ako súbory do storage/mail/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="${ENZO_DEV_DIR:-/tmp/enzo-dev}"
PORT="${ENZO_DEV_PORT:-8080}"
WWW="$RUN/www"

ADMIN_NAME="${ADMIN_NAME:-Prevádzka}"
ADMIN_EMAIL="${ADMIN_EMAIL:-prevadzka@enzo.sk}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-EnzoTest12345}"

if [[ "${1:-}" != "--no-build" ]]; then
  echo "▸ Buildujem web…"
  (cd "$ROOT" && npm run build >/dev/null)
fi

echo "▸ Skladám inštanciu v $WWW"
rm -rf "$RUN"
mkdir -p "$WWW/storage/logs" "$WWW/storage/mail"

cp -r "$ROOT/out/." "$WWW/"
cp -r "$ROOT/backend/api" "$ROOT/backend/admin" "$WWW/"
cp "$ROOT/backend/install.php" "$WWW/"
cp "$ROOT/backend/storage/.htaccess" "$WWW/storage/.htaccess" 2>/dev/null || true
chmod -R 777 "$WWW/storage"

# Konfigurácia pre lokálny beh: SQLite a maily do súborov.
cat > "$WWW/api/config.php" <<PHP
<?php
return [
  'db'  => ['driver' => 'sqlite', 'sqlite_path' => __DIR__ . '/../storage/enzo.sqlite'],
  'app' => [
    'url'      => 'http://127.0.0.1:$PORT',
    'timezone' => 'Europe/Bratislava',
    'locale'   => 'sk_SK',
    'secret'   => 'lokalny-vyvoj-nie-je-tajomstvo-1234567890',
  ],
  'mail' => [
    'transport'      => 'log',
    'host' => '', 'port' => 0, 'encryption' => '', 'username' => '', 'password' => '',
    'from_email'     => 'objednavky@enzo.local',
    'from_name'      => 'ENZO (vývoj)',
    'shop_notify'    => 'prevadzka@enzo.local',
    'accounting_bcc' => '',
  ],
  'payments' => [
    'cash_enabled' => true,
    'stripe' => ['enabled' => false, 'secret_key' => '', 'publishable_key' => '', 'webhook_secret' => ''],
  ],
  'accounting' => [
    'vat_payer' => false, 'vat_number' => '',
    'vat_food' => 19.0, 'vat_drinks' => 23.0, 'doc_prefix' => 'DEV',
  ],
  'security' => [
    'allowed_origins'     => ['http://127.0.0.1:$PORT', 'http://localhost:$PORT'],
    'rate_limit_per_hour' => 1000,
  ],
];
PHP

echo "▸ Inštalujem databázu a účet správcu"
php -r '
$GLOBALS["ENZO_TEST_CONFIG"] = null;
require "'"$WWW"'/api/_bootstrap.php";
Migrations::run();
Installer::seedSettings();
Installer::seedOperations();
$c = Installer::seedMenu();
printf("  menu: %d kategórií, %d položiek, %d doplnkov\n", $c["categories"], $c["products"], $c["extras"]);
$r = Installer::createUser("'"$ADMIN_NAME"'", "'"$ADMIN_EMAIL"'", "'"$ADMIN_PASSWORD"'", Auth::ROLE_ADMIN);
echo $r["ok"] ? "  správca vytvorený\n" : "  správca: " . $r["error"] . "\n";
// Prevádzka nech je počas vývoja otvorená nonstop.
Db::run("UPDATE opening_hours SET is_open = 1, open_time = ?, close_time = ?, last_order_offset = 0", ["00:00", "23:59"]);
'

# install.php v lokálnej inštancii netreba — a nech nesvieti ako terč
rm -f "$WWW/install.php"

echo
echo "▸ Web:   http://127.0.0.1:$PORT"
echo "▸ Admin: http://127.0.0.1:$PORT/admin/  ($ADMIN_EMAIL / $ADMIN_PASSWORD)"
echo "▸ Maily: $WWW/storage/mail/"
echo
exec php -S "127.0.0.1:$PORT" -t "$WWW"
