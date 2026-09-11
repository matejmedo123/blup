<?php
declare(strict_types=1);

/**
 * Štart testov. Každý beh dostane vlastnú prázdnu SQLite databázu,
 * takže testy nikdy nesiahnu na ostrý web ani na seba navzájom.
 */

const TEST_DB = __DIR__ . '/.test.sqlite';

foreach ([TEST_DB, TEST_DB . '-wal', TEST_DB . '-shm'] as $f) {
    if (is_file($f)) {
        unlink($f);
    }
}

$GLOBALS['MAJALES_TEST_CONFIG'] = [
    'db' => [
        'driver'      => 'sqlite',
        'sqlite_path' => TEST_DB,
    ],
    'app' => [
        'timezone' => 'Europe/Bratislava',
        'base_url' => 'https://test.majalesnitra.sk',
        'app_key'  => str_repeat('t', 64),
        'debug'    => true,
    ],
    'mail' => [
        'transport' => 'file',
        'from'      => 'web@test.sk',
        'from_name' => 'Test',
        'reply_to'  => 'info@test.sk',
    ],
    'uploads' => [
        'max_bytes'    => 4 * 1024 * 1024,
        'max_width'    => 1200,
        'max_height'   => 1200,
        'thumb_width'  => 320,
        'webp_quality' => 80,
    ],
];

require __DIR__ . '/../lib/bootstrap.php';

/** Jednoduchý bežec testov — bez composeru, funguje aj na holom PHP. */
final class T
{
    public static int $passed = 0;
    /** @var list<string> */
    public static array $failures = [];
    private static string $group = '';

    public static function group(string $name): void
    {
        self::$group = $name;
        echo "\n\033[1m" . $name . "\033[0m\n";
    }

    public static function ok(bool $condition, string $what): void
    {
        if ($condition) {
            self::$passed++;
            echo "  \033[32m✓\033[0m " . $what . "\n";
            return;
        }
        self::$failures[] = self::$group . ' → ' . $what;
        echo "  \033[31m✗ " . $what . "\033[0m\n";
    }

    public static function same(mixed $expected, mixed $actual, string $what): void
    {
        $ok = $expected === $actual;
        if (!$ok) {
            $what .= sprintf(
                ' (čakalo sa %s, prišlo %s)',
                var_export($expected, true),
                var_export($actual, true)
            );
        }
        self::ok($ok, $what);
    }

    /** Očakáva, že volanie vyhodí výnimku. */
    public static function throws(callable $fn, string $what, string $contains = ''): void
    {
        try {
            $fn();
        } catch (Throwable $e) {
            if ($contains !== '' && !str_contains($e->getMessage(), $contains)) {
                self::ok(false, $what . ' — hláška neobsahuje „' . $contains . '": ' . $e->getMessage());
                return;
            }
            self::ok(true, $what);
            return;
        }
        self::ok(false, $what . ' — výnimka neprišla');
    }

    public static function summary(): int
    {
        $failed = count(self::$failures);
        echo "\n" . str_repeat('─', 60) . "\n";
        if ($failed === 0) {
            echo "\033[32mVšetkých " . self::$passed . " kontrol prešlo.\033[0m\n";
            return 0;
        }
        echo "\033[31mPrešlo " . self::$passed . ", zlyhalo " . $failed . ":\033[0m\n";
        foreach (self::$failures as $f) {
            echo "  • " . $f . "\n";
        }
        return 1;
    }
}

/** Čistý štart: prázdne tabuľky, počiatočný obsah, jeden správca. */
function freshInstall(): void
{
    Installer::migrate();
    Installer::seed();
    if (!Installer::isInstalled()) {
        Installer::createFirstAdmin('tester', 'TestovacieHeslo123');
    }
    Settings::forget();
    Blocks::forget();
    Media::forget();
}

/** Vyrobí testovací obrázok na disku a vráti položku ako z $_FILES. */
function fakeUpload(string $name = 'foto.jpg', int $w = 900, int $h = 600, string $format = 'jpeg'): array
{
    $im = imagecreatetruecolor($w, $h);
    imagefilledrectangle($im, 0, 0, $w, $h, (int) imagecolorallocate($im, 20, 110, 180));
    $tmp = tempnam(sys_get_temp_dir(), 'majtest');

    match ($format) {
        'png'  => imagepng($im, $tmp),
        'webp' => imagewebp($im, $tmp),
        default => imagejpeg($im, $tmp, 85),
    };
    imagedestroy($im);

    return [
        'name'     => $name,
        'type'     => 'image/' . $format,
        'tmp_name' => $tmp,
        'error'    => UPLOAD_ERR_OK,
        'size'     => (int) filesize($tmp),
    ];
}
