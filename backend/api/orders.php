<?php
declare(strict_types=1);
require __DIR__ . '/_bootstrap.php';

/**
 * Vytvorenie objednávky.
 *
 * Jediné, čomu tu veríme od klienta, je „čo a koľko kusov“ a kontaktné
 * údaje. Ceny, poplatok, zľavu aj celkovú sumu počíta server nanovo
 * z databázy. Všetko sa uloží v jednej transakcii — buď vznikne celá
 * objednávka aj s položkami, alebo nič.
 */

Response::cors((array) cfg('security.allowed_origins', []));
Response::requireMethod('POST');

$body = Response::jsonBody();

/* ---------- Idempotencia ---------- */
// Prehliadač si pred prvým odoslaním vygeneruje kľúč a pri opakovaní
// pošle ten istý. Zákazník tak nikdy nedostane dve rovnaké objednávky.
$idemKey = Idempotency::keyFromRequest($body);
$idem    = Idempotency::begin($idemKey, $body);

if ($idem['state'] === Idempotency::REPLAY) {
    Response::ok($idem['response']);
}
if ($idem['state'] === Idempotency::IN_FLIGHT) {
    Response::failCode(
        ErrorCode::DUPLICATE_REQUEST,
        'Túto objednávku už spracúvame. Počkaj chvíľu, netreba ju posielať znova.'
    );
}
if ($idem['state'] === Idempotency::CONFLICT) {
    Response::failCode(
        ErrorCode::IDEMPOTENCY_CONFLICT,
        'Košík sa medzitým zmenil. Obnov stránku a skús to znova.'
    );
}

/**
 * Odmietnutie objednávky. Kľúč sa uvoľní, nech môže zákazník po oprave
 * údajov skúsiť znova — inak by narážal na „už spracúvame“.
 *
 * @param array<string,string> $fields
 */
$reject = static function (string $code, string $message, array $fields = []) use ($idemKey): never {
    Idempotency::release($idemKey);
    Response::failCode($code, $message, $fields);
};

/* ---------- Otvorená prevádzka ---------- */
$hours = OpeningHours::status();
if (!$hours['open']) {
    $reject($hours['code'], $hours['reason']);
}

/* ---------- Ochrana pred zaplavením ---------- */
$ip    = Response::clientIp();
$limit = (int) cfg('security.rate_limit_per_hour', 12);
try {
    Db::run('DELETE FROM rate_limit WHERE created_at < ?', [date('Y-m-d H:i:s', time() - 3600)]);
    $recent = (int) (Db::value(
        'SELECT COUNT(*) FROM rate_limit WHERE ip = ? AND action = ? AND created_at >= ?',
        [$ip, 'order', date('Y-m-d H:i:s', time() - 3600)]
    ) ?? 0);
    if ($recent >= $limit) {
        $reject(
            ErrorCode::RATE_LIMITED,
            'Príliš veľa objednávok z tohto zariadenia. Skús to o chvíľu alebo nám zavolaj.'
        );
    }
} catch (Throwable $e) {
    if ($e instanceof OrderException) {
        throw $e;
    }
    error_log('rate_limit: ' . $e->getMessage());
}

/* ---------- Základné vstupy ---------- */
$orderType = ($body['orderType'] ?? '') === 'pickup' ? 'pickup' : 'delivery';
$payment   = ($body['paymentMethod'] ?? '') === 'card' ? 'card' : 'cash';
$terms     = (bool) ($body['termsAccepted'] ?? false);
$customer  = is_array($body['customer'] ?? null) ? $body['customer'] : [];
$rawItems  = is_array($body['items'] ?? null) ? $body['items'] : [];
$couponIn  = Coupons::normalize((string) ($body['coupon'] ?? ''));

if ($rawItems === []) {
    $reject(ErrorCode::EMPTY_CART, 'Košík je prázdny.');
}
if (count($rawItems) > 60) {
    $reject(ErrorCode::VALIDATION_ERROR, 'Objednávka je príliš veľká. Zavolaj nám, dohodneme sa.');
}

/* ---------- Povolené spôsoby platby ---------- */
$stripeCfg  = (array) cfg('payments.stripe', []);
$cardActive = (bool) ($stripeCfg['enabled'] ?? false) && ($stripeCfg['secret_key'] ?? '') !== '';
if ($payment === 'card' && !$cardActive) {
    $reject(
        ErrorCode::PAYMENT_METHOD_UNAVAILABLE,
        'Platba kartou momentálne nie je dostupná. Vyber platbu v hotovosti.'
    );
}
if ($payment === 'cash' && !cfg('payments.cash_enabled', true)) {
    $reject(ErrorCode::PAYMENT_METHOD_UNAVAILABLE, 'Platba v hotovosti momentálne nie je dostupná.');
}

/* ---------- Validácia zákazníka ---------- */
$errors = Validate::customer($customer, $orderType, $terms);
if ($errors !== []) {
    $reject(ErrorCode::VALIDATION_ERROR, 'Skontroluj prosím zvýraznené polia.', $errors);
}

/* ---------- Prepočet košíka podľa databázy ---------- */
try {
    $priced = OrderService::priceCart($rawItems, $orderType);
} catch (OrderException $e) {
    // Napr. nevyplnená povinná veľkosť — zákazník musí vedieť, čo doplniť.
    $reject($e->errorCode(), $e->getMessage(), $e->fields());
}
if ($priced['items'] === []) {
    $reject(
        ErrorCode::PRODUCT_UNAVAILABLE,
        $priced['errors'][0] ?? 'Žiadna z položiek v košíku už nie je v ponuke.'
    );
}
// Aj keď vypadla len jedna položka, objednávku odmietneme — zákazník
// musí vedieť, čo sa zmenilo. Tichý orez by znamenal, že dostane niečo iné,
// než si objednal.
if ($priced['errors'] !== []) {
    $reject(
        ErrorCode::PRODUCT_UNAVAILABLE,
        implode(' ', $priced['errors']) . ' Uprav prosím košík a skús to znova.'
    );
}

$subtotal = $priced['subtotal'];

/* ---------- Doručovacia zóna ---------- */
$zone     = null;
$zoneName = null;
if ($orderType === 'delivery' && DeliveryZones::configured()) {
    $zone = DeliveryZones::match(
        (string) ($customer['city'] ?? ''),
        (string) ($customer['postalCode'] ?? '')
    );
    if ($zone === null) {
        $names = array_map(static fn (array $z): string => (string) $z['name'], DeliveryZones::all());
        $reject(
            ErrorCode::OUTSIDE_DELIVERY_ZONE,
            'Do tejto obce zatiaľ nerozvážame. Rozvážame do: ' . implode(', ', $names)
                . '. Vyber si osobný odber alebo nám zavolaj.',
            ['city' => 'Mimo rozvozu']
        );
    }
    $zoneName = (string) $zone['name'];
}

/* ---------- Minimálna objednávka ---------- */
$minOrder = $orderType === 'delivery'
    ? DeliveryZones::minOrderFor($zone)
    : Settings::cents('min_order');

if ($subtotal < $minOrder) {
    $reject(
        ErrorCode::MINIMUM_ORDER_NOT_REACHED,
        'Minimálna objednávka je ' . Money::format($minOrder)
            . '. Chýba ešte ' . Money::format($minOrder - $subtotal) . '.'
    );
}

/* ---------- Poplatok za doručenie ---------- */
$deliveryFee = $orderType === 'delivery'
    ? DeliveryZones::feeFor($zone, $subtotal)
    : 0;

/* ---------- Zľavový kód ---------- */
$discount = 0;
$coupon   = null;
if ($couponIn !== '') {
    try {
        $applied  = Coupons::apply($couponIn, $subtotal, $deliveryFee);
        $coupon   = $applied['coupon'];
        $discount = $applied['discount'];
        if ($applied['freeDelivery']) {
            $deliveryFee = 0;
        }
    } catch (OrderException $e) {
        $reject($e->errorCode(), $e->getMessage(), $e->fields());
    }
}

$vat = OrderService::vatBreakdown($priced['items'], $deliveryFee, (array) cfg('accounting', []));

/* ---------- Uloženie ---------- */
try {
    $order = OrderService::create(
        $priced['items'],
        $customer,
        $orderType,
        $payment,
        $subtotal,
        $deliveryFee,
        $vat,
        $discount,
        $coupon,
        $zoneName
    );
    Db::insert('rate_limit', ['ip' => $ip, 'action' => 'order', 'created_at' => date('Y-m-d H:i:s')]);
} catch (Throwable $e) {
    error_log('orders.php create: ' . $e->getMessage());
    $reject(ErrorCode::SERVER_ERROR, 'Objednávku sa nepodarilo uložiť. Skús to znova alebo nám zavolaj.');
}

/* ---------- Evidencia platby ---------- */
try {
    Payments::openFor($order);
} catch (Throwable $e) {
    error_log('orders.php payment: ' . $e->getMessage());
}

/* ---------- Platba kartou → presmerovanie na bránu ---------- */
$checkoutUrl = null;
if ($payment === 'card') {
    try {
        $stripe      = new StripeGateway($stripeCfg, (string) cfg('app.url'));
        $checkoutUrl = $stripe->createCheckout($order);
        Db::run('UPDATE orders SET payment_status = ? WHERE id = ?', ['pending', $order['id']]);
        OrderService::logEvent((int) $order['id'], 'payment_started', 'Presmerovanie na platobnú bránu');
    } catch (Throwable $e) {
        error_log('stripe checkout: ' . $e->getMessage());
        // Objednávka je uložená — necháme ju nezaplatenú a povieme to zákazníkovi.
        $payload = [
            'order'   => OrderService::toPublicArray($order),
            'token'   => $order['access_token'],
            'warning' => 'Objednávku sme prijali, ale platobná brána neodpovedala. '
                . 'Zaplatíš pri prevzatí — prevádzka ťa bude kontaktovať.',
        ];
        Idempotency::complete($idemKey, (int) $order['id'], $payload);
        Response::ok($payload);
    }
}

/* ---------- E-maily ---------- */
// Pri karte pošleme potvrdenie až po zaplatení (rieši webhook).
if ($payment !== 'card') {
    try {
        $n = new Notifier((array) cfg('mail', []), (string) cfg('app.url'));
        $n->orderReceived($order);
        $n->shopNewOrder($order);
    } catch (Throwable $e) {
        error_log('orders.php mail: ' . $e->getMessage());
    }
}

$payload = [
    'order'       => OrderService::toPublicArray($order),
    'token'       => $order['access_token'],
    'checkoutUrl' => $checkoutUrl,
];
Idempotency::complete($idemKey, (int) $order['id'], $payload);

Response::ok($payload);
