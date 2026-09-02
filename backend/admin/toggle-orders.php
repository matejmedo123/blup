<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

Auth::requireLogin();
Response::requireMethod('POST');
Csrf::require();

$now = Settings::bool('accepting_orders');
Settings::set('accepting_orders', $now ? '0' : '1');

flash_redirect(
    'dashboard.php',
    'ok',
    $now ? 'Príjem objednávok je zastavený.' : 'Príjem objednávok je opäť spustený.'
);
