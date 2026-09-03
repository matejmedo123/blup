<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';

/**
 * Malé JSON API pre admin nástenku — ťahanie stavu a akcie nad objednávkami.
 * Vyžaduje prihlásenie; zmeny sú chránené CSRF tokenom.
 */

header('Cache-Control: no-store');

if (!Auth::check()) {
    Response::failCode(ErrorCode::UNAUTHORIZED, 'Odhlásené.');
}
$user = Auth::user();

/* ---------------- Čítanie: stav nástenky ---------------- */
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    if (($_GET['action'] ?? '') !== 'board') {
        Response::failCode(ErrorCode::VALIDATION_ERROR, 'Neznáma akcia.');
    }

    // Nástenka ukazuje len rozrobené objednávky. Vybavené, odmietnuté
    // a zrušené patria do histórie, nie pred oči obsluhy.
    $rows = Db::all(
        "SELECT * FROM orders
         WHERE status IN ('received','accepted','preparing','ready','delivering','picked_up')
         ORDER BY CASE status
                    WHEN 'received' THEN 0
                    WHEN 'accepted' THEN 1
                    WHEN 'preparing' THEN 2
                    ELSE 3
                  END, created_at",
    );

    $orders = [];
    foreach ($rows as $o) {
        $items = [];
        foreach (Db::all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [$o['id']]) as $i) {
            $extras = $i['extras_json'] ? (json_decode((string) $i['extras_json'], true) ?: []) : [];
            $items[] = [
                'name'     => $i['name'],
                'quantity' => (int) $i['quantity'],
                'note'     => $i['note'],
                'extras'   => array_map(static fn ($e) => (string) $e['name'], $extras),
            ];
        }
        $orders[] = [
            'id'            => (int) $o['id'],
            'orderNumber'   => $o['order_number'],
            'status'        => $o['status'],
            'orderType'     => $o['order_type'],
            'paymentMethod' => $o['payment_method'],
            'paymentStatus' => $o['payment_status'],
            'total'         => Money::toFloat((int) $o['total_cents']),
            'createdAt'     => str_replace(' ', 'T', (string) $o['created_at']),
            'readyAt'       => $o['ready_at'] ? str_replace(' ', 'T', (string) $o['ready_at']) : null,
            'readyAtLabel'  => $o['ready_at'] ? date('H:i', strtotime((string) $o['ready_at'])) : null,
            'customerName'  => $o['first_name'] . ' ' . $o['last_name'],
            'phone'         => $o['phone'],
            'pickupTime'    => $o['pickup_time'],
            'note'          => $o['note'],
            'items'         => $items,
        ];
    }

    Response::ok(['orders' => $orders, 'serverTime' => date('c')]);
}

/* ---------------- Zápis: akcie ---------------- */
Response::requireMethod('POST');
$body = Response::jsonBody();

if (!Csrf::verify((string) ($body['_csrf'] ?? ''))) {
    Response::failCode(ErrorCode::SESSION_EXPIRED, 'Relácia vypršala. Obnov stránku.', [], 419);
}

$id     = (int) ($body['id'] ?? 0);
$action = (string) ($body['action'] ?? '');
$order  = $id > 0 ? Db::one('SELECT * FROM orders WHERE id = ?', [$id]) : null;

if ($order === null) {
    Response::failCode(ErrorCode::NOT_FOUND, 'Objednávka sa nenašla.');
}

$notifier = new Notifier((array) cfg('mail', []), (string) cfg('app.url'));

try {
    switch ($action) {
        case 'accept':
        case 'confirm':
            $minutes = (int) ($body['minutes'] ?? Settings::int('default_prep_minutes'));
            $updated = OrderService::accept($id, $minutes, $user['id']);
            if ($updated['_changed']) {
                $notifier->orderConfirmed($updated);
            }
            break;

        case 'preparing':
            $updated = OrderService::transition($id, OrderStatus::PREPARING, [
                'userId' => $user['id'], 'actor' => $user['role'],
            ]);
            break;

        case 'ready':
            $updated = OrderService::transition($id, OrderStatus::READY, [
                'userId' => $user['id'], 'actor' => $user['role'],
            ]);
            if ($updated['_changed']) {
                $notifier->orderReady($updated);
            }
            break;

        case 'delivering':
            $updated = OrderService::transition($id, OrderStatus::DELIVERING, [
                'userId' => $user['id'], 'actor' => $user['role'],
            ]);
            if ($updated['_changed']) {
                $notifier->orderDelivering($updated);
            }
            break;

        case 'picked_up':
            $updated = OrderService::transition($id, OrderStatus::PICKED_UP, [
                'userId' => $user['id'], 'actor' => $user['role'],
            ]);
            break;

        case 'complete':
            // hotovosť sa označí ako uhradená vnútri prechodu
            $updated = OrderService::transition($id, OrderStatus::COMPLETED, [
                'userId' => $user['id'], 'actor' => $user['role'],
            ]);
            break;

        case 'reject':
            $reason  = Validate::clean($body['reason'] ?? '', 255);
            $updated = OrderService::transition($id, OrderStatus::REJECTED, [
                'userId' => $user['id'], 'actor' => $user['role'], 'reason' => $reason,
            ]);
            if ($updated['_changed']) {
                $notifier->orderCancelled($updated, $reason);
            }
            break;

        case 'cancel':
            $reason  = Validate::clean($body['reason'] ?? '', 255);
            $updated = OrderService::transition($id, OrderStatus::CANCELLED, [
                'userId' => $user['id'], 'actor' => $user['role'], 'reason' => $reason,
            ]);
            if ($updated['_changed']) {
                $notifier->orderCancelled($updated, $reason);
            }
            break;

        case 'mark_paid':
            OrderService::markPaid($id, Validate::clean($body['reference'] ?? 'ručne označené', 190), (string) $order['payment_method']);
            $updated = OrderService::findById($id);
            break;

        default:
            Response::failCode(ErrorCode::VALIDATION_ERROR, 'Neznáma akcia.');
    }
} catch (OrderException $e) {
    // Neplatný prechod alebo súbeh dvoch pracovníkov — obsluha sa musí
    // dozvedieť, čo sa stalo, nie dostať „niečo sa pokazilo“.
    $e->respond();
} catch (Throwable $e) {
    error_log('admin/api.php: ' . $e->getMessage());
    Response::failCode(ErrorCode::SERVER_ERROR, 'Akciu sa nepodarilo vykonať.');
}

if ($updated['_changed'] ?? false) {
    AuditLog::record(
        $user,
        'status',
        'order',
        (string) $updated['order_number'],
        'Stav zmenený na ' . (OrderStatus::LABEL[$updated['status']] ?? $updated['status'])
    );
}

Response::ok(['order' => OrderService::toPublicArray($updated)]);
