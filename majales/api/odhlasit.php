<?php
declare(strict_types=1);

/** Odhlásenie z odberu cez odkaz v pätičke e-mailu. */

require __DIR__ . '/../lib/bootstrap.php';

$token = (string) ($_GET['t'] ?? '');
$ok    = Subscribers::unsubscribeByToken($token);

if ($ok) {
    AuditLog::write('unsubscribe', 'subscriber', substr($token, 0, 8));
}

Page::sendSecurityHeaders();
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
http_response_code($ok ? 200 : 404);

$title = Settings::get('site_title', 'Majáles Nitra');
?>
<!doctype html>
<html lang="sk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= Html::e($ok ? 'Odber zrušený' : 'Odkaz neplatí') ?> — <?= Html::e($title) ?></title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="../assets/css/fonts.css">
<link rel="stylesheet" href="../assets/css/site.css">
</head>
<body>
<main class="section section--narrow" style="padding-top:80px;text-align:center">
<?php if ($ok): ?>
  <h1 class="heading">ODBER ZRUŠENÝ</h1>
  <p class="subheading">Viac ti novinky posielať nebudeme. Ak to bol omyl, prihlás sa znova v pätičke stránky.</p>
<?php else: ?>
  <h1 class="heading">ODKAZ UŽ NEPLATÍ</h1>
  <p class="subheading">Odhlasovací odkaz je neplatný alebo už bol použitý.</p>
<?php endif; ?>
  <p style="margin-top:30px"><a class="btn btn--sun" href="../index.php">SPÄŤ NA STRÁNKU</a></p>
</main>
</body>
</html>
