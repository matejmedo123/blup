<?php
declare(strict_types=1);

/**
 * Spoločný štart pre všetky PHP vstupné body (API aj admin).
 */

error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

$storage = __DIR__ . '/../storage';
if (!is_dir($storage . '/logs')) {
    @mkdir($storage . '/logs', 0775, true);
}
ini_set('error_log', $storage . '/logs/php-error.log');

spl_autoload_register(static function (string $class): void {
    foreach ([__DIR__ . '/lib/', __DIR__ . '/payment/'] as $dir) {
        $file = $dir . str_replace('\\', '/', $class) . '.php';
        if (is_file($file)) {
            require_once $file;
            return;
        }
    }
});

// Testy si konfiguráciu podstrčia cez globálnu premennú, aby nesiahali
// na ostrú databázu ani neposielali skutočné e-maily.
if (isset($GLOBALS['ENZO_TEST_CONFIG']) && is_array($GLOBALS['ENZO_TEST_CONFIG'])) {
    /** @var array<string,mixed> $config */
    $config = $GLOBALS['ENZO_TEST_CONFIG'];
} else {
    $configFile = __DIR__ . '/config.php';
    if (!is_file($configFile)) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode([
            'ok'    => false,
            'error' => 'Chýba api/config.php. Skopíruj config.example.php a vyplň údaje.',
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    /** @var array<string,mixed> $config */
    $config = require $configFile;
}

date_default_timezone_set($config['app']['timezone'] ?? 'Europe/Bratislava');

try {
    Db::init($config['db']);
} catch (Throwable $e) {
    error_log('DB init: ' . $e->getMessage());
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => 'Databáza je nedostupná.'], JSON_UNESCAPED_UNICODE);
    exit;
}

/** Vráti konfiguráciu (aby ju nemusel každý súbor ťahať cez global). */
function cfg(?string $path = null, mixed $default = null): mixed
{
    global $config;
    if ($path === null) {
        return $config;
    }
    $value = $config;
    foreach (explode('.', $path) as $key) {
        if (!is_array($value) || !array_key_exists($key, $value)) {
            return $default;
        }
        $value = $value[$key];
    }
    return $value;
}
