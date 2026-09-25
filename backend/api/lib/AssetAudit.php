<?php
declare(strict_types=1);

/**
 * Kontrola fotiek: čo je v databáze zapísané verzus čo na serveri naozaj leží.
 *
 * Web sa nasadzuje prenosom súborov cez FTP a to je operácia, ktorá môže
 * prejsť len z časti — priečinok `images/` sa nahrá bez niektorých fotiek
 * a v karte burgra potom svieti modrý otáznik. Databáza o tom nevie, lebo
 * cestu má zapísanú v poriadku. Táto trieda to porovná a prevádzka vidí
 * čierne na bielom, ktorá fotka chýba a čo s ňou.
 */
final class AssetAudit
{
    /** Kľúče nastavení, v ktorých stojí cesta na ilustračnú fotku. */
    private const CONTENT_KEYS = [
        'content_hero_image'   => 'Veľká fotka navrchu stránky',
        'content_promo1_image' => 'Dlaždica 1',
        'content_promo2_image' => 'Dlaždica 2',
        'content_promo3_image' => 'Dlaždica 3',
        'content_story1_image' => 'Fotka pri značke — vľavo',
        'content_story2_image' => 'Fotka pri značke — vpravo',
    ];

    /**
     * Prehľad všetkých fotiek, ktoré web z databázy berie.
     *
     * `state`: `ok` súbor je na mieste; `alternative` súbor chýba, ale
     * našli sme jeho variant; `missing` súbor chýba a variant nie je;
     * `unknown` priečinok `images/` nevidíme, tak netvrdíme nič.
     *
     * @return list<array{kind:string,label:string,where:string,path:string,state:string,suggestion:?string,settingKey:?string}>
     */
    public static function report(): array
    {
        $rows = [];

        foreach (Db::all("SELECT id, slug, name, image FROM products WHERE image IS NOT NULL AND image <> '' ORDER BY category_id, position") as $p) {
            $rows[] = self::row(
                'product',
                (string) $p['name'],
                'product.php?id=' . (int) $p['id'],
                (string) $p['image'],
            );
        }

        foreach (self::CONTENT_KEYS as $key => $label) {
            $path = trim((string) Settings::get($key, ''));
            if ($path === '') {
                continue;
            }
            $rows[] = self::row('content', $label, 'content.php', $path, $key);
        }

        return $rows;
    }

    /** Koľko fotiek nie je v poriadku (chýba alebo sa nahradila variantom). */
    public static function brokenCount(): int
    {
        $n = 0;
        foreach (self::report() as $row) {
            if ($row['state'] === 'missing' || $row['state'] === 'alternative') {
                $n++;
            }
        }

        return $n;
    }

    /**
     * Prepíše cesty, pre ktoré sa našiel existujúci variant súboru.
     *
     * Web tie fotky zobrazuje správne aj bez toho (`Assets` si variant
     * nájde pri každej odpovedi), ale v admine má stáť to, čo je pravda —
     * inak prevádzka pri ďalšej úprave uloží späť mŕtvu cestu.
     *
     * @return int počet opravených ciest
     */
    public static function repair(): int
    {
        $fixed = 0;
        $now   = date('Y-m-d H:i:s');

        foreach (self::report() as $row) {
            if ($row['state'] !== 'alternative' || $row['suggestion'] === null) {
                continue;
            }
            if ($row['kind'] === 'product') {
                Db::run(
                    'UPDATE products SET image = ?, updated_at = ? WHERE image = ?',
                    [$row['suggestion'], $now, $row['path']]
                );
            } else {
                Settings::set($row['settingKey'], $row['suggestion']);
            }
            $fixed++;
        }

        Assets::forget();

        return $fixed;
    }

    /**
     * @return array{kind:string,label:string,where:string,path:string,state:string,suggestion:?string,settingKey:?string}
     */
    private static function row(
        string $kind,
        string $label,
        string $where,
        string $path,
        ?string $settingKey = null,
    ): array {
        $exists = Assets::exists($path);
        $alt    = $exists === false ? Assets::alternative($path) : null;

        $state = match (true) {
            $exists === null  => 'unknown',
            $exists === true  => 'ok',
            $alt !== null     => 'alternative',
            default           => 'missing',
        };

        return [
            'kind'       => $kind,
            'label'      => $label,
            'where'      => $where,
            'path'       => $path,
            'state'      => $state,
            'suggestion' => $alt,
            'settingKey' => $settingKey,
        ];
    }
}
