<?php
declare(strict_types=1);

/**
 * Čísla, ktoré prevádzku zaujímajú.
 *
 * Zrušené a odmietnuté objednávky sa do tržieb nerátajú — inak by
 * štatistika klamala. Kde sa rátajú (napr. koľko sme ich odmietli),
 * je to v názve.
 */
final class Analytics
{
    /** Stavy, ktoré sa počítajú do tržby. */
    private const REVENUE_STATUSES = "('received','accepted','preparing','ready','delivering','picked_up','completed')";

    /**
     * Prehľad za jeden deň.
     *
     * @return array<string,mixed>
     */
    public static function day(?string $date = null): array
    {
        $date  = $date ?? date('Y-m-d');
        $from  = $date . ' 00:00:00';
        $to    = $date . ' 23:59:59';

        $row = Db::one(
            'SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS revenue
             FROM orders
             WHERE created_at BETWEEN ? AND ? AND status IN ' . self::REVENUE_STATUSES,
            [$from, $to]
        ) ?? ['orders' => 0, 'revenue' => 0];

        $orders  = (int) $row['orders'];
        $revenue = (int) $row['revenue'];

        $rejected = (int) (Db::value(
            "SELECT COUNT(*) FROM orders
             WHERE created_at BETWEEN ? AND ? AND status IN ('rejected','cancelled')",
            [$from, $to]
        ) ?? 0);

        return [
            'date'         => $date,
            'orders'       => $orders,
            'revenue'      => $revenue,
            'averageOrder' => $orders > 0 ? (int) round($revenue / $orders) : 0,
            'rejected'     => $rejected,
            'byType'       => self::countBy('order_type', $from, $to),
            'byPayment'    => self::countBy('payment_method', $from, $to),
        ];
    }

    /** Koľko objednávok je práve rozrobených. @return array<string,int> */
    public static function liveCounts(): array
    {
        $out = [
            'received'   => 0,
            'accepted'   => 0,
            'preparing'  => 0,
            'ready'      => 0,
            'delivering' => 0,
        ];
        foreach (Db::all(
            "SELECT status, COUNT(*) AS c FROM orders
             WHERE status IN ('received','accepted','preparing','ready','delivering')
             GROUP BY status"
        ) as $r) {
            $out[(string) $r['status']] = (int) $r['c'];
        }
        return $out;
    }

    /**
     * Najpredávanejšie položky za obdobie.
     *
     * @return list<array{name:string, quantity:int, revenue:int}>
     */
    public static function topProducts(string $from, string $to, int $limit = 10): array
    {
        $rows = Db::all(
            'SELECT i.name, SUM(i.quantity) AS qty, SUM(i.line_cents) AS revenue
             FROM order_items i
             JOIN orders o ON o.id = i.order_id
             WHERE o.created_at BETWEEN ? AND ? AND o.status IN ' . self::REVENUE_STATUSES . '
             GROUP BY i.name
             ORDER BY qty DESC, revenue DESC
             LIMIT ' . max(1, min(50, $limit)),
            [$from, $to]
        );

        return array_map(
            static fn (array $r): array => [
                'name'     => (string) $r['name'],
                'quantity' => (int) $r['qty'],
                'revenue'  => (int) $r['revenue'],
            ],
            $rows
        );
    }

    /**
     * Tržba po dňoch — na jednoduchý graf.
     *
     * @return list<array{date:string, orders:int, revenue:int}>
     */
    public static function daily(int $days = 14): array
    {
        $days = max(1, min(90, $days));
        $from = date('Y-m-d', strtotime("-" . ($days - 1) . " days")) . ' 00:00:00';

        $byDate = [];
        foreach (Db::all(
            'SELECT created_at, total_cents FROM orders
             WHERE created_at >= ? AND status IN ' . self::REVENUE_STATUSES,
            [$from]
        ) as $r) {
            // Zoskupujeme v PHP — DATE() sa v MySQL a SQLite píše rovnako,
            // ale takto sa netreba spoliehať na časovú zónu databázy.
            $d = substr((string) $r['created_at'], 0, 10);
            $byDate[$d]['orders']  = ($byDate[$d]['orders'] ?? 0) + 1;
            $byDate[$d]['revenue'] = ($byDate[$d]['revenue'] ?? 0) + (int) $r['total_cents'];
        }

        $out = [];
        for ($i = $days - 1; $i >= 0; $i--) {
            $d = date('Y-m-d', strtotime("-$i days"));
            $out[] = [
                'date'    => $d,
                'orders'  => (int) ($byDate[$d]['orders'] ?? 0),
                'revenue' => (int) ($byDate[$d]['revenue'] ?? 0),
            ];
        }
        return $out;
    }

    /**
     * Ako dlho prevádzke trvá, kým objednávku prijme, a ako presne
     * odhaduje čas. Tam sa dá najviac zlepšiť.
     *
     * @return array{acceptMedian:?int, prepAverage:?int, lateShare:?float}
     */
    public static function timings(int $days = 30): array
    {
        if (!Db::tableExists('order_status_history')) {
            return ['acceptMedian' => null, 'prepAverage' => null, 'lateShare' => null];
        }
        $from = date('Y-m-d H:i:s', strtotime("-$days days"));

        $accept = [];
        foreach (Db::all(
            "SELECT o.created_at, h.created_at AS accepted_at
             FROM order_status_history h
             JOIN orders o ON o.id = h.order_id
             WHERE h.to_status = 'accepted' AND o.created_at >= ?",
            [$from]
        ) as $r) {
            $secs = strtotime((string) $r['accepted_at']) - strtotime((string) $r['created_at']);
            if ($secs >= 0 && $secs < 7200) {
                $accept[] = $secs;
            }
        }

        $prep = Db::value(
            'SELECT AVG(prep_minutes) FROM orders WHERE prep_minutes IS NOT NULL AND created_at >= ?',
            [$from]
        );

        return [
            // Medián, nie priemer — jedna zabudnutá objednávka cez noc
            // by priemer roztiahla tak, že by nič nehovoril.
            'acceptMedian' => self::median($accept),
            'prepAverage'  => $prep !== null ? (int) round((float) $prep) : null,
            'lateShare'    => self::lateShare($from),
        ];
    }

    /* ------------------------------------------------------------------ */

    /** @return array<string,int> */
    private static function countBy(string $column, string $from, string $to): array
    {
        $allowed = ['order_type', 'payment_method', 'status'];
        if (!in_array($column, $allowed, true)) {
            return [];
        }
        $out = [];
        foreach (Db::all(
            "SELECT $column AS k, COUNT(*) AS c, COALESCE(SUM(total_cents), 0) AS revenue
             FROM orders
             WHERE created_at BETWEEN ? AND ? AND status IN " . self::REVENUE_STATUSES . "
             GROUP BY $column",
            [$from, $to]
        ) as $r) {
            $out[(string) $r['k']] = (int) $r['c'];
        }
        return $out;
    }

    /** @param list<int> $values */
    private static function median(array $values): ?int
    {
        if ($values === []) {
            return null;
        }
        sort($values);
        $mid = intdiv(count($values), 2);
        return count($values) % 2 === 0
            ? (int) round(($values[$mid - 1] + $values[$mid]) / 2)
            : $values[$mid];
    }

    /** Podiel objednávok, ktoré boli hotové neskôr, než sme sľúbili. */
    private static function lateShare(string $from): ?float
    {
        if (!Db::tableExists('order_status_history')) {
            return null;
        }
        $rows = Db::all(
            "SELECT o.ready_at, h.created_at AS done_at
             FROM order_status_history h
             JOIN orders o ON o.id = h.order_id
             WHERE h.to_status = 'ready' AND o.ready_at IS NOT NULL AND o.created_at >= ?",
            [$from]
        );
        if ($rows === []) {
            return null;
        }
        $late = 0;
        foreach ($rows as $r) {
            if (strtotime((string) $r['done_at']) > strtotime((string) $r['ready_at'])) {
                $late++;
            }
        }
        return round($late / count($rows), 3);
    }
}
