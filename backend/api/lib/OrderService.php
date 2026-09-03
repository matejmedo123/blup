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
    /* Stavy a povolené prechody sú v OrderStatus — tu len skratky,
       aby sa staršie volania nemuseli prepisovať naraz. */
    public const STATUS_RECEIVED   = OrderStatus::RECEIVED;
    public const STATUS_ACCEPTED   = OrderStatus::ACCEPTED;
    public const STATUS_PREPARING  = OrderStatus::PREPARING;
    public const STATUS_READY      = OrderStatus::READY;
    public const STATUS_DELIVERING = OrderStatus::DELIVERING;
    public const STATUS_PICKED_UP  = OrderStatus::PICKED_UP;
    public const STATUS_COMPLETED  = OrderStatus::COMPLETED;
    public const STATUS_REJECTED   = OrderStatus::REJECTED;
    public const STATUS_CANCELLED  = OrderStatus::CANCELLED;

    public const STATUS_LABELS = OrderStatus::LABEL;

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

            // Doplnky — akceptujeme len tie, ktoré sú k produktu naozaj
            // priradené, či už priamo alebo cez skupinu variantov.
            $allowed = [];
            $sql = 'SELECT e.slug, e.name, e.price_cents FROM extras e
                    JOIN product_extras pe ON pe.extra_id = e.id
                    WHERE pe.product_id = ? AND e.is_active = 1';
            $params = [$product['id']];

            if (Db::columnExists('extras', 'group_id') && Db::tableExists('product_modifier_groups')) {
                $sql .= ' UNION
                    SELECT e.slug, e.name, e.price_cents FROM extras e
                    JOIN product_modifier_groups pmg ON pmg.group_id = e.group_id
                    WHERE pmg.product_id = ? AND e.is_active = 1';
                $params[] = $product['id'];
            }

            foreach (Db::all($sql, $params) as $e) {
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

            // Pravidlá skupín (povinná veľkosť, najviac dve omáčky…) sa
            // kontrolujú tu, nie na frontende.
            ModifierGroups::validateSelection(
                (int) $product['id'],
                (string) $product['name'],
                array_map(static fn (array $c): string => $c['id'], $chosen)
            );

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
        int $discount = 0,
        ?array $coupon = null,
        ?string $zoneName = null,
    ): array {
        $now = date('Y-m-d H:i:s');
        // Zľava sa odpočítava od jedla; doručenie zdarma sa už premietlo
        // do $deliveryFee, tak sa tu neodpočítava druhýkrát.
        $discount = max(0, min($discount, $subtotal));
        $total    = $subtotal - $discount + $deliveryFee;

        return Db::transaction(static function () use (
            $pricedItems, $customer, $orderType, $paymentMethod,
            $subtotal, $deliveryFee, $total, $vatBreakdown, $now,
            $discount, $coupon, $zoneName
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
                'discount_cents'     => $discount,
                'coupon_code'        => $coupon !== null ? (string) $coupon['code'] : null,
                'zone_name'          => $zoneName,
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

            // V tej istej transakcii — aby sa kód nevyčerpal pri objednávke,
            // ktorá napokon nevznikla.
            if ($coupon !== null) {
                Coupons::markUsed((int) $coupon['id']);
            }

            self::logEvent($orderId, 'created', 'Objednávka prijatá z webu');
            Db::insert('order_status_history', [
                'order_id'    => $orderId,
                'from_status' => null,
                'to_status'   => OrderStatus::RECEIVED,
                'changed_by'  => null,
                'actor'       => 'customer',
                'reason'      => null,
                'created_at'  => $now,
            ]);
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
    /**
     * Prevádzka objednávku prijala a povedala, o koľko minút bude hotová.
     * Zákazníkovi to hneď posielame e-mailom, tak nech je čas uložený
     * spolu so stavom v jednej transakcii.
     *
     * @return array<string,mixed>
     */
    public static function accept(int $orderId, int $prepMinutes, ?int $userId = null): array
    {
        return self::transition($orderId, OrderStatus::ACCEPTED, [
            'userId'      => $userId,
            'actor'       => 'staff',
            'prepMinutes' => $prepMinutes,
        ]);
    }

    /** Staršie pomenovanie — prijatie objednávky s časom prípravy. */
    public static function confirm(int $orderId, int $prepMinutes, ?int $userId = null): array
    {
        return self::accept($orderId, $prepMinutes, $userId);
    }

    /**
     * Jediná cesta, ako sa mení stav objednávky.
     *
     * Prechod, ktorý state machine nepozná, sa odmietne. Samotná zmena je
     * podmienený UPDATE (`WHERE status = pôvodný`), takže keď dvaja
     * pracovníci kliknú naraz, druhému sa zmena nepodarí a dozvie sa to —
     * namiesto toho, aby objednávku potichu prepísal.
     *
     * Vrátená objednávka nesie kľúč `_changed` — `false` znamená, že už
     * v cieľovom stave bola a nič sa nedialo (obsluha klikla dvakrát).
     *
     * @param array{userId?:int|null, actor?:string, reason?:string|null, prepMinutes?:int|null} $opts
     * @return array<string,mixed>
     * @throws OrderException
     */
    public static function transition(int $orderId, string $to, array $opts = []): array
    {
        $userId      = $opts['userId'] ?? null;
        $actor       = $opts['actor'] ?? 'system';
        $reason      = $opts['reason'] ?? null;
        $prepMinutes = $opts['prepMinutes'] ?? null;

        $result = Db::transaction(static function () use ($orderId, $to, $userId, $actor, $reason, $prepMinutes): array {
            $order = Db::one(
                'SELECT id, status, order_type, payment_method, payment_status, doc_number FROM orders WHERE id = ?',
                [$orderId]
            );
            if ($order === null) {
                throw new OrderException(ErrorCode::NOT_FOUND, 'Objednávka sa nenašla.');
            }

            $from = (string) $order['status'];
            $type = (string) $order['order_type'];

            // Rovnaký stav nie je chyba — obsluha len klikla dvakrát.
            if ($from === $to) {
                return ['changed' => false, 'from' => $from];
            }

            if (!OrderStatus::canTransition($from, $to, $type)) {
                throw new OrderException(
                    OrderStatus::isTerminal($from)
                        ? ErrorCode::ORDER_ALREADY_HANDLED
                        : ErrorCode::INVALID_STATUS_TRANSITION,
                    OrderStatus::explainRefusal($from, $to, $type)
                );
            }

            $now    = date('Y-m-d H:i:s');
            $set    = ['status = ?', 'updated_at = ?'];
            $params = [$to, $now];

            if ($to === OrderStatus::ACCEPTED && $prepMinutes !== null) {
                $minutes = max(5, min(180, (int) $prepMinutes));
                $set[]    = 'prep_minutes = ?';
                $params[] = $minutes;
                $set[]    = 'ready_at = ?';
                $params[] = date('Y-m-d H:i:s', time() + $minutes * 60);
                $set[]    = 'confirmed_at = ?';
                $params[] = $now;
            }
            if ($to === OrderStatus::COMPLETED) {
                $set[]    = 'completed_at = ?';
                $params[] = $now;
            }
            if ($to === OrderStatus::CANCELLED || $to === OrderStatus::REJECTED) {
                $set[]    = 'cancelled_at = ?';
                $params[] = $now;
                $set[]    = 'cancel_reason = ?';
                $params[] = $reason !== null ? mb_substr($reason, 0, 255) : null;
            }

            $params[] = $orderId;
            $params[] = $from;   // podmienka — bráni prepísaniu cudzej zmeny

            $affected = Db::run(
                'UPDATE orders SET ' . implode(', ', $set) . ' WHERE id = ? AND status = ?',
                $params
            )->rowCount();

            if ($affected === 0) {
                throw new OrderException(
                    ErrorCode::ORDER_ALREADY_HANDLED,
                    'Objednávku medzitým spracoval niekto iný. Obnov si prehľad.'
                );
            }

            Db::insert('order_status_history', [
                'order_id'    => $orderId,
                'from_status' => $from,
                'to_status'   => $to,
                'changed_by'  => $userId,
                'actor'       => mb_substr($actor, 0, 20),
                'reason'      => $reason !== null ? mb_substr($reason, 0, 255) : null,
                'created_at'  => $now,
            ]);

            // Doklad prideľujeme až pri vybavení, aby v číselnom rade
            // nevznikali diery po zrušených objednávkach.
            if ($to === OrderStatus::COMPLETED && empty($order['doc_number'])) {
                Db::run('UPDATE orders SET doc_number = ? WHERE id = ? AND doc_number IS NULL', [
                    OrderNumber::nextDocNumber(),
                    $orderId,
                ]);
            }

            return ['changed' => true, 'from' => $from];
        });

        // Hotovosť je zaplatená vo chvíli prevzatia — zapíšeme to až po
        // úspešnom prechode, nech sa platba nezaeviduje k neúspešnej zmene.
        if ($result['changed'] && $to === OrderStatus::COMPLETED) {
            $order = Db::one('SELECT payment_method, payment_status FROM orders WHERE id = ?', [$orderId]);
            if ($order !== null
                && (string) $order['payment_method'] === 'cash'
                && (string) $order['payment_status'] !== 'paid'
            ) {
                self::markPaid($orderId, 'hotovosť pri prevzatí', 'cash');
            }
        }

        $fresh = self::findById($orderId);
        if ($fresh === null) {
            throw new OrderException(ErrorCode::NOT_FOUND, 'Objednávka sa nenašla.');
        }

        // Volajúci podľa toho vie, či má poslať zákazníkovi e-mail. Bez toho
        // by opakovaný klik obsluhy poslal tú istú správu druhýkrát.
        $fresh['_changed'] = $result['changed'];
        return $fresh;
    }

    /**
     * Staršie rozhranie na zmenu stavu. Prechod sa aj tak overí.
     *
     * @return array<string,mixed>
     */
    public static function setStatus(int $orderId, string $status, ?int $userId = null, ?string $detail = null): array
    {
        return self::transition($orderId, $status, [
            'userId' => $userId,
            'actor'  => $userId !== null ? 'staff' : 'system',
            'reason' => $detail,
        ]);
    }

    /** História stavov objednávky, od najstaršieho. @return list<array<string,mixed>> */
    public static function statusHistory(int $orderId): array
    {
        return Db::all(
            'SELECT h.*, u.name AS user_name
             FROM order_status_history h
             LEFT JOIN users u ON u.id = h.changed_by
             WHERE h.order_id = ?
             ORDER BY h.created_at, h.id',
            [$orderId]
        );
    }

    /**
     * Označí objednávku ako zaplatenú.
     *
     * Skutočnú evidenciu vedie `Payments`; tu sa len dorovná rýchly
     * stĺpec v `orders`, z ktorého čítajú prehľady a export.
     *
     * @return bool true = platba sa teraz naozaj zaevidovala
     */
    public static function markPaid(int $orderId, string $reference, string $method = 'card'): bool
    {
        $fresh = Payments::markPaid($orderId, $reference, $method);
        if (!$fresh) {
            return false;
        }

        Db::run(
            'UPDATE orders SET payment_status = ?, payment_reference = ?, payment_method = ?, paid_at = ?, updated_at = ?
             WHERE id = ?',
            ['paid', mb_substr($reference, 0, 190), $method, date('Y-m-d H:i:s'), date('Y-m-d H:i:s'), $orderId]
        );
        self::logEvent($orderId, 'paid', "Platba prijatá ($method)");
        return true;
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
            'discount'    => Money::toFloat((int) ($o['discount_cents'] ?? 0)),
            'couponCode'  => $o['coupon_code'] ?? null,
            'zoneName'    => $o['zone_name'] ?? null,
            'total'       => Money::toFloat((int) $o['total_cents']),
            'vat'         => $o['vat'] ?? [],
        ];
    }
}
