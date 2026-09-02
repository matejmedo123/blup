<?php
declare(strict_types=1);

/**
 * Jadro objednávok: prepočet cien na serveri, uloženie, prechody stavov.
 *
 * Ceny sa NIKDY nepreberajú od klienta — berú sa z databázy podľa slugu.
 * Klient posiela len čo a koľko kusov.
 */
final class OrderService
{
    public const STATUS_RECEIVED  = 'received';   // prijatá, čaká na prevádzku
    public const STATUS_CONFIRMED = 'confirmed';  // prevádzka potvrdila čas
    public const STATUS_READY     = 'ready';      // hotové / kuriér vyrazil
    public const STATUS_COMPLETED = 'completed';  // vybavená
    public const STATUS_CANCELLED = 'cancelled';

    public const STATUS_LABELS = [
        self::STATUS_RECEIVED  => 'Prijatá',
        self::STATUS_CONFIRMED => 'Potvrdená',
        self::STATUS_READY     => 'Pripravená',
        self::STATUS_COMPLETED => 'Vybavená',
        self::STATUS_CANCELLED => 'Zrušená',
    ];

    /**
     * Prepočíta košík podľa cien v databáze.
     *
     * @param list<array<string,mixed>> $items surové položky od klienta
     * @return array{items:list<array<string,mixed>>, subtotal:int, errors:list<string>}
     */
    public static function priceCart(array $items, string $orderType): array
    {
        $priced   = [];
        $errors   = [];
        $subtotal = 0;

        foreach ($items as $raw) {
            $slug = Validate::clean($raw['productId'] ?? $raw['slug'] ?? '', 80);
            $qty  = (int) ($raw['quantity'] ?? 0);
            if ($slug === '' || $qty < 1) {
                continue;
            }
            $qty = min($qty, 50);

            $product = Db::one(
                'SELECT p.*, c.slug AS category_slug FROM products p
                 JOIN categories c ON c.id = p.category_id
                 WHERE p.slug = ?',
                [$slug]
            );
            if ($product === null) {
                $errors[] = "Položka \u{201E}$slug\u{201C} u\u{17E} nie je v ponuke.";
                continue;
            }
            if ((int) $product['is_available'] !== 1) {
                $errors[] = 'Položka „' . $product['name'] . '“ je momentálne vypredaná.';
                continue;
            }

            // doplnky — akceptujeme len tie, ktoré sú k produktu naozaj priradené
            $allowed = [];
            foreach (Db::all(
                'SELECT e.slug, e.name, e.price_cents FROM extras e
                 JOIN product_extras pe ON pe.extra_id = e.id
                 WHERE pe.product_id = ? AND e.is_active = 1',
                [$product['id']]
            ) as $e) {
                $allowed[$e['slug']] = $e;
            }

            $chosen      = [];
            $extrasCents = 0;
            foreach ((array) ($raw['extras'] ?? []) as $ex) {
                $exSlug = Validate::clean(is_array($ex) ? ($ex['id'] ?? '') : $ex, 64);
                if ($exSlug !== '' && isset($allowed[$exSlug])) {
                    $chosen[] = [
                        'id'    => $exSlug,
                        'name'  => $allowed[$exSlug]['name'],
                        'price' => Money::toFloat((int) $allowed[$exSlug]['price_cents']),
                    ];
                    $extrasCents += (int) $allowed[$exSlug]['price_cents'];
                }
            }

            $base = (int) $product['price_cents'];
            $unit = $base + $extrasCents;
            $line = $unit * $qty;
            $subtotal += $line;

            $priced[] = [
                'product_slug' => $product['slug'],
                'name'         => $product['name'],
                'base_cents'   => $base,
                'extras_cents' => $extrasCents,
                'unit_cents'   => $unit,
                'quantity'     => $qty,
                'line_cents'   => $line,
                'extras'       => $chosen,
                'note'         => Validate::clean($raw['note'] ?? '', 200),
                'vat_group'    => $product['vat_group'] ?: 'food',
                'image'        => $product['image'],
            ];
        }

        return ['items' => $priced, 'subtotal' => $subtotal, 'errors' => $errors];
    }

    public static function deliveryFee(int $subtotalCents, string $orderType): int
    {
        if ($orderType === 'pickup') {
            return 0;
        }
        $freeFrom = Settings::cents('free_delivery_from');
        if ($freeFrom > 0 && $subtotalCents >= $freeFrom) {
            return 0;
        }
        return Settings::cents('delivery_fee');
    }

    /**
     * Rozpis DPH podľa skupín položiek.
     * @param list<array<string,mixed>> $items
     * @return array<string,array{rate:float,base:int,vat:int,gross:int}>
     */
    public static function vatBreakdown(array $items, int $deliveryFee, array $accounting): array
    {
        if (empty($accounting['vat_payer'])) {
            return [];
        }
        $rates = [
            'food'   => (float) ($accounting['vat_food'] ?? 0),
            'drinks' => (float) ($accounting['vat_drinks'] ?? 0),
        ];
        $gross = ['food' => 0, 'drinks' => 0];
        foreach ($items as $i) {
            $g = ($i['vat_group'] ?? 'food') === 'drinks' ? 'drinks' : 'food';
            $gross[$g] += (int) $i['line_cents'];
        }
        $gross['food'] += $deliveryFee;   // doprava sa daní ako hlavné plnenie

        $out = [];
        foreach ($gross as $group => $amount) {
            if ($amount <= 0) {
                continue;
            }
            $split = Money::vatFromGross($amount, $rates[$group]);
            $out[$group] = [
                'rate'  => $rates[$group],
                'base'  => $split['base'],
                'vat'   => $split['vat'],
                'gross' => $amount,
            ];
        }
        return $out;
    }

    /**
     * Uloží objednávku. Vracia kompletný záznam vrátane položiek.
     *
     * @param list<array<string,mixed>> $pricedItems
     * @param array<string,mixed>       $customer
     * @return array<string,mixed>
     */
    public static function create(
        array $pricedItems,
        array $customer,
        string $orderType,
        string $paymentMethod,
        int $subtotal,
        int $deliveryFee,
        array $vatBreakdown,
    ): array {
        $now   = date('Y-m-d H:i:s');
        $total = $subtotal + $deliveryFee;

        return Db::transaction(static function () use (
            $pricedItems, $customer, $orderType, $paymentMethod,
            $subtotal, $deliveryFee, $total, $vatBreakdown, $now
        ) {
            $orderId = Db::insert('orders', [
                'order_number'       => OrderNumber::nextOrderNumber(),
                'access_token'       => bin2hex(random_bytes(16)),
                'status'             => self::STATUS_RECEIVED,
                'order_type'         => $orderType,
                'payment_method'     => $paymentMethod,
                'payment_status'     => 'unpaid',
                'first_name'         => Validate::clean($customer['firstName'] ?? '', 80),
                'last_name'          => Validate::clean($customer['lastName'] ?? '', 80),
                'phone'              => Validate::clean($customer['phone'] ?? '', 40),
                'email'              => Validate::clean($customer['email'] ?? '', 190),
                'street'             => Validate::clean($customer['street'] ?? '', 160) ?: null,
                'house_number'       => Validate::clean($customer['houseNumber'] ?? '', 30) ?: null,
                'city'               => Validate::clean($customer['city'] ?? '', 120) ?: null,
                'postal_code'        => Validate::clean($customer['postalCode'] ?? '', 20) ?: null,
                'note'               => Validate::clean($customer['note'] ?? '', 500) ?: null,
                'pickup_time'        => Validate::clean($customer['pickupTime'] ?? '', 60) ?: null,
                'subtotal_cents'     => $subtotal,
                'delivery_fee_cents' => $deliveryFee,
                'total_cents'        => $total,
                'vat_breakdown'      => $vatBreakdown ? json_encode($vatBreakdown, JSON_UNESCAPED_UNICODE) : null,
                'customer_ip'        => Response::clientIp(),
                'user_agent'         => Validate::clean($_SERVER['HTTP_USER_AGENT'] ?? '', 255) ?: null,
                'created_at'         => $now,
                'updated_at'         => $now,
            ]);

            foreach ($pricedItems as $i) {
                Db::insert('order_items', [
                    'order_id'     => $orderId,
                    'product_slug' => $i['product_slug'],
                    'name'         => $i['name'],
                    'base_cents'   => $i['base_cents'],
                    'extras_cents' => $i['extras_cents'],
                    'unit_cents'   => $i['unit_cents'],
                    'quantity'     => $i['quantity'],
                    'line_cents'   => $i['line_cents'],
                    'extras_json'  => $i['extras'] ? json_encode($i['extras'], JSON_UNESCAPED_UNICODE) : null,
                    'note'         => $i['note'] ?: null,
                    'vat_group'    => $i['vat_group'],
                ]);
            }

            self::logEvent($orderId, 'created', 'Objednávka prijatá z webu');
            return self::findById($orderId);
        });
    }

    public static function logEvent(int $orderId, string $event, ?string $detail = null, ?int $userId = null): void
    {
        Db::insert('order_events', [
            'order_id'   => $orderId,
            'event'      => $event,
            'detail'     => $detail !== null ? mb_substr($detail, 0, 255) : null,
            'user_id'    => $userId,
            'created_at' => date('Y-m-d H:i:s'),
        ]);
    }

    /** @return array<string,mixed>|null */
    public static function findById(int $id): ?array
    {
        $order = Db::one('SELECT * FROM orders WHERE id = ?', [$id]);
        return $order === null ? null : self::hydrate($order);
    }

    /** @return array<string,mixed>|null */
    public static function findByNumber(string $orderNumber, ?string $token = null): ?array
    {
        $order = Db::one('SELECT * FROM orders WHERE order_number = ?', [$orderNumber]);
        if ($order === null) {
            return null;
        }
        if ($token !== null && !hash_equals((string) $order['access_token'], $token)) {
            return null;
        }
        return self::hydrate($order);
    }

    /** @param array<string,mixed> $order */
    private static function hydrate(array $order): array
    {
        $items = Db::all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [$order['id']]);
        foreach ($items as &$i) {
            $i['extras'] = $i['extras_json'] ? (json_decode((string) $i['extras_json'], true) ?: []) : [];
        }
        unset($i);
        $order['items']  = $items;
        $order['events'] = Db::all('SELECT * FROM order_events WHERE order_id = ? ORDER BY id', [$order['id']]);
        $order['vat']    = $order['vat_breakdown'] ? (json_decode((string) $order['vat_breakdown'], true) ?: []) : [];
        return $order;
    }

    /**
     * Prevádzka potvrdí objednávku a nastaví, o koľko minút bude hotová.
     * @return array<string,mixed> aktualizovaná objednávka
     */
    public static function confirm(int $orderId, int $prepMinutes, ?int $userId = null): array
    {
        $prepMinutes = max(5, min(180, $prepMinutes));
        $readyAt     = date('Y-m-d H:i:s', time() + $prepMinutes * 60);
        Db::run(
            'UPDATE orders SET status = ?, prep_minutes = ?, ready_at = ?, confirmed_at = ?, updated_at = ? WHERE id = ?',
            [self::STATUS_CONFIRMED, $prepMinutes, $readyAt, date('Y-m-d H:i:s'), date('Y-m-d H:i:s'), $orderId]
        );
        self::logEvent($orderId, 'confirmed', "Potvrdené, hotové o " . date('H:i', strtotime($readyAt)), $userId);
        return self::findById($orderId);
    }

    /** @return array<string,mixed> */
    public static function setStatus(int $orderId, string $status, ?int $userId = null, ?string $detail = null): array
    {
        $fields = ['status' => $status, 'updated_at' => date('Y-m-d H:i:s')];
        if ($status === self::STATUS_COMPLETED) {
            $fields['completed_at'] = date('Y-m-d H:i:s');
        }
        if ($status === self::STATUS_CANCELLED) {
            $fields['cancelled_at']  = date('Y-m-d H:i:s');
            $fields['cancel_reason'] = $detail !== null ? mb_substr($detail, 0, 255) : null;
        }
        Db::update('orders', $fields, 'id = :id', ['id' => $orderId]);
        self::logEvent($orderId, $status, $detail, $userId);

        // účtovný doklad prideľujeme až pri vybavení — v rade nevznikajú diery
        if ($status === self::STATUS_COMPLETED) {
            $current = Db::value('SELECT doc_number FROM orders WHERE id = ?', [$orderId]);
            if (!$current) {
                Db::run('UPDATE orders SET doc_number = ? WHERE id = ?', [OrderNumber::nextDocNumber(), $orderId]);
            }
        }
        return self::findById($orderId);
    }

    public static function markPaid(int $orderId, string $reference, string $method = 'card'): void
    {
        Db::run(
            'UPDATE orders SET payment_status = ?, payment_reference = ?, payment_method = ?, paid_at = ?, updated_at = ? WHERE id = ?',
            ['paid', mb_substr($reference, 0, 190), $method, date('Y-m-d H:i:s'), date('Y-m-d H:i:s'), $orderId]
        );
        self::logEvent($orderId, 'paid', "Platba prijatá ($method)");
    }

    /** Prevod objednávky do tvaru, ktorý číta frontend. */
    public static function toPublicArray(array $o): array
    {
        $items = [];
        foreach ($o['items'] as $i) {
            $items[] = [
                'key'       => 'i' . $i['id'],
                'productId' => $i['product_slug'],
                'name'      => $i['name'],
                'basePrice' => Money::toFloat((int) $i['base_cents']),
                'unitPrice' => Money::toFloat((int) $i['unit_cents']),
                'quantity'  => (int) $i['quantity'],
                'lineTotal' => Money::toFloat((int) $i['line_cents']),
                'extras'    => $i['extras'],
                'note'      => $i['note'],
            ];
        }
        return [
            'orderNumber'   => $o['order_number'],
            'docNumber'     => $o['doc_number'],
            'status'        => $o['status'],
            'statusLabel'   => self::STATUS_LABELS[$o['status']] ?? $o['status'],
            'orderType'     => $o['order_type'],
            'paymentMethod' => $o['payment_method'],
            'paymentStatus' => $o['payment_status'],
            'createdAt'     => str_replace(' ', 'T', (string) $o['created_at']),
            'readyAt'       => $o['ready_at'] ? str_replace(' ', 'T', (string) $o['ready_at']) : null,
            'prepMinutes'   => $o['prep_minutes'] !== null ? (int) $o['prep_minutes'] : null,
            'customer'      => [
                'firstName'   => $o['first_name'],
                'lastName'    => $o['last_name'],
                'phone'       => $o['phone'],
                'email'       => $o['email'],
                'street'      => $o['street'],
                'houseNumber' => $o['house_number'],
                'city'        => $o['city'],
                'postalCode'  => $o['postal_code'],
                'note'        => $o['note'],
                'pickupTime'  => $o['pickup_time'],
            ],
            'items'       => $items,
            'subtotal'    => Money::toFloat((int) $o['subtotal_cents']),
            'deliveryFee' => Money::toFloat((int) $o['delivery_fee_cents']),
            'total'       => Money::toFloat((int) $o['total_cents']),
            'vat'         => $o['vat'] ?? [],
        ];
    }
}
