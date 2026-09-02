<?php
declare(strict_types=1);
require __DIR__ . '/_bootstrap.php';

Response::cors((array) cfg('security.allowed_origins', []));
Response::requireMethod('GET');

// menu sa mení zriedka — pol minúty cache ušetrí veľa dotazov
header('Cache-Control: public, max-age=30');

try {
    Response::ok(MenuRepo::publicMenu());
} catch (Throwable $e) {
    error_log('menu.php: ' . $e->getMessage());
    Response::fail('Menu sa nepodarilo načítať.', 500);
}
