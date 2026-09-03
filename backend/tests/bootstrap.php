<?php
declare(strict_types=1);

/**
 * Minimalistický testovací bežec.
 *
 * Bez composeru a bez PHPUnit — na hostingu, kam sa systém nasadzuje,
 * nie je ani jedno. Na to, čo tu treba overiť, stačí pár funkcií.
 *
 * Testy bežia proti čerstvej SQLite databáze v pamäti disku, ktorá sa
 * na začiatku každého behu zmaže. Ostrej databázy sa nikdy nedotknú.
 */

const TEST_DB = __DIR__ . '/.tmp/test.sqlite';

/* ------------------------------------------------------------------ */
/*  Prostredie                                                         */
/* ------------------------------------------------------------------ */

function test_boot(): void
{
    $dir = dirname(TEST_DB);
    if (!is_dir($dir)) {
        mkdir($dir, 0775, true);
    }
    foreach (glob($dir . '/test.sqlite*') ?: [] as $f) {
        @unlink($f);
    }

    // Konfiguráciu podstrčíme cez globálnu premennú, aby _bootstrap.php
    // nesiahal po config.php ostrej prevádzky.
    $GLOBALS['ENZO_TEST_CONFIG'] = [
        'db'  => ['driver' => 'sqlite', 'sqlite_path' => TEST_DB],
        'app' => [
            'url'      => 'http://localhost',
            'timezone' => 'Europe/Bratislava',
            'locale'   => 'sk_SK',
            'secret'   => str_repeat('t', 40),
        ],
        'mail' => [
            'transport'      => 'null',
            'from_email'     => 'test@enzo.sk',
            'from_name'      => 'ENZO test',
            'shop_notify'    => 'prevadzka@enzo.sk',
            'accounting_bcc' => '',
        ],
        'payments' => [
            'cash_enabled' => true,
            'stripe'       => ['enabled' => false, 'secret_key' => '', 'publishable_key' => '', 'webhook_secret' => ''],
        ],
        'accounting' => [
            'vat_payer'  => false, 'vat_number' => '',
            'vat_food'   => 19.0, 'vat_drinks' => 23.0, 'doc_prefix' => 'TEST',
        ],
        'security' => ['allowed_origins' => [], 'rate_limit_per_hour' => 1000],
    ];

    require_once __DIR__ . '/../api/_bootstrap.php';

    Migrations::run();
    Installer::seedSettings();
    Installer::seedOperations();
    Installer::seedMenu();
}

/** Prevádzka nech je počas testov otvorená, nech to netreba riešiť všade. */
function test_open_shop(): void
{
    Db::run('UPDATE settings SET value = ? WHERE `key` = ?', ['1', 'accepting_orders']);
    Db::run('UPDATE opening_hours SET is_open = 1, open_time = ?, close_time = ?, last_order_offset = 0', ['00:00', '23:59']);
    Settings::flush();
}

/* ------------------------------------------------------------------ */
/*  Tvrdenia                                                           */
/* ------------------------------------------------------------------ */

final class TestRun
{
    public static int $passed = 0;
    public static int $failed = 0;
    /** @var list<string> */
    public static array $failures = [];
    public static string $group = '';
}

function describe(string $name): void
{
    TestRun::$group = $name;
    echo "\n\033[1m$name\033[0m\n";
}

function ok(bool $condition, string $label, string $detail = ''): void
{
    if ($condition) {
        TestRun::$passed++;
        echo "  \033[32m✓\033[0m $label\n";
        return;
    }
    TestRun::$failed++;
    TestRun::$failures[] = TestRun::$group . ' → ' . $label . ($detail !== '' ? " ($detail)" : '');
    echo "  \033[31m✗\033[0m $label" . ($detail !== '' ? "\n      $detail" : '') . "\n";
}

function is(mixed $actual, mixed $expected, string $label): void
{
    ok(
        $actual === $expected,
        $label,
        $actual === $expected ? '' : 'čakal som ' . var_export($expected, true) . ', dostal ' . var_export($actual, true)
    );
}

/** Očakáva, že kód vyhodí OrderException s daným kódom. */
function throws(string $expectedCode, callable $fn, string $label): void
{
    try {
        $fn();
    } catch (OrderException $e) {
        ok(
            $e->errorCode() === $expectedCode,
            $label,
            $e->errorCode() === $expectedCode ? '' : 'kód ' . $e->errorCode() . ' namiesto ' . $expectedCode
        );
        return;
    } catch (Throwable $e) {
        ok(false, $label, 'iná výnimka: ' . $e::class . ' — ' . $e->getMessage());
        return;
    }
    ok(false, $label, 'nevyhodilo nič');
}

function test_summary(): int
{
    $total = TestRun::$passed + TestRun::$failed;
    echo "\n" . str_repeat('─', 52) . "\n";

    if (TestRun::$failed === 0) {
        echo "\033[32mVšetkých $total testov prešlo.\033[0m\n";
        return 0;
    }

    echo "\033[31m" . TestRun::$failed . " z $total testov zlyhalo:\033[0m\n";
    foreach (TestRun::$failures as $f) {
        echo "  · $f\n";
    }
    return 1;
}

/* ------------------------------------------------------------------ */
/*  Pomôcky pre objednávky                                             */
/* ------------------------------------------------------------------ */

/** @return array<string,mixed> platné údaje zákazníka */
function test_customer(array $override = []): array
{
    return $override + [
        'firstName'   => 'Jana',
        'lastName'    => 'Kováčová',
        'phone'       => '0902 123 456',
        'email'       => 'jana@example.sk',
        'street'      => 'Hlavná',
        'houseNumber' => '12',
        'city'        => 'Koniarovce',
        'postalCode'  => '956 13',
    ];
}

/**
 * Vytvorí objednávku rovnakou cestou ako endpoint, ale bez HTTP.
 *
 * @param list<array<string,mixed>> $items
 * @return array<string,mixed>
 */
function test_order(array $items, string $type = 'pickup', array $customer = []): array
{
    $priced = OrderService::priceCart($items, $type);
    $fee    = $type === 'delivery' ? OrderService::deliveryFee($priced['subtotal'], $type) : 0;

    return OrderService::create(
        $priced['items'],
        test_customer($customer),
        $type,
        'cash',
        $priced['subtotal'],
        $fee,
        []
    );
}
