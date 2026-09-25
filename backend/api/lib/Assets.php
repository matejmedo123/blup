<?php
declare(strict_types=1);

/**
 * Odkazy na obrázky s podpisom verzie.
 *
 * Prehliadač si fotku odloží a pri ďalšej návšteve sa na ňu už nemusí
 * pýtať. To je dobre, kým sa fotka nevymení — vtedy ukazuje mesiac starú.
 * Na hostingu nevieme spoľahlivo ovplyvniť hlavičky (`mod_headers` nemusí
 * byť zapnutý, pred webom môže stáť cache), tak to riešime tam, kde to
 * v rukách máme: k adrese pripojíme čas poslednej zmeny súboru. Keď sa
 * fotka zmení, zmení sa aj adresa a stará kópia je tým pádom bezpredmetná.
 */
final class Assets
{
    /** @var array<string,string> */
    private static array $cache = [];

    /** Priečinok, v ktorom stojí web (vedľa `api/` a `admin/`). */
    private static function root(): string
    {
        return dirname(__DIR__, 2);
    }

    /**
     * K ceste na obrázok doplní `?v=…` podľa času zmeny súboru.
     * Keď súbor nepoznáme, cestu necháme tak — hádať nemá zmysel.
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

        $file = self::root() . $path;
        $time = is_file($file) ? @filemtime($file) : false;

        return self::$cache[$path] = $time === false
            ? $path
            : $path . '?v=' . $time;
    }
}
