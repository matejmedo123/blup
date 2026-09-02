<?php
declare(strict_types=1);
require __DIR__ . '/_bootstrap.php';

Response::cors((array) cfg('security.allowed_origins', []));
Response::requireMethod('POST');

$body = Response::jsonBody();

/* ---------- Prevádzka práve neprijíma objednávky ---------- */
if (!Settings::bool('accepting_orders')) {
    Response::fail((string) Settings::get('closed_message'), 423);
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
        Response::fail('Príliš veľa objednávok z tohto zariadenia. Skús to o chvíľu alebo nám zavolaj.', 429);
    }
} catch (Throwable $e) {
    error_log('rate_limit: ' . $e->getMessage());
}

/* ---------- Základné vstupy ---------- */
$orderType = ($body['orderType'] ?? '') === 'pickup' ? 'pickup' : 'delivery';
$payment   = ($body['paymentMethod'] ?? '') === 'card' ? 'card' : 'cash';
$terms     = (bool) ($body['termsAccepted'] ?? false);
$customer  = is_array($body['customer'] ?? null) ? $body['customer'] : [];
$rawItems  = is_array($body['items'] ?? null) ? $body['items'] : [];

if ($rawItems === []) {
    Response::fail('Košík je prázdny.', 422);
}
if (count($rawItems) > 60) {
    Response::fail('Objednávka je príliš veľká. Zavolaj nám, dohodneme sa.', 422);
}

/* ---------- Povolené spôsoby platby ---------- */
$stripeCfg  = (array) cfg('payments.stripe', []);
$cardActive = (bool) ($stripeCfg['enabled'] ?? false) && ($stripeCfg['secret_key'] ?? '') !== '';
if ($payment === 'card' && !$cardActive) {
    Response::fail('Platba kartou momentálne nie je dostupná. Vyber platbu v hotovosti.', 422);
}
if ($payment === 'cash' && !cfg('payments.cash_enabled', true)) {
    Response::fail('Platba v hotovosti momentálne nie je dostupná.', 422);
}

/* ---------- Validácia zákazníka ---------- */
$errors = Validate::customer($customer, $orderType, $terms);
if ($errors !== []) {
    Response::fail('Skontroluj prosím zvýraznené polia.', 422, $errors);
}

/* ---------- Prepočet košíka podľa cien v databáze ---------- */
$priced = OrderService::priceCart($rawItems, $orderType);
if ($priced['items'] === []) {
    Response::fail(
        $priced['errors'][0] ?? 'Žiadna z položiek v košíku už nie je v ponuke.',
        422
    );
}
// Aj keď vypadla len jedna položka, objednávku odmietneme — zákazník
// musí vedieť, čo sa zmenilo. Tichý orez by znamenal, že dostane niečo iné,
// než si objednal.
if ($priced['errors'] !== []) {
    Response::fail(
        implode(' ', $priced['errors']) . ' Uprav prosím košík a skús to znova.',
        409
    );
}

$subtotal = $priced['subtotal'];
$minOrder = Settings::cents('min_order');
if ($subtotal < $minOrder) {
    Response::fail('Minimálna objednávka je ' . Money::format($minOrder) . '.', 422);
}

$deliveryFee = OrderService::deliveryFee($subtotal, $orderType);
$vat         = OrderService::vatBreakdown($priced['items'], $deliveryFee, (array) cfg('accounting', []));

/* ---------- Uloženie ---------- */
try {
    $order = OrderService::create(
        $priced['items'],
        $customer,
        $orderType,
        $payment,
        $subtotal,
        $deliveryFee,
        $vat
    );
    Db::insert('rate_limit', ['ip' => $ip, 'action' => 'order', 'created_at' => date('Y-m-d H:i:s')]);
} catch (Throwable $e) {
    error_log('orders.php create: ' . $e->getMessage());
    Response::fail('Objednávku sa nepodarilo uložiť. Skús to znova alebo nám zavolaj.', 500);
}

/* ---------- Platba kartou → presmerovanie na bránu ---------- */
$checkoutUrl = null;
if ($payment === 'card') {
    try {
        $stripe = new StripeGateway($stripeCfg, (string) cfg('app.url'));
        $checkoutUrl = $stripe->createCheckout($order);
        Db::run('UPDATE orders SET payment_status = ? WHERE id = ?', ['pending', $order['id']]);
        OrderService::logEvent((int) $order['id'], 'payment_started', 'Presmerovanie na platobnú bránu');
    } catch (Throwable $e) {
        error_log('stripe checkout: ' . $e->getMessage());
        // objednávka je uložená — necháme ju ako nezaplatenú a povieme to zákazníkovi
        Response::json([
            'ok'    => true,
            'data'  => [
                'order'   => OrderService::toPublicArray($order),
                'token'   => $order['access_token'],
                'warning' => 'Objednávku sme prijali, ale platobná brána neodpovedala. '
                    . 'Zaplatíš pri prevzatí — prevádzka ťa bude kontaktovať.',
            ],
        ]);
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

Response::ok([
    'order'       => OrderService::toPublicArray($order),
    'token'       => $order['access_token'],
    'checkoutUrl' => $checkoutUrl,
]);
