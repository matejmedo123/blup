<?php
declare(strict_types=1);

/**
 * Vytvorenie schémy a jej neskoršie zmeny. Každá migrácia sa zapíše
 * do tabuľky `migrations`, takže sa nikdy nespustí dvakrát.
 */
final class Migrations
{
    /** @return list<string> zoznam toho, čo sa práve spustilo */
    public static function run(): array
    {
        $done = [];

        // Základná schéma sa púšťa vždy — príkazy sú `IF NOT EXISTS`.
        self::runSchemaFile();

        foreach (self::steps() as $name => $fn) {
            if (self::applied($name)) {
                continue;
            }
            $fn();
            Db::run('INSERT INTO migrations (name, applied_at) VALUES (?, ?)', [$name, Clock::now()]);
            $done[] = $name;
        }
        return $done;
    }

    private static function applied(string $name): bool
    {
        return Db::value('SELECT 1 FROM migrations WHERE name = ?', [$name]) !== null;
    }

    private static function runSchemaFile(): void
    {
        $file = MAJALES_ROOT . '/sql/' . (Db::isSqlite() ? 'schema.sqlite.sql' : 'schema.mysql.sql');
        if (!is_file($file)) {
            throw new RuntimeException('Chýba súbor so schémou: ' . $file);
        }
        foreach (self::splitStatements((string) file_get_contents($file)) as $sql) {
            Db::pdo()->exec($sql);
        }
    }

    /**
     * Rozdelí SQL súbor na jednotlivé príkazy. Komentáre `--` sa zahodia,
     * aby bodkočiarka v komentári nerozbila delenie.
     *
     * @return list<string>
     */
    public static function splitStatements(string $sql): array
    {
        $lines = [];
        foreach (preg_split('/\R/', $sql) ?: [] as $line) {
            $trimmed = ltrim($line);
            if ($trimmed === '' || str_starts_with($trimmed, '--')) {
                continue;
            }
            $lines[] = $line;
        }
        $out = [];
        foreach (explode(';', implode("\n", $lines)) as $stmt) {
            $stmt = trim($stmt);
            if ($stmt !== '') {
                $out[] = $stmt;
            }
        }
        return $out;
    }

    /**
     * Ďalšie zmeny schémy pridávaj sem — nikdy needituj schema.*.sql
     * u zákazníka, ktorý už má nasadenú databázu.
     *
     * @return array<string,callable():void>
     */
    private static function steps(): array
    {
        return [
            '2027_01_zaklad' => static function (): void {
                // Prvé spustenie: schéma je hotová vyššie, tu nie je čo doháňať.
            },
        ];
    }
}
