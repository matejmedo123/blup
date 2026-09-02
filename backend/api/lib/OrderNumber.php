<?php
declare(strict_types=1);

/**
 * Číslovanie objednávok a dokladov.
 *
 * - order_number: ENZO-1042 — priebežné, používa ho zákazník aj kuchyňa
 * - doc_number:   2026/000123 — účtovný číselný rad, prideľuje sa až po
 *   zaplatení/vybavení, aby v rade neostali diery po zrušených objednávkach
 */
final class OrderNumber
{
    public static function nextOrderNumber(string $prefix = 'ENZO'): string
    {
        $last = Db::value(
            "SELECT order_number FROM orders WHERE order_number LIKE ? ORDER BY id DESC LIMIT 1",
            [$prefix . '-%']
        );
        $n = $last ? (int) substr((string) $last, strlen($prefix) + 1) : 1041;
        return $prefix . '-' . ($n + 1);
    }

    public static function nextDocNumber(): string
    {
        $year = date('Y');
        $last = Db::value(
            "SELECT doc_number FROM orders WHERE doc_number LIKE ? ORDER BY id DESC LIMIT 1",
            [$year . '/%']
        );
        $n = $last ? (int) substr((string) $last, 5) : 0;
        return $year . '/' . str_pad((string) ($n + 1), 6, '0', STR_PAD_LEFT);
    }
}
