<?php
declare(strict_types=1);

/**
 * Spoločný rám admin stránok. Každá stránka zavolá `admin_head()`,
 * vypíše svoj obsah a skončí `admin_foot()`.
 */

require_once __DIR__ . '/../lib/bootstrap.php';

/** Hláška, ktorá prežije presmerovanie na inú stránku. */
function flash(string $type, string $message): void
{
    Auth::start();
    $_SESSION['flash'][] = ['type' => $type, 'text' => $message];
}

/** @return list<array{type:string,text:string}> */
function take_flashes(): array
{
    Auth::start();
    $out = $_SESSION['flash'] ?? [];
    unset($_SESSION['flash']);
    return is_array($out) ? $out : [];
}

function redirect(string $to): never
{
    header('Location: ' . $to);
    exit;
}

/** Položky bočného menu. Viditeľnosť sa riadi rolou. */
function admin_menu(): array
{
    $items = [
        ['dashboard.php', 'Prehľad', '▦'],
        ['obsah.php', 'Texty na stránke', '✎'],
        ['zoznam.php?typ=interpreti', 'Interpreti', '♪'],
        ['zoznam.php?typ=vstupenky', 'Vstupenky', '⛭'],
        ['zoznam.php?typ=galeria', 'Galéria', '▣'],
        ['zoznam.php?typ=zony', 'Zóny', '◈'],
        ['zoznam.php?typ=otazky', 'Časté otázky', '?'],
        ['zoznam.php?typ=partneri', 'Partneri', '◇'],
        ['media.php', 'Knižnica fotiek', '⬚'],
        ['odberatelia.php', 'Odberatelia', '✉'],
        ['nastavenia.php', 'Nastavenia', '⚙'],
    ];
    if (Auth::isAdmin()) {
        $items[] = ['pouzivatelia.php', 'Používatelia', '☺'];
        $items[] = ['audit.php', 'Denník zmien', '≡'];
    }
    return $items;
}

function admin_head(string $title, string $current = ''): void
{
    $e = static fn (?string $v): string => Html::e($v);
    $user = Auth::user();
    ?>
<!doctype html>
<html lang="sk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title><?= $e($title) ?> — Správa webu</title>
<link rel="icon" href="../assets/img/favicon.png" type="image/png">
<link rel="stylesheet" href="assets/admin.css?v=<?= $e(substr(md5((string) @filemtime(__DIR__ . '/assets/admin.css')), 0, 8)) ?>">
</head>
<body>
<a class="skip" href="#hlavne">Preskočiť na obsah</a>

<header class="topbar">
  <button type="button" class="topbar__burger" id="side-toggle" aria-expanded="false" aria-controls="side">
    <span aria-hidden="true">☰</span><span class="vh">Menu</span>
  </button>
  <a class="topbar__brand" href="dashboard.php">Majáles <span>správa webu</span></a>
  <div class="topbar__right">
    <a class="btn btn--ghost" href="../index.php" target="_blank" rel="noopener">Pozrieť web ↗</a>
    <span class="topbar__user"><?= $e((string) ($user['display_name'] ?? '')) ?></span>
    <a class="btn btn--ghost" href="logout.php">Odhlásiť</a>
  </div>
</header>

<div class="shell">
  <nav class="side" id="side" aria-label="Sekcie správy webu">
<?php foreach (admin_menu() as [$href, $label, $icon]):
    $active = $current !== '' && str_contains($href, $current); ?>
    <a href="<?= $e($href) ?>"<?= $active ? ' class="is-active" aria-current="page"' : '' ?>>
      <span class="side__icon" aria-hidden="true"><?= $e($icon) ?></span><?= $e($label) ?>
    </a>
<?php endforeach; ?>
  </nav>

  <main class="main" id="hlavne">
    <h1 class="page-title"><?= $e($title) ?></h1>
<?php foreach (take_flashes() as $f): ?>
    <p class="flash flash--<?= $e($f['type']) ?>" role="status"><?= $e($f['text']) ?></p>
<?php endforeach; ?>
    <?php
}

function admin_foot(): void
{
    ?>
  </main>
</div>
<script src="assets/admin.js?v=<?= Html::e(substr(md5((string) @filemtime(__DIR__ . '/assets/admin.js')), 0, 8)) ?>" defer></script>
</body>
</html>
    <?php
}
