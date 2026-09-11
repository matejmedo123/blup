<?php
declare(strict_types=1);

/**
 * Nastavenia webu uložené v databáze. Načítajú sa raz za požiadavku,
 * aby stránka nerobila desiatky dotazov na jednotlivé kľúče.
 */
final class Settings
{
    /** @var array<string,string>|null */
    private static ?array $cache = null;

    /** @return array<string,string> */
    public static function all(): array
    {
        if (self::$cache === null) {
            self::$cache = [];
            foreach (Db::all('SELECT skey, svalue FROM settings') as $row) {
                self::$cache[(string) $row['skey']] = (string) ($row['svalue'] ?? '');
            }
        }
        return self::$cache;
    }

    public static function get(string $key, string $default = ''): string
    {
        $all = self::all();
        $val = $all[$key] ?? null;
        return ($val === null || $val === '') ? $default : $val;
    }

    public static function bool(string $key, bool $default = false): bool
    {
        $all = self::all();
        if (!array_key_exists($key, $all) || $all[$key] === '') {
            return $default;
        }
        return in_array(strtolower($all[$key]), ['1', 'true', 'ano', 'yes', 'on'], true);
    }

    public static function int(string $key, int $default = 0): int
    {
        $v = self::get($key, '');
        return $v === '' ? $default : (int) $v;
    }

    public static function set(string $key, string $value): void
    {
        $now = Clock::now();
        $exists = Db::value('SELECT 1 FROM settings WHERE skey = ?', [$key]);
        if ($exists !== null) {
            Db::run('UPDATE settings SET svalue = ?, updated_at = ? WHERE skey = ?', [$value, $now, $key]);
        } else {
            Db::run('INSERT INTO settings (skey, svalue, updated_at) VALUES (?, ?, ?)', [$key, $value, $now]);
        }
        if (self::$cache !== null) {
            self::$cache[$key] = $value;
        }
    }

    /** @param array<string,string> $values */
    public static function setMany(array $values): void
    {
        Db::transaction(static function () use ($values): void {
            foreach ($values as $k => $v) {
                self::set($k, $v);
            }
        });
    }

    public static function forget(): void
    {
        self::$cache = null;
    }

    /**
     * Číslo, ktoré sa zvýši pri každej zmene obsahu. Web ho používa
     * na ETag, takže prehliadač si drží stránku v cache, kým sa
     * v admine niečo nezmení.
     */
    public static function bumpContentVersion(): void
    {
        self::set('content_version', (string) (self::int('content_version', 1) + 1));
    }
}
