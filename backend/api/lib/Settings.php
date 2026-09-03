<?php
declare(strict_types=1);

/**
 * Nastavenia prevádzky uložené v databáze, aby sa dali meniť z adminu
 * bez zásahu do kódu.
 */
final class Settings
{
    /** @var array<string,mixed>|null */
    private static ?array $cache = null;

    public const DEFAULTS = [
        'shop_name'            => 'ENZO Smash Burgers & Pizza',
        'shop_street'          => 'Koniarovce 290',
        'shop_city'            => 'Koniarovce',
        'shop_postal_code'     => '956 13',
        'shop_phone'           => '0948 238 346',
        'shop_email'           => 'objednavky@enzo.sk',
        'company_name'         => 'ENZIK s.r.o.',
        'company_ico'          => '57579661',
        'company_dic'          => '2122832888',
        'company_seat'         => 'Farská 1342/50, 949 01 Nitra',
        'company_manager'      => 'Enriko Petrík',

        'accepting_orders'     => '1',
        'closed_message'       => 'Momentálne neprijímame objednávky. Skús to o chvíľu.',

        'delivery_fee'         => '2.50',
        'free_delivery_from'   => '35.00',
        'min_order'            => '12.00',
        'prep_time_pickup'     => '15 — 25 min',
        'prep_time_delivery'   => '35 — 50 min',
        'default_prep_minutes' => '25',

        'delivery_zones'       => "Koniarovce\nPreseľany\nLudanice\nChrabrany\nTopoľčany\nNitrianska Streda",
        'opening_hours'        => "Pondelok — Štvrtok|11:00 — 21:00\nPiatok — Sobota|11:00 — 22:00\nNedeľa|12:00 — 21:00",

        'instagram_url'        => '',
        'facebook_url'         => '',
    ];

    /** @return array<string,mixed> */
    public static function all(): array
    {
        if (self::$cache !== null) {
            return self::$cache;
        }
        $rows = [];
        try {
            foreach (Db::all('SELECT `key`, `value` FROM settings') as $r) {
                $rows[$r['key']] = $r['value'];
            }
        } catch (Throwable) {
            // tabuľka ešte neexistuje — použijú sa predvolené hodnoty
        }
        return self::$cache = $rows + self::DEFAULTS;
    }

    public static function get(string $key, mixed $default = null): mixed
    {
        $all = self::all();
        return $all[$key] ?? $default ?? (self::DEFAULTS[$key] ?? null);
    }

    public static function int(string $key): int
    {
        return (int) self::get($key, 0);
    }

    public static function cents(string $key): int
    {
        return Money::fromFloat((float) self::get($key, 0));
    }

    public static function bool(string $key): bool
    {
        return (string) self::get($key, '0') === '1';
    }

    public static function set(string $key, mixed $value): void
    {
        $now = date('Y-m-d H:i:s');
        $exists = Db::value('SELECT 1 FROM settings WHERE `key` = ?', [$key]);
        if ($exists) {
            Db::run('UPDATE settings SET `value` = ?, updated_at = ? WHERE `key` = ?', [(string) $value, $now, $key]);
        } else {
            Db::run('INSERT INTO settings (`key`, `value`, updated_at) VALUES (?, ?, ?)', [$key, (string) $value, $now]);
        }
        self::$cache = null;
    }

    /** Zahodí pamäť nastavení — po zmene priamo v databáze. */
    public static function flush(): void
    {
        self::$cache = null;
    }

    /** @return list<array{days:string,time:string}> */
    public static function hours(): array
    {
        $out = [];
        foreach (explode("\n", (string) self::get('opening_hours')) as $line) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            [$days, $time] = array_pad(explode('|', $line, 2), 2, '');
            $out[] = ['days' => trim($days), 'time' => trim($time)];
        }
        return $out;
    }

    /** @return list<string> */
    public static function zones(): array
    {
        return array_values(array_filter(array_map('trim', explode("\n", (string) self::get('delivery_zones')))));
    }
}
