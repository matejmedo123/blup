<?php
declare(strict_types=1);

/**
 * Tenká vrstva nad PDO. Beží na MySQL (Websupport) aj na SQLite,
 * aby sa dal web skúšať lokálne bez databázového servera.
 */
final class Db
{
    private static ?PDO $pdo = null;
    private static string $driver = 'mysql';

    /** @param array<string,mixed> $cfg */
    public static function init(array $cfg): void
    {
        if (self::$pdo !== null) {
            return;
        }
        self::$driver = (string) ($cfg['driver'] ?? 'mysql');

        if (self::$driver === 'sqlite') {
            $path = (string) $cfg['sqlite_path'];
            $dir  = dirname($path);
            if (!is_dir($dir)) {
                mkdir($dir, 0775, true);
            }
            self::$pdo = new PDO('sqlite:' . $path, null, null, [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ]);
            self::$pdo->exec('PRAGMA foreign_keys = ON');
            self::$pdo->exec('PRAGMA journal_mode = WAL');
            self::$pdo->exec('PRAGMA busy_timeout = 5000');
            return;
        }

        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=%s',
            $cfg['host'],
            (int) ($cfg['port'] ?? 3306),
            $cfg['database'],
            $cfg['charset'] ?? 'utf8mb4'
        );
        self::$pdo = new PDO($dsn, (string) $cfg['username'], (string) $cfg['password'], [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
    }

    public static function pdo(): PDO
    {
        if (self::$pdo === null) {
            throw new RuntimeException('Databáza nie je inicializovaná.');
        }
        return self::$pdo;
    }

    public static function driver(): string
    {
        return self::$driver;
    }

    public static function isSqlite(): bool
    {
        return self::$driver === 'sqlite';
    }

    /** @param array<string,mixed>|list<mixed> $params */
    public static function run(string $sql, array $params = []): PDOStatement
    {
        $st = self::pdo()->prepare($sql);
        $st->execute($params);
        return $st;
    }

    /**
     * @param array<string,mixed>|list<mixed> $params
     * @return array<string,mixed>|null
     */
    public static function one(string $sql, array $params = []): ?array
    {
        $row = self::run($sql, $params)->fetch();
        return $row === false ? null : $row;
    }

    /**
     * @param array<string,mixed>|list<mixed> $params
     * @return list<array<string,mixed>>
     */
    public static function all(string $sql, array $params = []): array
    {
        return self::run($sql, $params)->fetchAll();
    }

    /** @param array<string,mixed>|list<mixed> $params */
    public static function value(string $sql, array $params = []): mixed
    {
        $v = self::run($sql, $params)->fetchColumn();
        return $v === false ? null : $v;
    }

    public static function lastId(): int
    {
        return (int) self::pdo()->lastInsertId();
    }

    /**
     * Vloží riadok zo zoznamu stĺpec => hodnota a vráti nové id.
     *
     * @param array<string,mixed> $data
     */
    public static function insert(string $table, array $data): int
    {
        $cols  = array_keys($data);
        $holds = array_map(static fn (string $c): string => ':' . $c, $cols);
        $sql   = sprintf(
            'INSERT INTO %s (%s) VALUES (%s)',
            self::quoteIdent($table),
            implode(', ', array_map([self::class, 'quoteIdent'], $cols)),
            implode(', ', $holds)
        );
        self::run($sql, $data);
        return self::lastId();
    }

    /**
     * Upraví riadok podľa id.
     *
     * @param array<string,mixed> $data
     */
    public static function update(string $table, int $id, array $data): void
    {
        if ($data === []) {
            return;
        }
        $sets = [];
        foreach (array_keys($data) as $c) {
            $sets[] = self::quoteIdent($c) . ' = :' . $c;
        }
        $data['__id'] = $id;
        self::run(
            sprintf('UPDATE %s SET %s WHERE id = :__id', self::quoteIdent($table), implode(', ', $sets)),
            $data
        );
    }

    public static function delete(string $table, int $id): void
    {
        self::run(sprintf('DELETE FROM %s WHERE id = ?', self::quoteIdent($table)), [$id]);
    }

    /** Transakcia, ktorá sa pri výnimke sama vráti späť. */
    public static function transaction(callable $fn): mixed
    {
        $pdo = self::pdo();
        if ($pdo->inTransaction()) {
            return $fn();
        }
        $pdo->beginTransaction();
        try {
            $result = $fn();
            $pdo->commit();
            return $result;
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }

    /** Názvy tabuliek aj stĺpcov pochádzajú z kódu, nikdy zo vstupu. */
    private static function quoteIdent(string $name): string
    {
        if (!preg_match('/^[a-z_][a-z0-9_]*$/i', $name)) {
            throw new InvalidArgumentException('Neplatný názov: ' . $name);
        }
        return self::isSqlite() ? '"' . $name . '"' : '`' . $name . '`';
    }
}
