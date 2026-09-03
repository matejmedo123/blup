<?php
declare(strict_types=1);

/**
 * Testy backendu.
 *
 *   php backend/tests/run.php
 *
 * Bežia proti čerstvej SQLite databáze v `backend/tests/.tmp/`.
 * Ostrej prevádzky sa nedotknú.
 */

require __DIR__ . '/bootstrap.php';

test_boot();
test_open_shop();

/* ══════════════════════════════════════════════════════════════════ */
describe('Peniaze sa počítajú v centoch');
/* ══════════════════════════════════════════════════════════════════ */

is(Money::fromFloat(9.90), 990, 'z 9,90 € je 990 centov');
is(Money::fromFloat(0.1 + 0.2), 30, '0,1 + 0,2 je 30 centov, nie 30,000000004');
is(Money::toFloat(1234), 12.34, 'z 1234 centov je 12,34 €');

// Klasická pasca desatinných čísel: 0,29 × 100 je vo float 28,999…
is(Money::fromFloat(0.29), 29, '0,29 € sa nezaokrúhli nadol');

/* ══════════════════════════════════════════════════════════════════ */
describe('Ceny počíta server, nie prehliadač');
/* ══════════════════════════════════════════════════════════════════ */

$priced = OrderService::priceCart(
    [['productId' => 'the-enzo-smash', 'quantity' => 2, 'extras' => []]],
    'pickup'
);
is($priced['subtotal'], 1980, 'dva burgre po 9,90 € stoja 19,80 €');

// Klient posiela vlastnú cenu — server ju musí ignorovať
$tampered = OrderService::priceCart(
    [[
        'productId' => 'the-enzo-smash',
        'quantity'  => 2,
        'price'     => 0.01,
        'unitPrice' => 0.01,
        'extras'    => [],
    ]],
    'pickup'
);
is($tampered['subtotal'], 1980, 'podvrhnutá cena 0,01 € sa ignoruje');

// Vymyslený doplnok zadarmo
$fakeExtra = OrderService::priceCart(
    [[
        'productId' => 'the-enzo-smash',
        'quantity'  => 1,
        'extras'    => [['id' => 'neexistujuci-doplnok', 'price' => -50]],
    ]],
    'pickup'
);
is($fakeExtra['items'][0]['extras'], [], 'neexistujúci doplnok sa zahodí');
is($fakeExtra['subtotal'], 990, 'záporná cena doplnku neuberie z ceny');

// Množstvo má strop
$huge = OrderService::priceCart(
    [['productId' => 'the-enzo-smash', 'quantity' => 9999, 'extras' => []]],
    'pickup'
);
is($huge['items'][0]['quantity'], 50, 'množstvo je zhora obmedzené na 50');

// Vypredaná položka
Db::run('UPDATE products SET is_available = 0 WHERE slug = ?', ['kofola-original']);
$soldOut = OrderService::priceCart(
    [['productId' => 'kofola-original', 'quantity' => 1, 'extras' => []]],
    'pickup'
);
is($soldOut['items'], [], 'vypredaná položka sa do objednávky nedostane');
ok($soldOut['errors'] !== [], 'a vráti sa dôvod, prečo vypadla');
Db::run('UPDATE products SET is_available = 1 WHERE slug = ?', ['kofola-original']);

/* ══════════════════════════════════════════════════════════════════ */
describe('Poplatok za doručenie');
/* ══════════════════════════════════════════════════════════════════ */

is(OrderService::deliveryFee(1000, 'pickup'), 0, 'pri osobnom odbere sa neplatí');
is(OrderService::deliveryFee(1000, 'delivery'), 250, 'pod hranicou sa platí 2,50 €');
is(OrderService::deliveryFee(3500, 'delivery'), 0, 'od 35 € je doručenie zdarma');
is(OrderService::deliveryFee(3499, 'delivery'), 250, 'o cent pod hranicou sa ešte platí');

/* ══════════════════════════════════════════════════════════════════ */
describe('Zľavové kódy');
/* ══════════════════════════════════════════════════════════════════ */

$now = date('Y-m-d H:i:s');
Db::insert('coupons', [
    'code' => 'DESAT', 'description' => null, 'kind' => 'percent', 'value' => 10,
    'min_order_cents' => 0, 'max_uses' => null, 'used_count' => 0,
    'starts_at' => null, 'ends_at' => null, 'is_active' => 1, 'created_at' => $now,
]);
Db::insert('coupons', [
    'code' => 'PATEUR', 'description' => null, 'kind' => 'fixed', 'value' => 500,
    'min_order_cents' => 2500, 'max_uses' => null, 'used_count' => 0,
    'starts_at' => null, 'ends_at' => null, 'is_active' => 1, 'created_at' => $now,
]);
Db::insert('coupons', [
    'code' => 'ROZVOZ', 'description' => null, 'kind' => 'free_delivery', 'value' => 0,
    'min_order_cents' => 0, 'max_uses' => null, 'used_count' => 0,
    'starts_at' => null, 'ends_at' => null, 'is_active' => 1, 'created_at' => $now,
]);
Db::insert('coupons', [
    'code' => 'MINULY', 'description' => null, 'kind' => 'percent', 'value' => 50,
    'min_order_cents' => 0, 'max_uses' => null, 'used_count' => 0,
    'starts_at' => null, 'ends_at' => '2020-01-01 00:00:00', 'is_active' => 1, 'created_at' => $now,
]);
Db::insert('coupons', [
    'code' => 'VYCERPANY', 'description' => null, 'kind' => 'percent', 'value' => 50,
    'min_order_cents' => 0, 'max_uses' => 1, 'used_count' => 1,
    'starts_at' => null, 'ends_at' => null, 'is_active' => 1, 'created_at' => $now,
]);

$c = Coupons::apply('DESAT', 2000, 250);
is($c['discount'], 200, '10 % z 20 € je 2 €');
ok(!$c['freeDelivery'], 'percentuálna zľava sa doručenia netýka');

$c = Coupons::apply('ROZVOZ', 2000, 250);
is($c['discount'], 0, 'kód na dopravu neuberá z jedla');
ok($c['freeDelivery'], 'ale doručenie je zdarma');

$c = Coupons::apply('desat', 2000, 250);
is($c['discount'], 200, 'kód sa dá napísať aj malými písmenami');

// Zľava nesmie objednávku poslať do mínusu
Db::insert('coupons', [
    'code' => 'STOEUR', 'description' => null, 'kind' => 'fixed', 'value' => 10000,
    'min_order_cents' => 0, 'max_uses' => null, 'used_count' => 0,
    'starts_at' => null, 'ends_at' => null, 'is_active' => 1, 'created_at' => $now,
]);
$c = Coupons::apply('STOEUR', 2000, 250);
is($c['discount'], 2000, 'zľava sa zastaví na hodnote jedla, nejde do mínusu');

throws(ErrorCode::INVALID_COUPON, fn () => Coupons::apply('NEEXISTUJE', 2000, 250), 'neznámy kód sa odmietne');
throws(ErrorCode::INVALID_COUPON, fn () => Coupons::apply('PATEUR', 2000, 250), 'kód pod svojím minimom sa odmietne');
throws(ErrorCode::INVALID_COUPON, fn () => Coupons::apply('MINULY', 2000, 250), 'kód po platnosti sa odmietne');
throws(ErrorCode::INVALID_COUPON, fn () => Coupons::apply('VYCERPANY', 2000, 250), 'vyčerpaný kód sa odmietne');

/* ══════════════════════════════════════════════════════════════════ */
describe('Doručovacie zóny');
/* ══════════════════════════════════════════════════════════════════ */

ok(DeliveryZones::configured(), 'zóny sú po inštalácii nastavené');

$zone = DeliveryZones::match('Koniarovce', '956 13');
ok($zone !== null, 'obec zo zoznamu sa nájde');
$zoneName = static fn (?string $city, string $psc = ''): ?string
    => DeliveryZones::match($city, $psc)['name'] ?? null;

is($zoneName('koniarovce'), 'Koniarovce', 'malé písmená nevadia');
is($zoneName('Koniarovce 290'), 'Koniarovce', 'adresa s číslom sa priradí k obci');
is($zoneName('Preseľany'), 'Preseľany', 'diakritika sedí');
is(DeliveryZones::match('Kosice', '04001'), null, 'obec mimo rozvozu sa nenájde');

/* ══════════════════════════════════════════════════════════════════ */
describe('Otváracie hodiny');
/* ══════════════════════════════════════════════════════════════════ */

Db::run('UPDATE opening_hours SET is_open = 1, open_time = ?, close_time = ?, last_order_offset = 30', ['11:00', '21:00']);
Settings::flush();

$today = date('Y-m-d');
ok(!OpeningHours::status(strtotime("$today 08:00"))['open'], 'ráno pred otvorením je zatvorené');
ok(OpeningHours::status(strtotime("$today 12:00"))['open'], 'na obed je otvorené');
ok(!OpeningHours::status(strtotime("$today 20:45"))['open'], 'pred zatvorením už objednávky neberieme');
ok(!OpeningHours::status(strtotime("$today 23:30"))['open'], 'v noci je zatvorené');

is(
    OpeningHours::status(strtotime("$today 08:00"))['code'],
    ErrorCode::RESTAURANT_CLOSED,
    'zatvorená prevádzka vráti kód RESTAURANT_CLOSED'
);

// Zastavenie príjmu má prednosť pred hodinami
Settings::set('accepting_orders', '0');
$paused = OpeningHours::status(strtotime("$today 12:00"));
ok(!$paused['open'], 'vypnutý príjem zatvorí prevádzku aj v otváracích hodinách');
is($paused['code'], ErrorCode::ORDERS_PAUSED, 'a rozlíši sa od bežného zatvorenia');
Settings::set('accepting_orders', '1');

// Mimoriadne zatvorenie
Db::insert('closures', [
    'starts_at' => date('Y-m-d H:i:s', time() - 3600),
    'ends_at'   => date('Y-m-d H:i:s', time() + 3600),
    'reason'    => 'Dovolenka.',
    'created_at' => $now,
]);
ok(!OpeningHours::status()['open'], 'mimoriadne zatvorenie zavrie prevádzku');
Db::run('DELETE FROM closures');

test_open_shop();

/* ══════════════════════════════════════════════════════════════════ */
describe('Stavový automat objednávky');
/* ══════════════════════════════════════════════════════════════════ */

ok(OrderStatus::canTransition('received', 'accepted'), 'prijatá → potvrdená');
ok(OrderStatus::canTransition('ready', 'delivering', 'delivery'), 'hotová → na ceste pri rozvoze');
ok(!OrderStatus::canTransition('ready', 'delivering', 'pickup'), 'na ceste nedáva zmysel pri osobnom odbere');
ok(OrderStatus::canTransition('ready', 'picked_up', 'pickup'), 'hotová → vyzdvihnutá pri odbere');
ok(!OrderStatus::canTransition('ready', 'picked_up', 'delivery'), 'vyzdvihnutá nedáva zmysel pri rozvoze');
ok(!OrderStatus::canTransition('received', 'completed'), 'z prijatej sa nedá skočiť na vybavenú');
ok(!OrderStatus::canTransition('completed', 'preparing'), 'vybavená objednávka sa nevracia späť');
ok(!OrderStatus::canTransition('cancelled', 'accepted'), 'zrušená objednávka sa neobnovuje');
ok(OrderStatus::isTerminal('completed') && OrderStatus::isTerminal('rejected'), 'koncové stavy sú koncové');

$order = test_order([['productId' => 'the-enzo-smash', 'quantity' => 2, 'extras' => []]], 'delivery');
$id    = (int) $order['id'];

throws(
    ErrorCode::INVALID_STATUS_TRANSITION,
    fn () => OrderService::transition($id, OrderStatus::COMPLETED),
    'server odmietne neplatný prechod'
);

$accepted = OrderService::accept($id, 25);
is($accepted['status'], 'accepted', 'prijatie objednávky prejde');
ok(!empty($accepted['ready_at']), 'a uloží sa čas, kedy má byť hotová');
is((int) $accepted['prep_minutes'], 25, 'aj počet minút');

// Opakovaný klik nesmie znova posielať e-mail
$again = OrderService::transition($id, OrderStatus::ACCEPTED);
is($again['_changed'], false, 'druhý klik na to isté nič nemení');

OrderService::transition($id, OrderStatus::PREPARING);
OrderService::transition($id, OrderStatus::READY);
throws(
    ErrorCode::INVALID_STATUS_TRANSITION,
    fn () => OrderService::transition($id, OrderStatus::PICKED_UP),
    'vyzdvihnutie sa pri rozvoze odmietne'
);
$done = OrderService::transition($id, OrderStatus::DELIVERING);
is($done['status'], 'delivering', 'kuriér vyrazil');
$done = OrderService::transition($id, OrderStatus::COMPLETED);
is($done['status'], 'completed', 'objednávka je vybavená');
ok(!empty($done['doc_number']), 'pri vybavení sa pridelí číslo dokladu');
is($done['payment_status'], 'paid', 'hotovosť sa pri prevzatí označí ako zaplatená');

throws(
    ErrorCode::ORDER_ALREADY_HANDLED,
    fn () => OrderService::transition($id, OrderStatus::CANCELLED),
    'vybavenú objednávku už nemožno zrušiť'
);

/* ══════════════════════════════════════════════════════════════════ */
describe('História stavov sa nemaže');
/* ══════════════════════════════════════════════════════════════════ */

$history = OrderService::statusHistory($id);
// vznik + prijatá + na platni + hotová + na ceste + vybavená
is(count($history), 6, 'zaznamenali sa všetky prechody vrátane vzniku');
is($history[0]['from_status'], null, 'prvý záznam nemá predchádzajúci stav');
is($history[0]['to_status'], 'received', 'a objednávka začína ako prijatá');
is($history[count($history) - 1]['to_status'], 'completed', 'posledný záznam je vybavená');

/* ══════════════════════════════════════════════════════════════════ */
describe('Snapshot ceny — historická objednávka sa neprepočítava');
/* ══════════════════════════════════════════════════════════════════ */

$snap   = test_order([['productId' => 'the-enzo-smash', 'quantity' => 1, 'extras' => []]]);
$snapId = (int) $snap['id'];
is((int) $snap['total_cents'], 990, 'objednávka vznikla za 9,90 €');

Db::run('UPDATE products SET price_cents = ? WHERE slug = ?', [1290, 'the-enzo-smash']);

$reloaded = OrderService::findById($snapId);
is((int) $reloaded['total_cents'], 990, 'po zdražení ostáva stará objednávka za 9,90 €');
is((int) $reloaded['items'][0]['unit_cents'], 990, 'aj cena položky je pôvodná');

$fresh = OrderService::priceCart([['productId' => 'the-enzo-smash', 'quantity' => 1, 'extras' => []]], 'pickup');
is($fresh['subtotal'], 1290, 'nová objednávka už používa novú cenu');

Db::run('UPDATE products SET price_cents = ? WHERE slug = ?', [990, 'the-enzo-smash']);

/* ══════════════════════════════════════════════════════════════════ */
describe('Skupiny variantov');
/* ══════════════════════════════════════════════════════════════════ */

$gid = Db::insert('modifier_groups', [
    'slug' => 'velkost', 'name' => 'Veľkosť', 'hint' => null,
    'is_required' => 1, 'min_select' => 1, 'max_select' => 1,
    'position' => 0, 'is_active' => 1,
]);
foreach ([['t-mala', 'Malá', 0], ['t-stredna', 'Stredná', 150], ['t-velka', 'Veľká', 300]] as [$slug, $name, $cents]) {
    Db::insert('extras', [
        'slug' => $slug, 'name' => $name, 'price_cents' => $cents,
        'is_active' => 1, 'position' => 0, 'group_id' => $gid,
    ]);
}
$pid = (int) Db::value('SELECT id FROM products WHERE slug = ?', ['pizza-margherita']);
Db::insert('product_modifier_groups', ['product_id' => $pid, 'group_id' => $gid, 'position' => 0]);

throws(
    ErrorCode::INVALID_MODIFIER,
    fn () => OrderService::priceCart([['productId' => 'pizza-margherita', 'quantity' => 1, 'extras' => []]], 'pickup'),
    'bez povinnej veľkosti sa objednať nedá'
);

throws(
    ErrorCode::INVALID_MODIFIER,
    fn () => OrderService::priceCart(
        [['productId' => 'pizza-margherita', 'quantity' => 1, 'extras' => [['id' => 't-mala'], ['id' => 't-velka']]]],
        'pickup'
    ),
    'dve veľkosti naraz sa odmietnu'
);

$sized = OrderService::priceCart(
    [['productId' => 'pizza-margherita', 'quantity' => 1, 'extras' => [['id' => 't-velka']]]],
    'pickup'
);
is($sized['subtotal'], 1100, 'pizza za 8 € s veľkou veľkosťou (+3 €) stojí 11 €');

/* ══════════════════════════════════════════════════════════════════ */
describe('Idempotencia');
/* ══════════════════════════════════════════════════════════════════ */

$payload = [
    'orderType'     => 'pickup',
    'paymentMethod' => 'cash',
    'customer'      => test_customer(),
    'items'         => [['productId' => 'the-enzo-smash', 'quantity' => 2, 'extras' => []]],
];

is(Idempotency::begin('kluc-prve-odoslanie', $payload)['state'], Idempotency::NEW_REQUEST, 'prvé odoslanie je nové');
is(Idempotency::begin('kluc-prve-odoslanie', $payload)['state'], Idempotency::IN_FLIGHT, 'kým sa spracúva, druhé čaká');

Idempotency::complete('kluc-prve-odoslanie', 1, ['order' => ['orderNumber' => 'ENZO-9999']]);
$replay = Idempotency::begin('kluc-prve-odoslanie', $payload);
is($replay['state'], Idempotency::REPLAY, 'po dokončení sa vráti pôvodná odpoveď');
is($replay['response']['order']['orderNumber'], 'ENZO-9999', 'a je to naozaj tá istá objednávka');

$other = $payload;
$other['items'][0]['quantity'] = 5;
is(Idempotency::begin('kluc-prve-odoslanie', $other)['state'], Idempotency::CONFLICT, 'iný obsah pod tým istým kľúčom je konflikt');

// Poradie doplnkov nesmie meniť odtlačok
$a = $payload;
$a['items'][0]['extras'] = [['id' => 'extra-porcia'], ['id' => 'extra-chedar']];
$b = $payload;
$b['items'][0]['extras'] = [['id' => 'extra-chedar'], ['id' => 'extra-porcia']];
Idempotency::begin('kluc-poradie', $a);
is(Idempotency::begin('kluc-poradie', $b)['state'], Idempotency::IN_FLIGHT, 'poradie doplnkov odtlačok nemení');

// Uvoľnený kľúč sa dá použiť znova
Idempotency::begin('kluc-na-uvolnenie', $payload);
Idempotency::release('kluc-na-uvolnenie');
is(Idempotency::begin('kluc-na-uvolnenie', $payload)['state'], Idempotency::NEW_REQUEST, 'po neúspechu sa kľúč uvoľní');

/* ══════════════════════════════════════════════════════════════════ */
describe('Platby');
/* ══════════════════════════════════════════════════════════════════ */

$payOrder = test_order([['productId' => 'the-enzo-smash', 'quantity' => 1, 'extras' => []]]);
$payId    = (int) $payOrder['id'];
Payments::openFor($payOrder);

$payment = Payments::forOrder($payId);
ok($payment !== null, 'k objednávke vznikne záznam platby');
is($payment['status'], Payments::PENDING, 'nová platba čaká na úhradu');
is((int) $payment['amount_cents'], (int) $payOrder['total_cents'], 'suma platby sedí s objednávkou');

ok(OrderService::markPaid($payId, 'cs_test_jedinecna', 'card'), 'prvé zaúčtovanie prejde');
ok(!OrderService::markPaid($payId, 'cs_test_jedinecna', 'card'), 'druhé zaúčtovanie tej istej platby neprejde');
is(Payments::forOrder($payId)['status'], Payments::PAID, 'platba je zaplatená');
is(
    (int) Db::value('SELECT COUNT(*) FROM order_events WHERE order_id = ? AND event = ?', [$payId, 'paid']),
    1,
    'do denníka sa platba zapíše len raz'
);

ok(Payments::claimEvent('stripe', 'evt_jedinecna', 'checkout.session.completed'), 'nová udalosť sa spracuje');
ok(!Payments::claimEvent('stripe', 'evt_jedinecna', 'checkout.session.completed'), 'opakovaná udalosť sa preskočí');

/* ══════════════════════════════════════════════════════════════════ */
describe('Čísla objednávok a dokladov');
/* ══════════════════════════════════════════════════════════════════ */

$o1 = test_order([['productId' => 'the-enzo-smash', 'quantity' => 1, 'extras' => []]]);
$o2 = test_order([['productId' => 'the-enzo-smash', 'quantity' => 1, 'extras' => []]]);
ok($o1['order_number'] !== $o2['order_number'], 'každá objednávka má vlastné číslo');
ok(str_starts_with((string) $o1['order_number'], 'ENZO-'), 'číslo je čitateľné pre človeka');
is(
    (int) Db::value('SELECT COUNT(DISTINCT order_number) FROM orders'),
    (int) Db::value('SELECT COUNT(*) FROM orders'),
    'čísla objednávok sa neopakujú'
);
ok(strlen((string) $o1['access_token']) >= 32, 'prístupový kód je dosť dlhý na to, aby sa nedal uhádnuť');

/* ══════════════════════════════════════════════════════════════════ */
describe('Audit log');
/* ══════════════════════════════════════════════════════════════════ */

$before = AuditLog::count();
AuditLog::change(['id' => 1, 'name' => 'Šéf'], 'product', 'the-enzo-smash', 'cena', '8,90 €', '9,90 €');
is(AuditLog::count(), $before + 1, 'zmena ceny sa zapíše');

AuditLog::change(['id' => 1, 'name' => 'Šéf'], 'product', 'the-enzo-smash', 'cena', '9,90 €', '9,90 €');
is(AuditLog::count(), $before + 1, 'zmena na tú istú hodnotu sa nezapisuje');

$last = AuditLog::recent(1)[0];
ok(str_contains((string) $last['summary'], '8,90 € → 9,90 €'), 'v zázname je pôvodná aj nová hodnota');

exit(test_summary());
