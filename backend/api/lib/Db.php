<?php
declare(strict_types=1);

/**
 * Tenká vrstva nad PDO. Funguje na MySQL (Websupport) aj na SQLite
 * (keď nechceš riešiť databázu — stačí súbor v priečinku storage).
 */
final class Db
{
    private static ?PDO $pdo = null;
    private static string $driver = 'mysql';

    public static function init(array $cfg): void
    {
        if (self::$pdo !== null) {
            return;
        }
        self::$driver = $cfg['driver'] ?? 'mysql';

        if (self::$driver === 'sqlite') {
            $path = $cfg['sqlite_path'];
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
        } else {
            $dsn = sprintf(
                'mysql:host=%s;port=%d;dbname=%s;charset=%s',
                $cfg['host'],
                (int) ($cfg['port'] ?? 3306),
                $cfg['database'],
                $cfg['charset'] ?? 'utf8mb4'
            );
            self::$pdo = new PDO($dsn, $cfg['username'], $cfg['password'], [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
            ]);
        }
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

    /** @param array<string,mixed>|list<mixed> $params */
    public static function run(string $sql, array $params = []): PDOStatement
    {
        $st = self::pdo()->prepare($sql);
        $st->execute($params);
        return $st;
    }

    /** @return array<string,mixed>|null */
    public static function one(string $sql, array $params = []): ?array
    {
        $row = self::run($sql, $params)->fetch();
        return $row === false ? null : $row;
    }

    /** @return list<array<string,mixed>> */
    public static function all(string $sql, array $params = []): array
    {
        return self::run($sql, $params)->fetchAll();
    }

    public static function value(string $sql, array $params = []): mixed
    {
        $v = self::run($sql, $params)->fetchColumn();
        return $v === false ? null : $v;
    }

    public static function insert(string $table, array $data): int
    {
        $cols = array_keys($data);
        $sql  = sprintf(
            'INSERT INTO %s (%s) VALUES (%s)',
            $table,
            implode(', ', $cols),
            implode(', ', array_map(static fn ($c) => ':' . $c, $cols))
        );
        self::run($sql, $data);
        return (int) self::pdo()->lastInsertId();
    }

    public static function update(string $table, array $data, string $where, array $whereParams = []): int
    {
        $set = implode(', ', array_map(static fn ($c) => "$c = :$c", array_keys($data)));
        $st  = self::run("UPDATE $table SET $set WHERE $where", $data + $whereParams);
        return $st->rowCount();
    }

    public static function transaction(callable $fn): mixed
    {
        $pdo = self::pdo();
        $pdo->beginTransaction();
        try {
            $result = $fn();
            $pdo->commit();
            return $result;
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /** Existuje už tabuľka? Slúži na rozhodnutie, či treba spustiť inštaláciu. */
    public static function tableExists(string $table): bool
    {
        try {
            self::pdo()->query("SELECT 1 FROM $table LIMIT 1");
            return true;
        } catch (Throwable) {
            return false;
        }
    }

    /** Spustí SQL súbor po jednotlivých príkazoch. */
    public static function runSqlFile(string $path): void
    {
        $sql = file_get_contents($path);
        if ($sql === false) {
            throw new RuntimeException("Nepodarilo sa načítať $path");
        }
        // najprv preč s komentármi, inak by sa zahodil aj príkaz, ktorý po nich nasleduje
        $lines = array_filter(
            explode("\n", $sql),
            static fn (string $l): bool => !str_starts_with(trim($l), '--')
        );
        foreach (array_filter(array_map('trim', explode(';', implode("\n", $lines)))) as $stmt) {
            if ($stmt !== '') {
                self::pdo()->exec($stmt);
            }
        }
    }
}
