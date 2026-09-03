<?php
declare(strict_types=1);

/**
 * Migrácie databázy.
 *
 * Každá migrácia sa spustí najviac raz — čo prebehlo, je zapísané
 * v tabuľke `schema_migrations`. Vďaka tomu sa dá `Migrations::run()`
 * volať pri inštalácii aj pri aktualizácii už bežiaceho systému.
 *
 * Indexy sa nevytvárajú v SQL súboroch, ale tu: MySQL 8 nepozná
 * `CREATE INDEX IF NOT EXISTS` (MariaDB áno), takže existenciu
 * kontrolujeme sami a dialekty sa nerozchádzajú.
 */
final class Migrations
{
    /** Zoznam migrácií v poradí. Kľúč je verzia, hodnota názov SQL súboru. */
    private const FILES = [
        '001' => 'schema',
        '002' => 'migrate-002',
        '003' => 'migrate-003',
    ];

    /**
     * Indexy udržiavame na jednom mieste — sú deklaratívne a idempotentné.
     * [názov indexu, tabuľka, stĺpce, unikátny?]
     *
     * @var list<array{0:string,1:string,2:string,3:bool}>
     */
    private const INDEXES = [
        ['idx_orders_created',  'orders',               'created_at',                false],
        ['idx_orders_status',   'orders',               'status',                    false],
        ['idx_orders_type',     'orders',               'order_type, status',        false],
        ['idx_items_order',     'order_items',          'order_id',                  false],
        ['idx_events_order',    'order_events',         'order_id',                  false],
        ['idx_products_cat',    'products',             'category_id, is_available', false],
        ['idx_products_avail',  'products',             'is_available',              false],
        ['idx_mail_order',      'mail_log',             'order_id',                  false],
        ['idx_rate',            'rate_limit',           'ip, action, created_at',    false],
        ['idx_osh_order',       'order_status_history', 'order_id, created_at',      false],
        ['idx_pay_order',       'payments',             'order_id',                  false],
        ['idx_pay_status',      'payments',             'status',                    false],
        ['uq_pay_reference',    'payments',             'reference',                 true],
        ['idx_audit_created',   'audit_log',            'created_at',                false],
        ['idx_idem_created',    'idempotency_keys',     'created_at',                false],
    ];

    /** Spustí všetky nespustené migrácie a dorovná indexy. */
    public static function run(): void
    {
        self::ensureRegistry();
        $done = self::applied();

        foreach (self::FILES as $version => $base) {
            if (isset($done[$version])) {
                continue;
            }
            Db::runSqlFile(self::path($base));
            Db::run(
                'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
                [$version, date('Y-m-d H:i:s')]
            );
        }

        self::ensureColumns();
        self::ensureIndexes();
    }

    /** Verzia, na ktorej databáza stojí (posledná spustená migrácia). */
    public static function currentVersion(): string
    {
        if (!Db::tableExists('schema_migrations')) {
            return '000';
        }
        return (string) (Db::value('SELECT MAX(version) FROM schema_migrations') ?? '000');
    }

    /** Zoznam migrácií, ktoré ešte nebežali. @return list<string> */
    public static function pending(): array
    {
        if (!Db::tableExists('schema_migrations')) {
            return array_keys(self::FILES);
        }
        $done = self::applied();
        return array_values(array_filter(
            array_keys(self::FILES),
            static fn(string $v): bool => !isset($done[$v])
        ));
    }

    /* ------------------------------------------------------------------ */

    private static function path(string $base): string
    {
        $driver = Db::driver() === 'sqlite' ? 'sqlite' : 'mysql';
        return __DIR__ . '/../sql/' . $base . '.' . $driver . '.sql';
    }

    private static function ensureRegistry(): void
    {
        if (Db::tableExists('schema_migrations')) {
            return;
        }
        $sql = Db::driver() === 'sqlite'
            ? 'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)'
            : 'CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(10) NOT NULL PRIMARY KEY, applied_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
        Db::run($sql);

        // Systém nainštalovaný pred zavedením migrácií už má schému 001.
        if (Db::tableExists('orders')) {
            Db::run(
                'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
                ['001', date('Y-m-d H:i:s')]
            );
        }
    }

    /** @return array<string,true> */
    private static function applied(): array
    {
        $out = [];
        foreach (Db::all('SELECT version FROM schema_migrations') as $row) {
            $out[(string) $row['version']] = true;
        }
        return $out;
    }

    /**
     * Stĺpce dopĺňané po ceste. [tabuľka, stĺpec, definícia MySQL, definícia SQLite]
     *
     * @var list<array{0:string,1:string,2:string,3:string}>
     */
    private const COLUMNS = [
        ['orders', 'discount_cents', 'INT NOT NULL DEFAULT 0',  'INTEGER NOT NULL DEFAULT 0'],
        ['orders', 'coupon_code',    'VARCHAR(40) NULL',        'TEXT'],
        ['orders', 'zone_name',      'VARCHAR(120) NULL',       'TEXT'],
    ];

    private static function ensureColumns(): void
    {
        foreach (self::COLUMNS as [$table, $column, $mysql, $sqlite]) {
            if (!Db::tableExists($table) || Db::columnExists($table, $column)) {
                continue;
            }
            $definition = Db::driver() === 'sqlite' ? $sqlite : $mysql;
            try {
                Db::run("ALTER TABLE $table ADD COLUMN $column $definition");
            } catch (Throwable $e) {
                error_log("stĺpec $table.$column: " . $e->getMessage());
            }
        }
    }

    private static function ensureIndexes(): void
    {
        foreach (self::INDEXES as [$name, $table, $columns, $unique]) {
            if (!Db::tableExists($table) || self::indexExists($table, $name)) {
                continue;
            }
            try {
                Db::run(sprintf(
                    'CREATE %sINDEX %s ON %s (%s)',
                    $unique ? 'UNIQUE ' : '',
                    $name,
                    $table,
                    $columns
                ));
            } catch (Throwable $e) {
                // Index nie je kritický pre správnosť, len pre rýchlosť —
                // keď ho hosting z nejakého dôvodu odmietne, systém beží ďalej.
                error_log("index $name: " . $e->getMessage());
            }
        }
    }

    private static function indexExists(string $table, string $name): bool
    {
        try {
            if (Db::driver() === 'sqlite') {
                return Db::value(
                    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
                    [$name]
                ) !== null;
            }
            return (int) (Db::value(
                'SELECT COUNT(*) FROM information_schema.statistics
                 WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?',
                [$table, $name]
            ) ?? 0) > 0;
        } catch (Throwable) {
            return false;
        }
    }
}
