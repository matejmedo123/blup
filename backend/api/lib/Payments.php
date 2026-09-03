<?php
declare(strict_types=1);

/**
 * Platby vedené oddelene od objednávok.
 *
 * Stav objednávky a stav platby sú dve rôzne veci: objednávka môže byť
 * vybavená a nezaplatená (faktúra), aj zaplatená a zrušená (čaká na
 * vrátenie peňazí). Preto majú vlastnú tabuľku a vlastné stavy.
 *
 *   pending → paid → refund_pending → refunded
 *      └────→ failed
 *
 * Stĺpce `payment_status` v `orders` zostávajú ako rýchly pohľad pre
 * prehľady a export; zdrojom pravdy je táto tabuľka.
 */
final class Payments
{
    public const PENDING        = 'pending';
    public const AUTHORIZED     = 'authorized';
    public const PAID           = 'paid';
    public const FAILED         = 'failed';
    public const REFUND_PENDING = 'refund_pending';
    public const REFUNDED       = 'refunded';

    public const LABEL = [
        self::PENDING        => 'Čaká na úhradu',
        self::AUTHORIZED     => 'Blokované na karte',
        self::PAID           => 'Zaplatené',
        self::FAILED         => 'Platba zlyhala',
        self::REFUND_PENDING => 'Vraciame peniaze',
        self::REFUNDED       => 'Vrátené',
    ];

    /** Založí evidenciu platby k novej objednávke. */
    public static function openFor(array $order): ?int
    {
        if (!Db::tableExists('payments')) {
            return null;
        }
        $existing = Db::value('SELECT id FROM payments WHERE order_id = ?', [$order['id']]);
        if ($existing !== null) {
            return (int) $existing;
        }

        $method = (string) $order['payment_method'];
        $now    = date('Y-m-d H:i:s');

        return Db::insert('payments', [
            'order_id'       => (int) $order['id'],
            'provider'       => $method === 'card' ? 'stripe' : 'cash',
            'method'         => $method,
            'status'         => self::PENDING,
            'amount_cents'   => (int) $order['total_cents'],
            'currency'       => 'EUR',
            'reference'      => null,
            'detail'         => null,
            'paid_at'        => null,
            'refunded_cents' => 0,
            'created_at'     => $now,
            'updated_at'     => $now,
        ]);
    }

    /**
     * Označí platbu za uhradenú.
     *
     * Referencia od providera je v databáze unikátna, takže opakovane
     * doručený webhook druhýkrát neprejde — a my sa to dozvieme podľa
     * návratovej hodnoty namiesto toho, aby sme platbu zaúčtovali dvakrát.
     *
     * @return bool true = teraz sme ju naozaj označili, false = už bola
     */
    public static function markPaid(int $orderId, string $reference, string $method = 'card', ?string $detail = null): bool
    {
        if (!Db::tableExists('payments')) {
            return false;
        }
        $reference = mb_substr(trim($reference), 0, 190);
        $now       = date('Y-m-d H:i:s');

        // Tá istá referencia už raz prešla — ide o opakovaný webhook.
        if ($reference !== '') {
            $seen = Db::one('SELECT id, order_id, status FROM payments WHERE reference = ?', [$reference]);
            if ($seen !== null && (string) $seen['status'] === self::PAID) {
                return false;
            }
        }

        $payment = Db::one('SELECT * FROM payments WHERE order_id = ? ORDER BY id LIMIT 1', [$orderId]);
        if ($payment === null) {
            $order = Db::one('SELECT * FROM orders WHERE id = ?', [$orderId]);
            if ($order === null) {
                return false;
            }
            self::openFor($order);
            $payment = Db::one('SELECT * FROM payments WHERE order_id = ? ORDER BY id LIMIT 1', [$orderId]);
        }
        if ($payment === null || (string) $payment['status'] === self::PAID) {
            return false;
        }

        // Podmienený UPDATE — keď dva webhooky dorazia naraz, prejde jeden.
        $affected = Db::run(
            'UPDATE payments SET status = ?, reference = ?, method = ?, detail = ?, paid_at = ?, updated_at = ?
             WHERE id = ? AND status <> ?',
            [self::PAID, $reference !== '' ? $reference : null, $method, $detail, $now, $now, $payment['id'], self::PAID]
        )->rowCount();

        return $affected > 0;
    }

    public static function markFailed(int $orderId, string $detail = ''): void
    {
        if (!Db::tableExists('payments')) {
            return;
        }
        Db::run(
            'UPDATE payments SET status = ?, detail = ?, updated_at = ? WHERE order_id = ? AND status = ?',
            [self::FAILED, mb_substr($detail, 0, 500), date('Y-m-d H:i:s'), $orderId, self::PENDING]
        );
    }

    /**
     * Zaeviduje vrátenie peňazí. Samotný prevod robí platobná brána,
     * tu si len vedieme, koľko sa vrátilo.
     */
    public static function markRefunded(int $orderId, ?int $amountCents = null, string $detail = ''): void
    {
        if (!Db::tableExists('payments')) {
            return;
        }
        $payment = Db::one('SELECT * FROM payments WHERE order_id = ? ORDER BY id LIMIT 1', [$orderId]);
        if ($payment === null) {
            return;
        }
        $amount = $amountCents ?? (int) $payment['amount_cents'];
        Db::run(
            'UPDATE payments SET status = ?, refunded_cents = ?, detail = ?, updated_at = ? WHERE id = ?',
            [self::REFUNDED, $amount, mb_substr($detail, 0, 500), date('Y-m-d H:i:s'), $payment['id']]
        );
        Db::run('UPDATE orders SET payment_status = ? WHERE id = ?', ['refunded', $orderId]);
    }

    /** @return array<string,mixed>|null */
    public static function forOrder(int $orderId): ?array
    {
        if (!Db::tableExists('payments')) {
            return null;
        }
        return Db::one('SELECT * FROM payments WHERE order_id = ? ORDER BY id LIMIT 1', [$orderId]);
    }

    /**
     * Zapamätá si, že sme udalosť od providera už spracovali.
     *
     * @return bool true = je nová, false = už sme ju videli
     */
    public static function claimEvent(string $provider, string $eventId, string $eventType): bool
    {
        if ($eventId === '' || !Db::tableExists('payment_events')) {
            return true;
        }
        try {
            Db::insert('payment_events', [
                'payment_id'   => null,
                'provider'     => $provider,
                'event_id'     => mb_substr($eventId, 0, 190),
                'event_type'   => mb_substr($eventType, 0, 60),
                'processed_at' => date('Y-m-d H:i:s'),
            ]);
            return true;
        } catch (Throwable) {
            // Unikátny index (provider, event_id) — túto udalosť už máme.
            return false;
        }
    }
}
