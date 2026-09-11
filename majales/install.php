<?php
declare(strict_types=1);

/**
 * Jednorazová inštalácia. Vytvorí tabuľky, naplní ich obsahom z návrhu
 * a založí prvého správcu. Po dokončení tento súbor zmaž zo servera.
 */

require __DIR__ . '/lib/bootstrap.php';

$step   = 'start';
$errors = [];
$notes  = [];

if (Installer::isInstalled() && ($_GET['znova'] ?? '') !== '1') {
    $step = 'hotovo';
} elseif (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $username = trim((string) ($_POST['username'] ?? ''));
    $password = (string) ($_POST['password'] ?? '');
    $again    = (string) ($_POST['password2'] ?? '');

    if ($password !== $again) {
        $errors[] = 'Heslá sa nezhodujú.';
    }

    if ($errors === []) {
        try {
            $migrated = Installer::migrate();
            $counts   = Installer::seed();
            Installer::createFirstAdmin($username, $password);

            AuditLog::write('install', 'system', '', ['migracie' => $migrated, 'obsah' => $counts]);

            foreach ($counts as $what => $n) {
                if ($n > 0) {
                    $notes[] = ucfirst($what) . ': ' . $n;
                }
            }
            $step = 'uspech';
        } catch (Throwable $e) {
            $errors[] = $e->getMessage();
        }
    }
}

$health = [];
try {
    $health = Installer::healthChecks();
} catch (Throwable) {
    // Pred vytvorením tabuliek niektoré kontroly ešte neprejdú.
}

$e = static fn (?string $v): string => Html::e((string) $v);
?>
<!doctype html>
<html lang="sk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Inštalácia — Majáles Nitra</title>
<link rel="stylesheet" href="admin/assets/admin.css">
</head>
<body class="login-page">
<main class="login" style="width:min(620px,100%)">
  <h1>Inštalácia webu</h1>
  <p class="sub">Majáles Nitra</p>

<?php foreach ($errors as $err): ?>
  <p class="flash flash--err" role="alert"><?= $e($err) ?></p>
<?php endforeach; ?>

<?php if ($step === 'hotovo'): ?>
  <p class="flash flash--ok">Web je už nainštalovaný.</p>
  <p>Z bezpečnostných dôvodov teraz <strong>zmaž súbor <code>install.php</code></strong> zo servera.</p>
  <p style="margin-top:20px"><a class="btn" href="admin/">Prejsť do správy webu</a></p>

<?php elseif ($step === 'uspech'): ?>
  <p class="flash flash--ok">Hotovo! Web je nainštalovaný.</p>
<?php if ($notes !== []): ?>
  <p class="small muted">Naplnené: <?= $e(implode(', ', $notes)) ?>.</p>
<?php endif; ?>
  <ol class="small">
    <li><strong>Zmaž súbor <code>install.php</code></strong> zo servera.</li>
    <li>Prihlás sa do správy webu a doplň fotky v Knižnici fotiek.</li>
    <li>V Nastaveniach vyplň odkazy na sociálne siete a kontaktný e-mail.</li>
  </ol>
  <p style="margin-top:20px"><a class="btn" href="admin/">Prihlásiť sa do správy webu</a></p>

<?php else: ?>
<?php if ($health !== []): ?>
  <div class="flash flash--err">
    <strong>Pred inštaláciou over:</strong>
    <ul style="margin:8px 0 0;padding-left:20px">
<?php foreach ($health as $h): ?>
      <li><?= $e($h) ?></li>
<?php endforeach; ?>
    </ul>
  </div>
<?php endif; ?>

  <p class="small muted">
    Inštalácia vytvorí tabuľky v databáze podľa <code>config.php</code>,
    naplní ich textami a lineupom z návrhu a založí prvého správcu.
  </p>

  <form class="form" method="post" autocomplete="off">
    <div class="field">
      <label for="username">Prihlasovacie meno správcu *</label>
      <input type="text" id="username" name="username" required maxlength="64"
             autocapitalize="none" value="<?= $e((string) ($_POST['username'] ?? '')) ?>">
      <p class="field__hint">3–64 znakov, bez medzier a diakritiky.</p>
    </div>
    <div class="field">
      <label for="password">Heslo *</label>
      <input type="password" id="password" name="password" required autocomplete="new-password">
      <p class="field__hint">Aspoň 10 znakov. Zapíš si ho — nedá sa obnoviť e-mailom.</p>
    </div>
    <div class="field">
      <label for="password2">Heslo ešte raz *</label>
      <input type="password" id="password2" name="password2" required autocomplete="new-password">
    </div>
    <button class="btn" type="submit">Nainštalovať</button>
  </form>
<?php endif; ?>
</main>
</body>
</html>
