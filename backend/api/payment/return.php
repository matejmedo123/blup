<?php
declare(strict_types=1);
require __DIR__ . '/../_bootstrap.php';

/**
 * Sem sa zákazník vráti z platobnej brány.
 * Overíme stav platby (poistka, keby webhook meškal) a presmerujeme
 * ho na potvrdenie objednávky.
 */

$number = Validate::clean($_GET['c'] ?? '', 30);
$token  = Validate::clean($_GET['t'] ?? '', 64);
$result = ($_GET['r'] ?? '') === 'success' ? 'success' : 'cancel';

$appUrl = rtrim((string) cfg('app.url'), '/');
$target = $appUrl . '/objednavka/?c=' . rawurlencode($number) . '&t=' . rawurlencode($token);

$order = $number !== '' && $token !== '' ? OrderService::findByNumber($number, $token) : null;

if ($order === null) {
    header('Location: ' . $appUrl . '/');
    exit;
}

if ($result === 'cancel') {
    OrderService::logEvent((int) $order['id'], 'payment_cancelled', 'Zákazník zrušil platbu');
    header('Location: ' . $target . '&platba=zrusena');
    exit;
}

// Webhook je hlavný zdroj pravdy, toto je len poistka pri návrate.
if ($order['payment_status'] !== 'paid' && !empty($order['payment_reference'])) {
    try {
        $stripe  = new StripeGateway((array) cfg('payments.stripe', []), $appUrl);
        $session = $stripe->sessionStatus((string) $order['payment_reference']);
        if (($session['payment_status'] ?? '') === 'paid') {
            OrderService::markPaid((int) $order['id'], (string) $order['payment_reference'], 'card');
            $full = OrderService::findById((int) $order['id']);
            $n = new Notifier((array) cfg('mail', []), $appUrl);
            $n->orderReceived($full);
            $n->shopNewOrder($full);
        }
    } catch (Throwable $e) {
        error_log('return.php: ' . $e->getMessage());
    }
}

header('Location: ' . $target . '&platba=ok');
exit;
