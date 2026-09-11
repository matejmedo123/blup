#!/usr/bin/env bash
# Spustí web lokálne na SQLite — bez MySQL a bez nastavovania hostingu.
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${1:-8099}"

if [ ! -f config.php ]; then
  echo "Zakladám vývojový config.php (SQLite)…"
  cat > config.php <<PHP
<?php
declare(strict_types=1);
return [
    'db'  => ['driver' => 'sqlite', 'sqlite_path' => __DIR__ . '/storage/majales.sqlite'],
    'app' => [
        'timezone' => 'Europe/Bratislava',
        'base_url' => 'http://localhost:$PORT',
        'app_key'  => '$(php -r 'echo bin2hex(random_bytes(32));')',
        'debug'    => true,
    ],
    'mail' => [
        'transport' => 'file',
        'from'      => 'web@majalesnitra.sk',
        'from_name' => 'Majáles Nitra',
        'reply_to'  => 'info@majalesnitra.sk',
    ],
    'uploads' => [
        'max_bytes' => 12582912, 'max_width' => 2000, 'max_height' => 2000,
        'thumb_width' => 480, 'webp_quality' => 82,
    ],
];
PHP
fi

mkdir -p storage/logs storage/mail uploads

if ! php -r 'require "lib/bootstrap.php"; exit(Installer::isInstalled() ? 0 : 1);' 2>/dev/null; then
  echo "Inštalujem databázu…"
  php tests/reset-dev.php
fi

echo
echo "Web:   http://localhost:$PORT/"
echo "Admin: http://localhost:$PORT/admin/  (majales / MajalesHeslo2027)"
echo
exec php -S "127.0.0.1:$PORT" -t .
