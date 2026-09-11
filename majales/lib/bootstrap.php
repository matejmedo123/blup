<?php
declare(strict_types=1);

/**
 * Spoločný štart pre web, admin aj API. Načíta konfiguráciu, databázu
 * a autoloader. Každý vstupný bod začína `require` tohto súboru.
 */

error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

define('MAJALES_ROOT', dirname(__DIR__));

$storage = MAJALES_ROOT . '/storage';
if (!is_dir($storage . '/logs')) {
    @mkdir($storage . '/logs', 0775, true);
}
ini_set('error_log', $storage . '/logs/php-error.log');

spl_autoload_register(static function (string $class): void {
    $file = MAJALES_ROOT . '/lib/' . str_replace('\\', '/', $class) . '.php';
    if (is_file($file)) {
        require_once $file;
    }
});

// Testy si konfiguráciu podstrčia globálnou premennou, aby nesiahali
// na ostrú databázu a neposielali skutočné e-maily.
if (isset($GLOBALS['MAJALES_TEST_CONFIG']) && is_array($GLOBALS['MAJALES_TEST_CONFIG'])) {
    /** @var array<string,mixed> $config */
    $config = $GLOBALS['MAJALES_TEST_CONFIG'];
} else {
    $configFile = MAJALES_ROOT . '/config.php';
    if (!is_file($configFile)) {
        http_response_code(503);
        header('Content-Type: text/html; charset=utf-8');
        exit('<h1>Chýba config.php</h1><p>Skopíruj <code>config.example.php</code> ako <code>config.php</code>, vyplň údaje k databáze a spusti <code>install.php</code>.</p>');
    }
    /** @var array<string,mixed> $config */
    $config = require $configFile;
}

Config::load($config);
date_default_timezone_set(Config::get('app.timezone', 'Europe/Bratislava'));

if (Config::get('app.debug', false)) {
    ini_set('display_errors', '1');
}

try {
    Db::init(Config::get('db', []));
} catch (Throwable $e) {
    error_log('DB init: ' . $e->getMessage());
    http_response_code(503);
    header('Content-Type: text/html; charset=utf-8');
    exit('<h1>Databáza je nedostupná</h1><p>Skontroluj údaje v <code>config.php</code>.</p>');
}
