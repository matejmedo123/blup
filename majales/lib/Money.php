<?php
declare(strict_types=1);

/**
 * Ceny držíme v celých centoch. Float sa na peniaze nepoužíva —
 * 0,1 + 0,2 v ňom nedá 0,3.
 */
final class Money
{
    /** Cena na zobrazenie: 2490 → „24,90 €". */
    public static function format(int $cents): string
    {
        return number_format($cents / 100, 2, ',', "\u{00A0}") . "\u{00A0}€";
    }

    /** Cena do formulára: 2490 → „24,90". */
    public static function input(?int $cents): string
    {
        return $cents === null ? '' : number_format($cents / 100, 2, ',', '');
    }
}
