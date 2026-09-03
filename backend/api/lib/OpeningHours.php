<?php
declare(strict_types=1);

/**
 * Otváracie hodiny a mimoriadne zatvorenia.
 *
 * Prevádzka je otvorená, keď platí všetko naraz:
 *  - v admine je zapnutý príjem objednávok,
 *  - dnešný deň je označený ako otvorený,
 *  - je po otvorení a zároveň pred poslednou objednávkou
 *    (posledná objednávka býva o niečo skôr než zatvorenie, nech
 *    kuchyňa stihne dovariť),
 *  - neprebieha mimoriadne zatvorenie (dovolenka, porucha).
 *
 * Kontrola beží na serveri pri každej objednávke. Frontend tie isté
 * údaje len zobrazuje.
 */
final class OpeningHours
{
    public const DAY_NAMES = [
        1 => 'Pondelok',
        2 => 'Utorok',
        3 => 'Streda',
        4 => 'Štvrtok',
        5 => 'Piatok',
        6 => 'Sobota',
        7 => 'Nedeľa',
    ];

    /** @return list<array<string,mixed>> hodiny pre všetkých 7 dní */
    public static function all(): array
    {
        if (!Db::tableExists('opening_hours')) {
            return [];
        }
        $rows = [];
        foreach (Db::all('SELECT * FROM opening_hours ORDER BY weekday') as $r) {
            $rows[(int) $r['weekday']] = $r;
        }

        $out = [];
        for ($day = 1; $day <= 7; $day++) {
            $r = $rows[$day] ?? null;
            $out[] = [
                'weekday'   => $day,
                'name'      => self::DAY_NAMES[$day],
                'isOpen'    => $r !== null && (int) $r['is_open'] === 1,
                'openTime'  => (string) ($r['open_time'] ?? '11:00'),
                'closeTime' => (string) ($r['close_time'] ?? '21:00'),
                'lastOrder' => (int) ($r['last_order_offset'] ?? 30),
            ];
        }
        return $out;
    }

    /**
     * Dá sa práve teraz objednať?
     *
     * @return array{open:bool, reason:string, code:string, opensAt:?string, closesAt:?string}
     */
    public static function status(?int $at = null): array
    {
        $at = $at ?? time();

        if (!Settings::bool('accepting_orders')) {
            return [
                'open'     => false,
                'code'     => ErrorCode::ORDERS_PAUSED,
                'reason'   => (string) Settings::get('closed_message'),
                'opensAt'  => null,
                'closesAt' => null,
            ];
        }

        $closure = self::activeClosure($at);
        if ($closure !== null) {
            $until  = date('j.n. H:i', strtotime((string) $closure['ends_at']));
            $reason = trim((string) ($closure['reason'] ?? ''));
            return [
                'open'     => false,
                'code'     => ErrorCode::RESTAURANT_CLOSED,
                'reason'   => ($reason !== '' ? $reason . ' ' : 'Máme dočasne zatvorené. ')
                    . "Objednávky prijímame opäť od $until.",
                'opensAt'  => (string) $closure['ends_at'],
                'closesAt' => null,
            ];
        }

        $today = self::forDay((int) date('N', $at));
        if ($today === null || !$today['isOpen']) {
            $next = self::nextOpening($at);
            return [
                'open'     => false,
                'code'     => ErrorCode::RESTAURANT_CLOSED,
                'reason'   => 'Dnes máme zatvorené.' . ($next !== null ? " Otvárame $next." : ''),
                'opensAt'  => null,
                'closesAt' => null,
            ];
        }

        $open  = self::stamp($at, $today['openTime']);
        $close = self::stamp($at, $today['closeTime']);
        // Prevádzka otvorená cez polnoc — zatvorenie patrí už na ďalší deň.
        if ($close <= $open) {
            $close += 86400;
        }
        $lastOrder = $close - $today['lastOrder'] * 60;

        if ($at < $open) {
            return [
                'open'     => false,
                'code'     => ErrorCode::RESTAURANT_CLOSED,
                'reason'   => 'Ešte máme zatvorené. Otvárame o ' . $today['openTime'] . '.',
                'opensAt'  => date('Y-m-d H:i:s', $open),
                'closesAt' => date('Y-m-d H:i:s', $close),
            ];
        }
        if ($at >= $lastOrder) {
            $next = self::nextOpening($at);
            return [
                'open'     => false,
                'code'     => ErrorCode::RESTAURANT_CLOSED,
                'reason'   => 'Na dnes už objednávky nestíhame.'
                    . ($next !== null ? " Ozvi sa nám $next." : ''),
                'opensAt'  => null,
                'closesAt' => date('Y-m-d H:i:s', $close),
            ];
        }

        return [
            'open'     => true,
            'code'     => '',
            'reason'   => '',
            'opensAt'  => date('Y-m-d H:i:s', $open),
            'closesAt' => date('Y-m-d H:i:s', $close),
        ];
    }

    /** @return array<string,mixed>|null */
    public static function forDay(int $weekday): ?array
    {
        foreach (self::all() as $d) {
            if ($d['weekday'] === $weekday) {
                return $d;
            }
        }
        return null;
    }

    /** Zlúči rovnaké dni do riadkov typu „Pondelok — Štvrtok | 11:00 — 21:00“. */
    public static function grouped(): array
    {
        $days = self::all();
        if ($days === []) {
            return Settings::hours();
        }

        $out   = [];
        $start = null;
        $prev  = null;

        $flush = static function (array $start, array $prev) use (&$out): void {
            $label = $start['weekday'] === $prev['weekday']
                ? $start['name']
                : $start['name'] . ' — ' . $prev['name'];
            $out[] = [
                'days' => $label,
                'time' => $start['isOpen']
                    ? $start['openTime'] . ' — ' . $start['closeTime']
                    : 'zatvorené',
            ];
        };

        foreach ($days as $d) {
            if ($start === null) {
                $start = $prev = $d;
                continue;
            }
            $same = $d['isOpen'] === $prev['isOpen']
                && $d['openTime'] === $prev['openTime']
                && $d['closeTime'] === $prev['closeTime'];
            if ($same) {
                $prev = $d;
                continue;
            }
            $flush($start, $prev);
            $start = $prev = $d;
        }
        if ($start !== null && $prev !== null) {
            $flush($start, $prev);
        }
        return $out;
    }

    /* ------------------------------------------------------------------ */

    /** @return array<string,mixed>|null */
    private static function activeClosure(int $at): ?array
    {
        if (!Db::tableExists('closures')) {
            return null;
        }
        $now = date('Y-m-d H:i:s', $at);
        return Db::one(
            'SELECT * FROM closures WHERE starts_at <= ? AND ends_at > ? ORDER BY ends_at LIMIT 1',
            [$now, $now]
        );
    }

    /** Kedy najbližšie otvárame — „zajtra o 11:00“, „v piatok o 11:00“. */
    private static function nextOpening(int $at): ?string
    {
        for ($i = 1; $i <= 7; $i++) {
            $ts  = $at + $i * 86400;
            $day = self::forDay((int) date('N', $ts));
            if ($day === null || !$day['isOpen']) {
                continue;
            }
            $when = $i === 1 ? 'zajtra' : 'v ' . self::accusative($day['name']);
            return $when . ' o ' . $day['openTime'];
        }
        return null;
    }

    /** „Piatok“ → „piatok“, „Streda“ → „stredu“ — nech veta znie po slovensky. */
    private static function accusative(string $day): string
    {
        return match ($day) {
            'Streda'  => 'stredu',
            'Sobota'  => 'sobotu',
            'Nedeľa'  => 'nedeľu',
            default   => mb_strtolower($day),
        };
    }

    private static function stamp(int $at, string $hhmm): int
    {
        [$h, $m] = array_pad(array_map('intval', explode(':', $hhmm)), 2, 0);
        return (int) mktime($h, $m, 0, (int) date('n', $at), (int) date('j', $at), (int) date('Y', $at));
    }
}
