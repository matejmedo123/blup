<?php
declare(strict_types=1);

/**
 * Jednoduché okno na brzdenie opakovaných pokusov. Drží sa v databáze,
 * lebo zdieľaný hosting nemá Redis ani trvalý proces v pamäti.
 */
final class RateLimit
{
    /**
     * Vráti true, keď je pokus ešte v limite. Prvé volanie v okne
     * okno založí, ďalšie zvyšujú počítadlo.
     */
    public static function attempt(string $bucket, string $ident, int $maxHits, int $windowSeconds): bool
    {
        $ident = mb_substr($ident, 0, 120);
        $now   = Clock::now();

        return (bool) Db::transaction(static function () use ($bucket, $ident, $maxHits, $windowSeconds, $now): bool {
            self::prune();
            $row = Db::one('SELECT * FROM rate_limits WHERE bucket = ? AND ident = ?', [$bucket, $ident]);

            if ($row === null || $row['window_end'] < $now) {
                $end = Clock::at($windowSeconds);
                if ($row === null) {
                    Db::run(
                        'INSERT INTO rate_limits (bucket, ident, hits, window_end) VALUES (?, ?, 1, ?)',
                        [$bucket, $ident, $end]
                    );
                } else {
                    Db::run(
                        'UPDATE rate_limits SET hits = 1, window_end = ? WHERE id = ?',
                        [$end, (int) $row['id']]
                    );
                }
                return true;
            }

            if ((int) $row['hits'] >= $maxHits) {
                return false;
            }
            Db::run('UPDATE rate_limits SET hits = hits + 1 WHERE id = ?', [(int) $row['id']]);
            return true;
        });
    }

    /** Po úspešnom prihlásení počítadlo vynulujeme. */
    public static function clear(string $bucket, string $ident): void
    {
        Db::run('DELETE FROM rate_limits WHERE bucket = ? AND ident = ?', [$bucket, mb_substr($ident, 0, 120)]);
    }

    public static function retryAfter(string $bucket, string $ident): int
    {
        $end = Db::value(
            'SELECT window_end FROM rate_limits WHERE bucket = ? AND ident = ?',
            [$bucket, mb_substr($ident, 0, 120)]
        );
        if (!is_string($end)) {
            return 0;
        }
        return max(0, (int) (strtotime($end) - Clock::timestamp()));
    }

    private static function prune(): void
    {
        Db::run('DELETE FROM rate_limits WHERE window_end < ?', [Clock::at(-3600)]);
    }

    /** Adresa návštevníka. Za proxy hostingu je v hlavičke. */
    public static function clientIp(): string
    {
        $candidates = [
            $_SERVER['HTTP_CF_CONNECTING_IP'] ?? null,
            $_SERVER['HTTP_X_FORWARDED_FOR'] ?? null,
            $_SERVER['REMOTE_ADDR'] ?? null,
        ];
        foreach ($candidates as $value) {
            if (!is_string($value) || $value === '') {
                continue;
            }
            $first = trim(explode(',', $value)[0]);
            if (filter_var($first, FILTER_VALIDATE_IP)) {
                return $first;
            }
        }
        return '0.0.0.0';
    }
}
