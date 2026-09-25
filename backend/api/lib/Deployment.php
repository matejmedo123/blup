<?php
declare(strict_types=1);

/**
 * Kontrola, či je na serveri celý balík.
 *
 * Web sa nasadzuje prenosom súborov — cez FTP alebo správcu súborov na
 * hostingu. Taký prenos môže prejsť len z časti a nikto to nezistí: stránka
 * beží, len jeden PHP súbor ostal starý a časť systému sa správa podľa
 * pravidiel, ktoré sme už dávno zmenili. Hľadanie takej chyby je drahé,
 * overenie je pritom triviálne — pri balení zapíšeme odtlačok každého
 * súboru a tu ho porovnáme s tým, čo na serveri naozaj leží.
 */
final class Deployment
{
    /** Zoznam odtlačkov, ktorý vznikol pri balení ZIP-u. */
    private const MANIFEST = __DIR__ . '/manifest.json';

    /**
     * @return array{
     *   available:bool, generated:?string, total:int,
     *   missing:list<string>, stale:list<string>, ok:bool
     * }
     */
    public static function check(): array
    {
        $empty = [
            'available' => false,
            'generated' => null,
            'total'     => 0,
            'missing'   => [],
            'stale'     => [],
            'ok'        => true,
        ];

        if (!is_file(self::MANIFEST)) {
            return $empty;
        }
        $raw = @file_get_contents(self::MANIFEST);
        $data = $raw === false ? null : json_decode($raw, true);
        if (!is_array($data) || !is_array($data['files'] ?? null)) {
            return $empty;
        }

        $root    = dirname(__DIR__, 2);
        $missing = [];
        $stale   = [];

        /** @var array<string,string> $files */
        $files = $data['files'];
        foreach ($files as $path => $hash) {
            $full = $root . '/' . $path;
            if (!is_file($full)) {
                $missing[] = (string) $path;
                continue;
            }
            if (sha1_file($full) !== $hash) {
                $stale[] = (string) $path;
            }
        }

        sort($missing);
        sort($stale);

        return [
            'available' => true,
            'generated' => isset($data['generated']) ? (string) $data['generated'] : null,
            'total'     => count($files),
            'missing'   => $missing,
            'stale'     => $stale,
            'ok'        => $missing === [] && $stale === [],
        ];
    }
}
