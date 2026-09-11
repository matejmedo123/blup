<?php
declare(strict_types=1);

/** Stránka sa nenašla. */

require __DIR__ . '/lib/bootstrap.php';

http_response_code(404);
Page::sendSecurityHeaders();
header('Content-Type: text/html; charset=utf-8');

$title = Settings::get('site_title', 'Majáles Nitra');
?>
<!doctype html>
<html lang="sk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stránka sa nenašla — <?= Html::e($title) ?></title>
<meta name="robots" content="noindex">
<link rel="icon" href="/assets/img/favicon.png" type="image/png">
<link rel="stylesheet" href="/assets/css/fonts.css">
<link rel="stylesheet" href="/assets/css/site.css">
</head>
<body>
<main class="section section--narrow" style="padding-top:90px;text-align:center">
  <h1 class="heading">TÚTO STRÁNKU NEMÁME</h1>
  <p class="subheading">Odkaz je asi starý alebo preklepnutý. Skús to z úvodu.</p>
  <p style="margin-top:30px"><a class="btn btn--sun" href="/">SPÄŤ NA ÚVOD</a></p>
</main>
</body>
</html>
