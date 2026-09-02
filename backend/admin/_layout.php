<?php
declare(strict_types=1);

/**
 * Spoločný rámec admin stránok.
 * Použitie:  $title = '…'; require __DIR__ . '/_layout.php';  … layout_end();
 */

function layout_start(string $title, string $active = '', ?array $user = null): void
{
    $nav = [
        'dashboard'  => ['dashboard.php',  'Objednávky'],
        'menu'       => ['menu.php',       'Menu'],
        'settings'   => ['settings.php',   'Nastavenia'],
        'accounting' => ['accounting.php', 'Účtovníctvo'],
        'users'      => ['users.php',      'Používatelia'],
    ];
    $isAdmin = ($user['role'] ?? '') === 'admin';
    ?><!doctype html>
<html lang="sk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title><?= htmlspecialchars($title) ?> · ENZO admin</title>
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="assets/admin.css?v=2">
</head>
<body>
<header class="topbar no-print">
  <div class="topbar-inner">
    <a class="brand" href="dashboard.php">ENZO<span>ADMIN</span></a>
    <?php if ($user !== null): ?>
      <nav class="topnav">
        <?php foreach ($nav as $key => [$href, $label]): ?>
          <?php if (in_array($key, ['settings', 'users'], true) && !$isAdmin) { continue; } ?>
          <a href="<?= $href ?>"<?= $active === $key ? ' class="active"' : '' ?>><?= $label ?></a>
        <?php endforeach; ?>
      </nav>
      <div class="topbar-user">
        <span><?= htmlspecialchars((string) $user['name']) ?></span>
        <a class="btn btn-sm btn-ghost" style="border-color:rgba(246,240,227,.35);color:#F6F0E3" href="logout.php">Odhlásiť</a>
      </div>
    <?php endif; ?>
  </div>
</header>
<div class="checkrule no-print"></div>
<main class="wrap">
<?php
}

function layout_end(): void
{
    ?>
</main>
</body>
</html>
<?php
}

/** Bezpečný výpis do HTML. */
function e(mixed $v): string
{
    return htmlspecialchars((string) $v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/** Presmerovanie s jednorazovou hláškou. */
function flash_redirect(string $url, string $type, string $message): never
{
    Auth::start();
    $_SESSION['flash'] = ['type' => $type, 'message' => $message];
    header('Location: ' . $url);
    exit;
}

function flash_render(): void
{
    Auth::start();
    if (empty($_SESSION['flash'])) {
        return;
    }
    $f = $_SESSION['flash'];
    unset($_SESSION['flash']);
    $cls = $f['type'] === 'error' ? 'alert-err' : ($f['type'] === 'info' ? 'alert-info' : 'alert-ok');
    echo '<div class="alert ' . $cls . '">' . e($f['message']) . '</div>';
}
