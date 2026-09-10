<?php
declare(strict_types=1);

/**
 * Vyťaženie kuchyne a automatické predlžovanie sľúbených časov.
 *
 * Keď je na platni desať objednávok, sľúbiť ďalšiemu zákazníkovi tých
 * istých 20 minút je klamstvo — a obsluha to potom rieši telefonátmi.
 * Systém preto sám sleduje, koľko objednávok je rozrobených, a k časom
 * na webe pripočíta toľko minút, koľko dáva zmysel.
 *
 * Ráta sa len to, čo kuchyňa ešte má spraviť (prijaté, potvrdené,
 * na platni). Hotové jedlo, ktoré čaká na kuriéra, už kuchyňu nezdržuje.
 *
 * Historické objednávky sa tým nemenia — predĺženie sa dotýka len toho,
 * čo systém sľubuje odteraz. Čas konkrétnej objednávky ostáva ten, ktorý
 * obsluha odklikla pri prijatí.
 */
final class Workload
{
    /** Stavy, v ktorých objednávka ešte zaberá kuchyňu. */
    private const IN_KITCHEN = ['received', 'accepted', 'preparing'];

    /** @var array<string,mixed>|null */
    private static ?array $cache = null;

    /**
     * Aktuálny stav vyťaženia.
     *
     * @return array{enabled:bool,inFlight:int,capacity:int,extraMinutes:int,level:string,note:string}
     */
    public static function snapshot(): array
    {
        if (self::$cache !== null) {
            return self::$cache;
        }

        $enabled  = Settings::bool('auto_prep_enabled');
        $capacity = max(1, Settings::int('auto_prep_capacity'));
        $step     = max(1, Settings::int('auto_prep_step'));
        $max      = max(0, Settings::int('auto_prep_max'));
        $inFlight = self::inKitchen();

        $extra = 0;
        if ($enabled && $inFlight > $capacity) {
            // Za každú ďalšiu dávku veľkosti kapacity pridáme jeden krok.
            $batches = (int) ceil(($inFlight - $capacity) / $capacity);
            $extra   = min($max, $batches * $step);
        }

        $level = $extra === 0 ? 'calm' : ($extra >= $max ? 'slammed' : 'busy');

        return self::$cache = [
            'enabled'      => $enabled,
            'inFlight'     => $inFlight,
            'capacity'     => $capacity,
            'extraMinutes' => $extra,
            'level'        => $level,
            'note'         => $extra === 0
                ? ''
                : 'Máme nabito — časy sú dlhšie ako zvyčajne o ' . $extra . ' minút.',
        ];
    }

    /** Koľko objednávok má kuchyňa práve na krku. */
    public static function inKitchen(): int
    {
        $marks = implode(',', array_fill(0, count(self::IN_KITCHEN), '?'));
        try {
            $row = Db::one("SELECT COUNT(*) AS c FROM orders WHERE status IN ($marks)", self::IN_KITCHEN);
        } catch (Throwable) {
            return 0; // bez tabuľky sa časy jednoducho nepredlžujú
        }
        return (int) ($row['c'] ?? 0);
    }

    /** Koľko minút sa práve pripočítava. */
    public static function extraMinutes(): int
    {
        return (int) self::snapshot()['extraMinutes'];
    }

    /**
     * Predĺži časy v texte, ktorý vidí zákazník.
     *
     * Text si píše prevádzka sama („15 — 25 min“, „do pol hodiny nie sme“),
     * tak nepredpokladáme tvar — pripočítame ku každému číslu v ňom.
     */
    public static function stretchText(string $text, ?int $extra = null): string
    {
        $extra ??= self::extraMinutes();
        if ($extra === 0 || $text === '') {
            return $text;
        }
        return (string) preg_replace_callback(
            '/\d+/',
            static fn (array $m) => (string) ((int) $m[0] + $extra),
            $text,
        );
    }

    /** Predĺži počet minút, nikdy nie do zápornej hodnoty. */
    public static function stretchMinutes(int $minutes, ?int $extra = null): int
    {
        return max(0, $minutes + ($extra ?? self::extraMinutes()));
    }

    /**
     * Minutáž, ktorú nástenka obsluhe predvyberie pri prijímaní objednávky.
     * Je to návrh, nie príkaz — obsluha ho jedným klikom prebije.
     */
    public static function suggestedMinutes(): int
    {
        return self::stretchMinutes(max(5, Settings::int('default_prep_minutes')));
    }

    /** Po zmene nastavení alebo objednávok treba prepočítať nanovo. */
    public static function forget(): void
    {
        self::$cache = null;
    }
}
