<?php
declare(strict_types=1);

/**
 * Textové bloky stránky. Kľúč je stály (používa ho šablóna), hodnotu
 * mení obsluha v admine. Keď blok v databáze chýba, šablóna dostane
 * prázdny reťazec — stránka sa nikdy nerozbije.
 */
final class Blocks
{
    /** @var array<string,string>|null */
    private static ?array $cache = null;

    /** @return array<string,string> */
    public static function all(): array
    {
        if (self::$cache === null) {
            self::$cache = [];
            foreach (Db::all('SELECT skey, value FROM blocks') as $row) {
                self::$cache[(string) $row['skey']] = (string) ($row['value'] ?? '');
            }
        }
        return self::$cache;
    }

    public static function get(string $key, string $default = ''): string
    {
        $all = self::all();
        $v = $all[$key] ?? '';
        return $v === '' ? $default : $v;
    }

    /** @return list<array<string,mixed>> bloky zoradené po sekciách */
    public static function listAll(): array
    {
        return Db::all('SELECT * FROM blocks ORDER BY sort_order, skey');
    }

    /** @return array<string,list<array<string,mixed>>> */
    public static function bySection(): array
    {
        $out = [];
        foreach (self::listAll() as $row) {
            $out[(string) $row['section']][] = $row;
        }
        return $out;
    }

    public static function set(string $key, string $value): void
    {
        Db::run('UPDATE blocks SET value = ?, updated_at = ? WHERE skey = ?', [$value, Clock::now(), $key]);
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
        Settings::bumpContentVersion();
    }

    /** Založí blok, ak ešte neexistuje. Používa sa pri inštalácii. */
    public static function ensure(string $key, string $label, string $section, string $kind, string $value, string $hint = '', int $sort = 0): void
    {
        if (Db::value('SELECT 1 FROM blocks WHERE skey = ?', [$key]) !== null) {
            return;
        }
        Db::insert('blocks', [
            'skey'       => $key,
            'label'      => $label,
            'hint'       => $hint,
            'kind'       => $kind,
            'section'    => $section,
            'value'      => $value,
            'sort_order' => $sort,
            'updated_at' => Clock::now(),
        ]);
        self::$cache = null;
    }

    public static function forget(): void
    {
        self::$cache = null;
    }
}
