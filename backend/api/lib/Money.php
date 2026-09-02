<?php
declare(strict_types=1);

/** Práca s peniazmi v celých centoch — bez zaokrúhľovacích chýb. */
final class Money
{
    public static function fromFloat(float|int|string $eur): int
    {
        return (int) round(((float) $eur) * 100);
    }

    public static function toFloat(int $cents): float
    {
        return $cents / 100;
    }

    /** "9,90 €" — slovenský formát */
    public static function format(int $cents): string
    {
        return number_format($cents / 100, 2, ',', ' ') . ' €';
    }

    /** "9.90 €" — pre tlačenú účtenku a e-maily s pevnou šírkou */
    public static function plain(int $cents): string
    {
        return number_format($cents / 100, 2, '.', '') . ' €';
    }

    /**
     * Rozpis DPH zo sumy vrátane dane.
     * @return array{base:int, vat:int}
     */
    public static function vatFromGross(int $grossCents, float $ratePercent): array
    {
        if ($ratePercent <= 0) {
            return ['base' => $grossCents, 'vat' => 0];
        }
        $base = (int) round($grossCents / (1 + $ratePercent / 100));
        return ['base' => $base, 'vat' => $grossCents - $base];
    }
}
