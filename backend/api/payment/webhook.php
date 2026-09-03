<?php
declare(strict_types=1);
require __DIR__ . '/../_bootstrap.php';

/**
 * Stripe sem pošle správu, keď zákazník zaplatí.
 * Adresu nastav v Stripe → Developers → Webhooks:
 *   https://tvojadomena.sk/api/payment/webhook.php
 * Udalosť: checkout.session.completed
 *
 * Webhook nikdy nespracujeme dvakrát. Stripe doručuje opakovane, kým
 * nedostane 200, a pri výpadku môžu dve doručenia dobehnúť naraz —
 * preto o jedinečnosti rozhoduje unikátny index v databáze, nie
 * kontrola v PHP, ktorú by dva súbežné procesy prešli obidva.
 *
 * Frontendu sa neverí nikdy: zaplatené je len to, čo potvrdí Stripe
 * podpísanou správou sem.
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

$eventId   = (string) ($event['id'] ?? '');
$eventType = (string) ($event['type'] ?? '');

if ($eventType !== 'checkout.session.completed') {
    Response::ok(['ignored' => $eventType]);
}

$session   = $event['data']['object'] ?? [];
$orderNum  = (string) ($session['client_reference_id'] ?? ($session['metadata']['order_number'] ?? ''));
$sessionId = (string) ($session['id'] ?? '');
$paidState = (string) ($session['payment_status'] ?? '');

if ($orderNum === '' || $paidState !== 'paid') {
    Response::ok(['skipped' => true]);
}

// Túto udalosť sme už raz spracovali — Stripe ju len posiela znova.
if (!Payments::claimEvent('stripe', $eventId, $eventType)) {
    Response::ok(['already' => true]);
}

$order = Db::one('SELECT * FROM orders WHERE order_number = ?', [$orderNum]);
if ($order === null) {
    error_log("webhook: objednávka $orderNum sa nenašla");
    Response::ok(['skipped' => 'not found']);
}

// markPaid vráti false, keď platba už bola zaevidovaná (napr. iným
// doručením toho istého webhooku) — vtedy e-maily druhýkrát neposielame.
$justPaid = OrderService::markPaid((int) $order['id'], $sessionId, 'card');

if ($justPaid) {
    try {
        $full = OrderService::findById((int) $order['id']);
        $n    = new Notifier((array) cfg('mail', []), (string) cfg('app.url'));
        $n->orderReceived($full);
        $n->shopNewOrder($full);
    } catch (Throwable $e) {
        error_log('webhook mail: ' . $e->getMessage());
    }
}

Response::ok(['paid' => $orderNum, 'firstTime' => $justPaid]);
