<?php
declare(strict_types=1);

/**
 * Prvé spustenie: schéma, počiatočný obsah z `sql/seed.json` a správca.
 * Naplnenie obsahom je bezpečné opakovať — existujúce záznamy sa
 * neprepisujú, takže inštalátor nikdy neprepíše prácu obsluhy.
 */
final class Installer
{
    public static function isInstalled(): bool
    {
        try {
            return Db::value('SELECT COUNT(*) FROM users') > 0;
        } catch (Throwable) {
            return false;
        }
    }

    /** @return list<string> čo sa spravilo */
    public static function migrate(): array
    {
        return Migrations::run();
    }

    /** @return array<string,int> počty vložených záznamov */
    public static function seed(): array
    {
        $file = MAJALES_ROOT . '/sql/seed.json';
        if (!is_file($file)) {
            throw new RuntimeException('Chýba sql/seed.json.');
        }
        /** @var array<string,mixed>|null $data */
        $data = json_decode((string) file_get_contents($file), true);
        if (!is_array($data)) {
            throw new RuntimeException('sql/seed.json sa nedá načítať.');
        }

        $counts = [];
        Db::transaction(static function () use ($data, &$counts): void {
            $counts['nastavenia'] = self::seedSettings((array) ($data['settings'] ?? []));
            $counts['bloky']      = self::seedBlocks((array) ($data['blocks'] ?? []));
            $counts['interpreti'] = self::seedArtists((array) ($data['artists'] ?? []));
            $counts['vstupenky']  = self::seedTickets((array) ($data['tickets'] ?? []));
            $counts['otazky']     = self::seedSimple('faqs', (array) ($data['faqs'] ?? []), ['question', 'answer']);
            $counts['zony']       = self::seedSimple('zones', (array) ($data['zones'] ?? []), ['title', 'description']);
            $counts['galeria']    = self::seedSimple('gallery', (array) ($data['gallery'] ?? []), ['caption']);
            $counts['partneri']   = self::seedSimple('partners', (array) ($data['partners'] ?? []), ['name', 'url']);
        });

        Settings::forget();
        Blocks::forget();
        return $counts;
    }

    /** @param array<string,mixed> $settings */
    private static function seedSettings(array $settings): int
    {
        $n = 0;
        foreach ($settings as $key => $value) {
            if (Db::value('SELECT 1 FROM settings WHERE skey = ?', [$key]) !== null) {
                continue;
            }
            Db::run(
                'INSERT INTO settings (skey, svalue, updated_at) VALUES (?, ?, ?)',
                [(string) $key, (string) $value, Clock::now()]
            );
            $n++;
        }
        return $n;
    }

    /** @param list<array<string,mixed>> $blocks */
    private static function seedBlocks(array $blocks): int
    {
        $n = 0;
        foreach ($blocks as $i => $b) {
            $key = (string) ($b['skey'] ?? '');
            if ($key === '' || Db::value('SELECT 1 FROM blocks WHERE skey = ?', [$key]) !== null) {
                continue;
            }
            Db::insert('blocks', [
                'skey'       => $key,
                'label'      => (string) ($b['label'] ?? $key),
                'hint'       => (string) ($b['hint'] ?? ''),
                'kind'       => (string) ($b['kind'] ?? 'text'),
                'section'    => (string) ($b['section'] ?? 'Ostatné'),
                'value'      => (string) ($b['value'] ?? ''),
                'sort_order' => $i + 1,
                'updated_at' => Clock::now(),
            ]);
            $n++;
        }
        return $n;
    }

    /** @param list<array<string,mixed>> $artists */
    private static function seedArtists(array $artists): int
    {
        $n = 0;
        foreach ($artists as $i => $a) {
            $slug = (string) ($a['slug'] ?? '');
            if ($slug === '' || Db::value('SELECT 1 FROM artists WHERE slug = ?', [$slug]) !== null) {
                continue;
            }
            Db::insert('artists', [
                'slug'         => $slug,
                'name'         => (string) ($a['name'] ?? $slug),
                'tag'          => (string) ($a['tag'] ?? ''),
                'bio'          => (string) ($a['bio'] ?? ''),
                'is_headliner' => (int) ($a['is_headliner'] ?? 0),
                'badge'        => (string) ($a['badge'] ?? ''),
                'sort_order'   => $i + 1,
                'active'       => 1,
                'created_at'   => Clock::now(),
                'updated_at'   => Clock::now(),
            ]);
            $n++;
        }
        return $n;
    }

    /** @param list<array<string,mixed>> $tickets */
    private static function seedTickets(array $tickets): int
    {
        if (Db::value('SELECT COUNT(*) FROM tickets') > 0) {
            return 0;
        }
        $n = 0;
        foreach ($tickets as $i => $t) {
            Db::insert('tickets', [
                'title'      => (string) ($t['title'] ?? ''),
                'subtitle'   => (string) ($t['subtitle'] ?? ''),
                'benefits'   => (string) ($t['benefits'] ?? ''),
                'badge'      => (string) ($t['badge'] ?? ''),
                'highlight'  => (int) ($t['highlight'] ?? 0),
                'sort_order' => $i + 1,
                'active'     => 1,
                'created_at' => Clock::now(),
                'updated_at' => Clock::now(),
            ]);
            $n++;
        }
        return $n;
    }

    /**
     * @param list<array<string,mixed>> $rows
     * @param list<string> $columns
     */
    private static function seedSimple(string $table, array $rows, array $columns): int
    {
        if (Db::value(sprintf('SELECT COUNT(*) FROM %s', $table)) > 0) {
            return 0;
        }
        $n = 0;
        foreach ($rows as $i => $row) {
            $data = ['sort_order' => $i + 1, 'active' => 1, 'created_at' => Clock::now(), 'updated_at' => Clock::now()];
            foreach ($columns as $c) {
                $data[$c] = (string) ($row[$c] ?? '');
            }
            Db::insert($table, $data);
            $n++;
        }
        return $n;
    }

    /**
     * Prvý správca. Heslo musí mať aspoň 10 znakov — admin je jediná
     * brána k obsahu webu.
     */
    public static function createFirstAdmin(string $username, string $password): int
    {
        if (self::isInstalled()) {
            throw new RuntimeException('Správca už existuje. Prihlás sa alebo si obnov heslo cez databázu.');
        }
        $username = trim($username);
        if (!preg_match('/^[a-zA-Z0-9._-]{3,64}$/', $username)) {
            throw new RuntimeException('Prihlasovacie meno: 3–64 znakov, písmená, číslice, bodka, pomlčka alebo podčiarkovník.');
        }
        if (mb_strlen($password) < 10) {
            throw new RuntimeException('Heslo musí mať aspoň 10 znakov.');
        }
        return Auth::createUser($username, $password, Auth::ROLE_ADMIN, $username);
    }

    /** @return list<string> čo ešte nie je v poriadku pred spustením */
    public static function healthChecks(): array
    {
        $problems = [];

        if (!extension_loaded('gd')) {
            $problems[] = 'Chýba rozšírenie GD — nebudú fungovať nahrávané fotky.';
        } elseif (!function_exists('imagewebp')) {
            $problems[] = 'GD nepodporuje WEBP — nahrávanie fotiek zlyhá.';
        }
        if (!is_writable(MAJALES_ROOT . '/uploads')) {
            $problems[] = 'Priečinok uploads/ nie je zapisovateľný (nastav práva 775).';
        }
        if (!is_writable(MAJALES_ROOT . '/storage')) {
            $problems[] = 'Priečinok storage/ nie je zapisovateľný (nastav práva 775).';
        }
        if (trim((string) Config::get('app.app_key', '')) === '') {
            $problems[] = 'V config.php nie je vyplnený app_key — odhlasovacie odkazy z newslettera nebudú bezpečné.';
        }
        if (Config::baseUrl() === '') {
            $problems[] = 'V config.php nie je vyplnená base_url — odkazy v e-mailoch a v sitemape budú neúplné.';
        }
        if (is_file(MAJALES_ROOT . '/install.php') && self::isInstalled()) {
            $problems[] = 'Inštalácia je hotová — zmaž súbor install.php zo servera.';
        }
        return $problems;
    }
}
