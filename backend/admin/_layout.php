<?php
declare(strict_types=1);

/**
 * Spoločný rámec admin stránok.
 * Použitie:  $title = '…'; require __DIR__ . '/_layout.php';  … layout_end();
 */

function layout_start(string $title, string $active = '', ?array $user = null): void
{
    // Položka sa zobrazí len tomu, kto na ňu naozaj má právo — obsluha
    // by inak klikala na odkazy, ktoré ju odpália na 403.
    $nav = [
        'dashboard'  => ['dashboard.php',  'Objednávky',   null],
        'analytics'  => ['analytics.php',  'Prehľad',      'accounting.view'],
        'menu'       => ['menu.php',       'Menu',         'menu.edit'],
        'settings'   => ['settings.php',   'Nastavenia',   'settings.edit'],
        'accounting' => ['accounting.php', 'Účtovníctvo',  'accounting.view'],
        'users'      => ['users.php',      'Používatelia', 'users.manage'],
    ];
    $nav = array_filter(
        $nav,
        static fn (array $item): bool => $item[2] === null || Auth::can($user, $item[2])
    );
    ?><!doctype html>
<html lang="sk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title><?= htmlspecialchars($title) ?> · ENZO admin</title>
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="assets/admin.css?v=7">
</head>
<body>
<header class="topbar no-print">
  <div class="topbar-inner">
    <a class="brand" href="dashboard.php">ENZO<span>ADMIN</span></a>
    <?php if ($user !== null): ?>
      <div class="topbar-user">
        <span class="topbar-name"><?= htmlspecialchars((string) $user['name']) ?></span>
        <a class="btn btn-sm btn-ghost topbar-logout" href="logout.php">Odhlásiť</a>
      </div>
    <?php endif; ?>
  </div>
  <?php if ($user !== null): ?>
    <?php /* Na telefóne sa navigácia posúva do strany namiesto lámania do troch riadkov. */ ?>
    <nav class="topnav" aria-label="Hlavné menu">
      <?php foreach ($nav as $key => [$href, $label, $ability]): ?>
        <a href="<?= $href ?>"<?= $active === $key ? ' class="active" aria-current="page"' : '' ?>><?= $label ?></a>
      <?php endforeach; ?>
    </nav>
  <?php endif; ?>
</header>
<div class="checkrule no-print"></div>
<main class="wrap">
<?php
}

/** Slušné odmietnutie namiesto holého 403. */
function layout_denied(): never
{
    $user = Auth::user();
    layout_start('Bez prístupu', '', $user);
    echo '<div class="card"><p class="eyebrow">403</p>'
       . '<h1>Sem nemáš prístup</h1>'
       . '<p style="margin-top:12px">Túto časť môže otvoriť len správca. '
       . 'Ak ju potrebuješ, povedz si o oprávnenie.</p>'
       . '<a class="btn" href="dashboard.php" style="margin-top:16px">Späť na objednávky</a></div>';
    layout_end();
    exit;
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
