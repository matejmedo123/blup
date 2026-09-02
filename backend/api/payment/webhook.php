<?php
declare(strict_types=1);
require __DIR__ . '/../_bootstrap.php';

/**
 * Stripe sem pošle správu, keď zákazník zaplatí.
 * Adresu nastav v Stripe → Developers → Webhooks:
 *   https://tvojadomena.sk/api/payment/webhook.php
 * Udalosť: checkout.session.completed
 */

Response::requireMethod('POST');

$payload   = file_get_contents('php://input') ?: '';
$signature = $_SERVER['HTTP_STRIPE_SIGNATURE'] ?? '';

try {
    $stripe = new StripeGateway((array) cfg('payments.stripe', []), (string) cfg('app.url'));
    $event  = $stripe->verifyWebhook($payload, $signature);
} catch (Throwable $e) {
    error_log('webhook: ' . $e->getMessage());
    Response::fail('Neplatný podpis.', 400);
}

if (($event['type'] ?? '') !== 'checkout.session.completed') {
    Response::ok(['ignored' => $event['type'] ?? '']);
}

$session   = $event['data']['object'] ?? [];
$orderNum  = (string) ($session['client_reference_id'] ?? ($session['metadata']['order_number'] ?? ''));
$sessionId = (string) ($session['id'] ?? '');
$paidState = (string) ($session['payment_status'] ?? '');

if ($orderNum === '' || $paidState !== 'paid') {
    Response::ok(['skipped' => true]);
}

$order = Db::one('SELECT * FROM orders WHERE order_number = ?', [$orderNum]);
if ($order === null) {
    error_log("webhook: objednávka $orderNum sa nenašla");
    Response::ok(['skipped' => 'not found']);
}

// webhook môže doraziť viackrát — spracujeme ho iba raz
if (($order['payment_status'] ?? '') === 'paid') {
    Response::ok(['already' => true]);
}

OrderService::markPaid((int) $order['id'], $sessionId, 'card');

try {
    $full = OrderService::findById((int) $order['id']);
    $n = new Notifier((array) cfg('mail', []), (string) cfg('app.url'));
    $n->orderReceived($full);
    $n->shopNewOrder($full);
} catch (Throwable $e) {
    error_log('webhook mail: ' . $e->getMessage());
}

Response::ok(['paid' => $orderNum]);
