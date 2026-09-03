<?php
declare(strict_types=1);
require __DIR__ . '/_bootstrap.php';

Response::cors((array) cfg('security.allowed_origins', []));
Response::requireMethod('GET');
// Nastavenia sa menia zriedka, ale stav otvorené/zatvorené na kliknutie —
// päť sekúnd ušetrí väčšinu dotazov a zmena je aj tak takmer okamžite vidieť.
header('Cache-Control: public, max-age=5');

try {
    $stripe = (array) cfg('payments.stripe', []);
    $status = OpeningHours::status();
    Response::ok([
        'shop' => [
            'name'       => Settings::get('shop_name'),
            'street'     => Settings::get('shop_street'),
            'city'       => Settings::get('shop_city'),
            'postalCode' => Settings::get('shop_postal_code'),
            'phone'      => Settings::get('shop_phone'),
            'email'      => Settings::get('shop_email'),
            'instagram'  => Settings::get('instagram_url'),
            'facebook'   => Settings::get('facebook_url'),
        ],
        'company' => [
            'name'    => Settings::get('company_name'),
            'ico'     => Settings::get('company_ico'),
            'dic'     => Settings::get('company_dic'),
            'seat'    => Settings::get('company_seat'),
            'manager' => Settings::get('company_manager'),
        ],
        'order' => [
            'acceptingOrders'    => Settings::bool('accepting_orders'),
            'closedMessage'      => Settings::get('closed_message'),
            'deliveryFee'        => Money::toFloat(Settings::cents('delivery_fee')),
            'freeDeliveryFrom'   => Money::toFloat(Settings::cents('free_delivery_from')),
            'minOrder'           => Money::toFloat(Settings::cents('min_order')),
            'prepTimePickup'     => Settings::get('prep_time_pickup'),
            'prepTimeDelivery'   => Settings::get('prep_time_delivery'),
        ],
        'payments' => [
            'cash' => (bool) cfg('payments.cash_enabled', true),
            'card' => (bool) ($stripe['enabled'] ?? false) && ($stripe['secret_key'] ?? '') !== '',
        ],
        // Hodiny aj zóny berieme z tabuliek, ktoré systém naozaj vynucuje —
        // aby web nesľuboval niečo iné, než potom pri objednávke platí.
        'hours' => OpeningHours::grouped(),
        'zones' => DeliveryZones::publicList(),
        'open'  => [
            'now'      => $status['open'],
            'reason'   => $status['reason'],
            'code'     => $status['code'],
            'opensAt'  => $status['opensAt'],
            'closesAt' => $status['closesAt'],
        ],
    ]);
} catch (Throwable $e) {
    error_log('settings.php: ' . $e->getMessage());
    Response::fail('Nastavenia sa nepodarilo načítať.', 500);
}
