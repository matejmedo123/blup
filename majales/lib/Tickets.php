<?php
declare(strict_types=1);

/**
 * Typy vstupeniek. Kým nie je predaj spustený, na kartách je namiesto
 * ceny nápis „ČOSKORO" — cena sa dá pripraviť dopredu a neukáže sa,
 * kým to obsluha v nastaveniach nezapne.
 */
final class Tickets extends Repo
{
    public static function table(): string
    {
        return 'tickets';
    }

    public static function fillable(): array
    {
        return ['title', 'subtitle', 'benefits', 'price_cents', 'badge', 'buy_url', 'highlight'];
    }

    public static function saleLive(): bool
    {
        return Settings::bool('sale_live', false);
    }

    /**
     * Čo sa ukáže na mieste ceny. Poradie je zámerné: bez spusteného
     * predaja nikdy neukážeme cenu, aj keby už v databáze bola.
     *
     * @param array<string,mixed> $ticket
     */
    public static function priceLabel(array $ticket): string
    {
        if (!self::saleLive()) {
            return Settings::get('sale_label_soon', 'ČOSKORO');
        }
        $cents = $ticket['price_cents'];
        if ($cents === null || $cents === '') {
            return Settings::get('sale_label_live', 'V PREDAJI');
        }
        return Money::format((int) $cents);
    }

    /**
     * Odkaz na kúpu konkrétnej vstupenky — vlastný, alebo spoločný
     * z nastavení. Kým predaj nebeží, tlačidlo sa nezobrazuje.
     *
     * @param array<string,mixed> $ticket
     */
    public static function buyUrl(array $ticket): string
    {
        if (!self::saleLive()) {
            return '';
        }
        $own = Html::safeUrl((string) ($ticket['buy_url'] ?? ''));
        return $own !== '' ? $own : Html::safeUrl(Settings::get('tickets_url', ''));
    }
}
