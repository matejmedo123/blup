<?php
declare(strict_types=1);

/**
 * Doručovacie zóny.
 *
 * Každá obec môže mať vlastný poplatok, vlastné minimum a vlastný čas
 * doručenia — do vzdialenejšej dediny sa oplatí vyraziť až pri väčšej
 * objednávke. Keď zóny nie sú nastavené, systém spadne späť na jednotný
 * poplatok z nastavení, aby prevádzka nemusela nič vypĺňať hneď.
 *
 * Zhoda sa hľadá podľa mesta a podľa PSČ — zákazník napíše „Koniarovce“,
 * „koniarovce“ aj „Koniarovce 290“, a všetko to má trafiť tú istú zónu.
 */
final class DeliveryZones
{
    /** @return list<array<string,mixed>> */
    public static function all(bool $onlyActive = true): array
    {
        if (!Db::tableExists('delivery_zones')) {
            return [];
        }
        $sql = 'SELECT * FROM delivery_zones' . ($onlyActive ? ' WHERE is_active = 1' : '') . ' ORDER BY position, id';
        return Db::all($sql);
    }

    /** Sú zóny vôbec nastavené? Ak nie, platí jednotný poplatok z nastavení. */
    public static function configured(): bool
    {
        return self::all() !== [];
    }

    /**
     * Nájde zónu podľa mesta a PSČ zákazníka.
     *
     * @return array<string,mixed>|null null = mimo rozvozu
     */
    public static function match(?string $city, ?string $postalCode): ?array
    {
        $zones = self::all();
        if ($zones === []) {
            return null;
        }

        $cityKey = self::normalize((string) $city);
        $psc     = preg_replace('/\D+/', '', (string) $postalCode) ?? '';

        foreach ($zones as $zone) {
            // PSČ je presnejšie, tak ho skúšame ako prvé
            if ($psc !== '') {
                foreach (self::codes($zone) as $code) {
                    if ($code === $psc) {
                        return $zone;
                    }
                }
            }
        }

        foreach ($zones as $zone) {
            $zoneKey = self::normalize((string) $zone['name']);
            if ($zoneKey === '' || $cityKey === '') {
                continue;
            }
            // „Koniarovce 290“ aj „koniarovce“ patria do zóny Koniarovce
            if ($cityKey === $zoneKey || str_starts_with($cityKey, $zoneKey . ' ')) {
                return $zone;
            }
        }

        return null;
    }

    /**
     * Poplatok za doručenie pre danú zónu a hodnotu košíka.
     * Nad hranicou „zdarma od“ je doručenie zadarmo.
     */
    public static function feeFor(?array $zone, int $subtotalCents): int
    {
        if ($zone === null) {
            $free = Settings::cents('free_delivery_from');
            return ($free > 0 && $subtotalCents >= $free) ? 0 : Settings::cents('delivery_fee');
        }

        $free = $zone['free_from_cents'] !== null ? (int) $zone['free_from_cents'] : 0;
        if ($free > 0 && $subtotalCents >= $free) {
            return 0;
        }
        return (int) $zone['fee_cents'];
    }

    /** Minimálna hodnota objednávky pre zónu (alebo celoplošná). */
    public static function minOrderFor(?array $zone): int
    {
        $global = Settings::cents('min_order');
        if ($zone === null) {
            return $global;
        }
        $zoneMin = (int) $zone['min_order_cents'];
        return $zoneMin > 0 ? $zoneMin : $global;
    }

    /** Tvar pre verejné API — zákazník vidí, kam vozíme a za koľko. */
    public static function publicList(): array
    {
        $out = [];
        foreach (self::all() as $z) {
            $out[] = [
                'name'        => (string) $z['name'],
                'fee'         => Money::toFloat((int) $z['fee_cents']),
                'minOrder'    => Money::toFloat(self::minOrderFor($z)),
                'freeFrom'    => $z['free_from_cents'] !== null
                    ? Money::toFloat((int) $z['free_from_cents'])
                    : null,
                'etaMinutes'  => (int) $z['eta_minutes'],
            ];
        }
        return $out;
    }

    /* ------------------------------------------------------------------ */

    /** @return list<string> */
    private static function codes(array $zone): array
    {
        $raw = (string) ($zone['postal_codes'] ?? '');
        if (trim($raw) === '') {
            return [];
        }
        $out = [];
        foreach (preg_split('/[,;\s]+/', $raw) ?: [] as $code) {
            $digits = preg_replace('/\D+/', '', $code) ?? '';
            if ($digits !== '') {
                $out[] = $digits;
            }
        }
        return $out;
    }

    /** Bez diakritiky, malé písmená, jedna medzera — nech sa dá porovnávať. */
    private static function normalize(string $value): string
    {
        $value = mb_strtolower(trim($value));
        $map = [
            'á'=>'a','ä'=>'a','č'=>'c','ď'=>'d','é'=>'e','í'=>'i','ĺ'=>'l','ľ'=>'l',
            'ň'=>'n','ó'=>'o','ô'=>'o','ŕ'=>'r','š'=>'s','ť'=>'t','ú'=>'u','ý'=>'y','ž'=>'z',
        ];
        $value = strtr($value, $map);
        return trim(preg_replace('/\s+/', ' ', $value) ?? '');
    }
}
