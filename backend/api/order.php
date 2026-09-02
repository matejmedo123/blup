<?php
declare(strict_types=1);
require __DIR__ . '/_bootstrap.php';

Response::cors((array) cfg('security.allowed_origins', []));
Response::requireMethod('GET');
header('Cache-Control: no-store');

$number = Validate::clean($_GET['c'] ?? '', 30);
$token  = Validate::clean($_GET['t'] ?? '', 64);

if ($number === '' || $token === '') {
    Response::fail('Chýba číslo objednávky alebo prístupový kód.', 400);
}

$order = OrderService::findByNumber($number, $token);
if ($order === null) {
    // rovnaká odpoveď pre neexistujúcu objednávku aj zlý token
    Response::fail('Objednávka sa nenašla.', 404);
}

Response::ok(['order' => OrderService::toPublicArray($order)]);
