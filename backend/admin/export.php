<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';

Auth::requireAdmin();

$month = preg_match('/^\d{4}-\d{2}$/', (string) ($_GET['month'] ?? '')) ? (string) $_GET['month'] : date('Y-m');
$type  = ($_GET['type'] ?? 'orders') === 'items' ? 'items' : 'orders';
$from  = $month . '-01 00:00:00';
$to    = date('Y-m-t 23:59:59', strtotime($month . '-01'));

$filename = "enzo-$type-$month.csv";
header('Content-Type: text/csv; charset=utf-8');
header('Content-Disposition: attachment; filename="' . $filename . '"');
header('Cache-Control: no-store');

$out = fopen('php://output', 'w');
// BOM, aby Excel rozpoznal UTF-8
fwrite($out, "\xEF\xBB\xBF");

/** Zapíše riadok s bodkočiarkou (slovenský Excel) a čiarkou v číslach. */
$row = static function (array $cells) use ($out): void {
    fputcsv($out, $cells, ';', '"', '\\');
};
$num = static fn (int $cents): string => number_format($cents / 100, 2, ',', '');

if ($type === 'orders') {
    $row([
        'Doklad', 'Objednávka', 'Dátum', 'Čas', 'Zákazník', 'Telefón', 'E-mail',
        'Typ', 'Adresa', 'Platba', 'Stav platby', 'Stav objednávky',
        'Medzisúčet', 'Doprava', 'Základ DPH', 'DPH', 'Celkom',
    ]);

    foreach (Db::all(
        "SELECT * FROM orders WHERE created_at >= ? AND created_at <= ? AND status <> 'cancelled' ORDER BY created_at",
        [$from, $to]
    ) as $o) {
        $vat  = json_decode((string) ($o['vat_breakdown'] ?? '[]'), true) ?: [];
        $base = 0;
        $tax  = 0;
        foreach ($vat as $v) {
            $base += (int) $v['base'];
            $tax  += (int) $v['vat'];
        }
        $address = $o['order_type'] === 'pickup'
            ? 'osobný odber'
            : trim(($o['street'] ?? '') . ' ' . ($o['house_number'] ?? '')) . ', '
              . ($o['postal_code'] ?? '') . ' ' . ($o['city'] ?? '');

        $row([
            $o['doc_number'] ?? '',
            $o['order_number'],
            date('d.m.Y', strtotime((string) $o['created_at'])),
            date('H:i', strtotime((string) $o['created_at'])),
            $o['first_name'] . ' ' . $o['last_name'],
            $o['phone'],
            $o['email'],
            $o['order_type'] === 'pickup' ? 'osobný odber' : 'rozvoz',
            $address,
            $o['payment_method'] === 'card' ? 'karta' : 'hotovosť',
            $o['payment_status'] === 'paid' ? 'zaplatené' : 'nezaplatené',
            OrderService::STATUS_LABELS[$o['status']] ?? $o['status'],
            $num((int) $o['subtotal_cents']),
            $num((int) $o['delivery_fee_cents']),
            $base > 0 ? $num($base) : '',
            $tax > 0 ? $num($tax) : '',
            $num((int) $o['total_cents']),
        ]);
    }
} else {
    $row(['Objednávka', 'Dátum', 'Položka', 'Doplnky', 'Množstvo', 'Cena/ks', 'Spolu', 'Sadzba DPH']);

    foreach (Db::all(
        "SELECT oi.*, o.order_number, o.created_at
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.created_at >= ? AND o.created_at <= ? AND o.status <> 'cancelled'
         ORDER BY o.created_at, oi.id",
        [$from, $to]
    ) as $i) {
        $extras = json_decode((string) ($i['extras_json'] ?? '[]'), true) ?: [];
        $row([
            $i['order_number'],
            date('d.m.Y', strtotime((string) $i['created_at'])),
            $i['name'],
            implode(', ', array_map(static fn ($e) => (string) $e['name'], $extras)),
            (int) $i['quantity'],
            $num((int) $i['unit_cents']),
            $num((int) $i['line_cents']),
            $i['vat_group'] === 'drinks' ? 'nápoje' : 'jedlo',
        ]);
    }
}

fclose($out);
