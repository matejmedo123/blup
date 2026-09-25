<?php
declare(strict_types=1);

/**
 * Odkazy na obrázky pre web.
 *
 * Dve veci, ktoré sa na zdieľanom hostingu naozaj stávajú:
 *
 * 1. Prehliadač si fotku odloží a pri ďalšej návšteve sa na ňu už nepýta.
 *    To je dobre, kým sa fotka nevymení — vtedy ukazuje mesiac starú.
 *    Hlavičky neovládame (`mod_headers` nemusí byť zapnutý, pred webom môže
 *    stáť cache), tak k adrese pripojíme čas poslednej zmeny súboru. Zmení
 *    sa fotka, zmení sa adresa a odložená kópia je bezpredmetná.
 *
 * 2. V databáze stojí cesta na súbor, ktorý na serveri nie je — prenos cez
 *    FTP prejde len z časti, priečinok `images/` sa nahrá bez niektorých
 *    súborov, alebo sa fotka premenuje. Prehliadač na to odpovie modrým
 *    otáznikom v karte. Preto cestu pred odoslaním overíme a keď súbor
 *    chýba, skúsime jeho zrejmý variant. Keď ani ten nie je, vrátime prázdno
 *    — web vtedy ukáže vlastnú náhradu, nie rozbitý obrázok.
 */
final class Assets
{
    /** @var array<string,string> */
    private static array $cache = [];

    private static ?string $root = null;

    /** Prípony, v ktorých fotky ukladáme. */
    private const EXTENSIONS = ['webp', 'jpg', 'jpeg', 'png'];

    /**
     * Priečinok, v ktorom ležia obrázky webu.
     *
     * Po nasadení je to priečinok vedľa `api/` a `admin/`. Pri vývoji
     * beží PHP z `backend/`, kde `images/` nie sú — tie sú v `public/`
     * (zdroje) a v `out/` (build). Rozhodneme podľa toho, kde priečinok
     * naozaj je, aby sa overovanie ciest dalo otestovať tak, ako beží
     * na ostro.
     */
    public static function root(): string
    {
        if (self::$root !== null) {
            return self::$root;
        }

        $candidates = [
            dirname(__DIR__, 2),             // nasadené: web root
            dirname(__DIR__, 3) . '/public', // vývoj: zdroje
            dirname(__DIR__, 3) . '/out',    // vývoj: build
        ];
        foreach ($candidates as $candidate) {
            if (is_dir($candidate . '/images')) {
                return self::$root = $candidate;
            }
        }

        return self::$root = $candidates[0];
    }

    /**
     * Cesta pripravená pre web: overená a s podpisom verzie.
     * Prázdny výsledok znamená „fotku nemáme“ — web si poradí sám.
     */
    public static function versioned(?string $path): string
    {
        $path = trim((string) $path);
        if ($path === '' || str_contains($path, '?') || !str_starts_with($path, '/')) {
            return $path;
        }
        if (isset(self::$cache[$path])) {
            return self::$cache[$path];
        }

        $resolved = self::resolve($path);

        return self::$cache[$path] = $resolved === null
            // Priečinok nepoznáme — o ceste nevieme rozhodnúť, tak ju nechávame.
            ? $path
            : ($resolved === '' ? '' : $resolved . '?v=' . self::mtime($resolved));
    }

    /**
     * Existuje súbor pre túto cestu?
     * `null` = nevieme posúdiť (priečinok neexistuje, takže sa pozeráme
     * niekam inam než beží web — v takom prípade nič netvrdíme).
     */
    public static function exists(string $path): ?bool
    {
        $path = trim($path);
        if ($path === '' || !str_starts_with($path, '/')) {
            return null;
        }
        $file = self::root() . self::stripQuery($path);
        if (is_file($file)) {
            return true;
        }

        return is_dir(dirname($file)) ? false : null;
    }

    /**
     * Cesta, ktorú web má naozaj použiť.
     *
     * - existujúci súbor → tá istá cesta
     * - chýbajúci súbor a nájdený variant → cesta variantu
     * - chýbajúci súbor bez variantu → prázdny reťazec
     * - neposúditeľné → `null`
     */
    public static function resolve(string $path): ?string
    {
        $path = self::stripQuery(trim($path));
        $state = self::exists($path);
        if ($state === null) {
            return null;
        }
        if ($state === true) {
            return $path;
        }

        return self::alternative($path) ?? '';
    }

    /**
     * Zrejmý variant cesty, ktorej súbor chýba.
     *
     * Fotky z balíka sme raz premenovali (`junior.webp` → `junior-2.webp`),
     * a fotky nahrané z adminu nesú na konci šesť znakov naviac
     * (`junior-184624.webp`). Z názvu sa teda dá uhádnuť, čo tam patrí.
     */
    public static function alternative(string $path): ?string
    {
        $path = self::stripQuery($path);
        $dir  = dirname($path);
        $name = basename($path);
        $ext  = strtolower((string) pathinfo($name, PATHINFO_EXTENSION));
        $base = (string) pathinfo($name, PATHINFO_FILENAME);

        // Kmeň názvu bez toho, čo sme k nemu kedy pridali.
        $stems = [$base];
        if (preg_match('/^(.+)-[0-9a-f]{6}$/', $base, $m) === 1) {
            $stems[] = $m[1];
        }
        if (preg_match('/^(.+)-\d+$/', $base, $m) === 1) {
            $stems[] = $m[1];
        }

        $candidates = [];
        foreach (array_unique($stems) as $stem) {
            foreach ([$stem . '-2', $stem] as $variant) {
                foreach (self::EXTENSIONS as $e) {
                    $candidates[] = $dir . '/' . $variant . '.' . $e;
                }
                // Pôvodná prípona má prednosť pred zoznamom.
                if ($ext !== '') {
                    array_unshift($candidates, $dir . '/' . $variant . '.' . $ext);
                }
            }
        }

        foreach (array_unique($candidates) as $candidate) {
            if ($candidate !== $path && is_file(self::root() . $candidate)) {
                return $candidate;
            }
        }

        return null;
    }

    /** Vyprázdni pamäť — pre testy a pre admin, ktorý súbory mení. */
    public static function forget(): void
    {
        self::$cache = [];
        self::$root  = null;
    }

    private static function mtime(string $path): int
    {
        $time = @filemtime(self::root() . $path);

        return $time === false ? 0 : $time;
    }

    private static function stripQuery(string $path): string
    {
        $cut = strpos($path, '?');

        return $cut === false ? $path : substr($path, 0, $cut);
    }
}
