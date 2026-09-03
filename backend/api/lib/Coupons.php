<?php
declare(strict_types=1);

/**
 * Zľavové kódy.
 *
 * Tri druhy stačia na všetko, čo malá prevádzka reálne robí:
 *  - `percent`      … zľava v percentách z medzisúčtu
 *  - `fixed`        … zľava v eurách
 *  - `free_delivery`… doručenie zdarma
 *
 * Zľava sa vždy počíta z medzisúčtu (jedlo), nie z poplatku za doručenie,
 * a nikdy nespraví objednávku zápornú.
 *
 * Kód platí, len keď je aktívny, v termíne, nevyčerpaný a košík dosiahol
 * jeho minimum. Overuje sa na serveri pri každej objednávke — to, že ho
 * frontend zobrazil ako platný, nič neznamená.
 */
final class Coupons
{
    public const PERCENT       = 'percent';
    public const FIXED         = 'fixed';
    public const FREE_DELIVERY = 'free_delivery';

    /**
     * Overí kód a vypočíta zľavu.
     *
     * @return array{coupon:array<string,mixed>, discount:int, freeDelivery:bool}
     * @throws OrderException keď kód neplatí
     */
    public static function apply(string $code, int $subtotalCents, int $deliveryFeeCents): array
    {
        $coupon = self::find($code);

        if ($coupon === null) {
            throw new OrderException(ErrorCode::INVALID_COUPON, 'Takýto zľavový kód nepoznáme.', ['coupon' => 'Neplatný kód']);
        }
        if ((int) $coupon['is_active'] !== 1) {
            throw new OrderException(ErrorCode::INVALID_COUPON, 'Tento kód už neplatí.', ['coupon' => 'Kód už neplatí']);
        }

        $now = date('Y-m-d H:i:s');
        if (!empty($coupon['starts_at']) && $now < (string) $coupon['starts_at']) {
            throw new OrderException(ErrorCode::INVALID_COUPON, 'Tento kód ešte nezačal platiť.', ['coupon' => 'Kód ešte neplatí']);
        }
        if (!empty($coupon['ends_at']) && $now > (string) $coupon['ends_at']) {
            throw new OrderException(ErrorCode::INVALID_COUPON, 'Platnosť tohto kódu vypršala.', ['coupon' => 'Kódu vypršala platnosť']);
        }

        $maxUses = $coupon['max_uses'] !== null ? (int) $coupon['max_uses'] : null;
        if ($maxUses !== null && (int) $coupon['used_count'] >= $maxUses) {
            throw new OrderException(ErrorCode::INVALID_COUPON, 'Tento kód už bol vyčerpaný.', ['coupon' => 'Kód je vyčerpaný']);
        }

        $min = (int) $coupon['min_order_cents'];
        if ($min > 0 && $subtotalCents < $min) {
            throw new OrderException(
                ErrorCode::INVALID_COUPON,
                'Kód platí od objednávky za ' . Money::format($min) . '.',
                ['coupon' => 'Objednávka je pod hranicou pre tento kód']
            );
        }

        $kind  = (string) $coupon['kind'];
        $value = (int) $coupon['value'];

        $discount     = 0;
        $freeDelivery = false;

        if ($kind === self::PERCENT) {
            $percent  = max(0, min(100, $value));
            $discount = (int) round($subtotalCents * $percent / 100);
        } elseif ($kind === self::FIXED) {
            $discount = $value;
        } elseif ($kind === self::FREE_DELIVERY) {
            $freeDelivery = $deliveryFeeCents > 0;
        }

        // Zľava nikdy neprevýši cenu jedla — objednávka sa nesmie dostať do mínusu.
        $discount = max(0, min($discount, $subtotalCents));

        return ['coupon' => $coupon, 'discount' => $discount, 'freeDelivery' => $freeDelivery];
    }

    /**
     * Zaznamená použitie kódu. Volá sa až po uložení objednávky,
     * v tej istej transakcii — nech sa nevyčerpá kód pri objednávke,
     * ktorá napokon nevznikla.
     */
    public static function markUsed(int $couponId): void
    {
        Db::run('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?', [$couponId]);
    }

    /** @return array<string,mixed>|null */
    public static function find(string $code): ?array
    {
        $code = self::normalize($code);
        if ($code === '' || !Db::tableExists('coupons')) {
            return null;
        }
        return Db::one('SELECT * FROM coupons WHERE UPPER(code) = ?', [$code]);
    }

    /** Ako zľavu pomenovať na doklade a v e-maile. */
    public static function label(array $coupon): string
    {
        $code = (string) $coupon['code'];
        return match ((string) $coupon['kind']) {
            self::PERCENT       => "Zľava $code (−" . (int) $coupon['value'] . ' %)',
            self::FIXED         => "Zľava $code",
            self::FREE_DELIVERY => "Doručenie zdarma ($code)",
            default             => "Zľava $code",
        };
    }

    public static function normalize(string $code): string
    {
        return mb_strtoupper(trim($code));
    }
}
