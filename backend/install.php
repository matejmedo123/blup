<?php
declare(strict_types=1);

/**
 * Jednorazová inštalácia ENZO backendu.
 * Po dokončení tento súbor ZMAŽ — sám na to upozorní.
 */

require __DIR__ . '/api/_bootstrap.php';

$step   = 1;
$errors = [];
$done   = [];

$alreadyInstalled = Installer::isInstalled();

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' && !$alreadyInstalled) {
    $name     = trim((string) ($_POST['name'] ?? ''));
    $email    = trim((string) ($_POST['email'] ?? ''));
    $password = (string) ($_POST['password'] ?? '');
    $confirm  = (string) ($_POST['password2'] ?? '');

    if ($password !== $confirm) {
        $errors[] = 'Heslá sa nezhodujú.';
    }

    if ($errors === []) {
        try {
            Installer::migrate();
            $done[] = 'Tabuľky v databáze sú vytvorené.';

            Installer::seedSettings();
            $done[] = 'Nastavenia prevádzky sú predvyplnené.';

            Installer::seedOperations();
            $done[] = 'Otváracie hodiny a doručovacie zóny sú predvyplnené.';

            $counts = Installer::seedMenu();
            $done[] = sprintf(
                'Menu je naplnené: %d kategórií, %d položiek, %d doplnkov.',
                $counts['categories'],
                $counts['products'],
                $counts['extras']
            );

            $res = Installer::createUser($name, $email, $password, Auth::ROLE_ADMIN);
            if (!$res['ok']) {
                $errors[] = (string) $res['error'];
            } else {
                $done[] = 'Účet správcu je vytvorený.';
                $step   = 3;
            }
        } catch (Throwable $e) {
            $errors[] = 'Chyba pri inštalácii: ' . $e->getMessage();
        }
    }
}

/* ---------- Kontrola prostredia ---------- */
$checks = [
    'PHP 8.1 alebo novšie'      => PHP_VERSION_ID >= 80100,
    'Rozšírenie PDO'            => extension_loaded('pdo'),
    'Ovládač databázy'          => Db::driver() === 'sqlite' ? extension_loaded('pdo_sqlite') : extension_loaded('pdo_mysql'),
    'Rozšírenie mbstring'       => extension_loaded('mbstring'),
    'Rozšírenie openssl'        => extension_loaded('openssl'),
    'Priečinok storage je zapisovateľný' => is_writable(__DIR__ . '/storage'),
    'Pripojenie k databáze'     => (static function (): bool {
        try {
            Db::pdo()->query('SELECT 1');
            return true;
        } catch (Throwable) {
            return false;
        }
    })(),
];
$envOk = !in_array(false, $checks, true);
?>
<!doctype html>
<html lang="sk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Inštalácia · ENZO</title>
<link rel="stylesheet" href="admin/assets/admin.css">
</head>
<body>
<header class="topbar"><div class="topbar-inner">
  <span class="brand">ENZO<span>INŠTALÁCIA</span></span>
</div></header>
<div class="checkrule"></div>

<main class="wrap" style="max-width:760px">

<?php if ($alreadyInstalled): ?>
  <div class="card">
    <h1>Systém je už nainštalovaný</h1>
    <p style="margin-top:12px">Z bezpečnostných dôvodov <strong>zmaž súbor <code>install.php</code></strong> zo servera.</p>
    <a class="btn btn-lg" href="admin/" style="margin-top:18px">Prejsť do adminu</a>
  </div>

<?php elseif ($step === 3): ?>
  <div class="card">
    <h1>Hotovo!</h1>
    <ul style="margin:16px 0 0;padding-left:20px">
      <?php foreach ($done as $d): ?><li><?= htmlspecialchars($d) ?></li><?php endforeach; ?>
    </ul>
    <div class="alert alert-err" style="margin-top:18px">
      <strong>Ešte jedna vec:</strong> zmaž súbor <code>install.php</code> zo servera.
      Kým tam je, mohol by ho spustiť ktokoľvek.
    </div>
    <a class="btn btn-lg" href="admin/">Prihlásiť sa do adminu</a>
  </div>

<?php else: ?>
  <div class="card">
    <p class="eyebrow">Krok 1</p>
    <h1>Kontrola servera</h1>
    <table class="data" style="margin-top:14px">
      <?php foreach ($checks as $label => $ok): ?>
        <tr>
          <td><?= htmlspecialchars($label) ?></td>
          <td class="num">
            <span class="badge badge-<?= $ok ? 'ready' : 'cancelled' ?>"><?= $ok ? 'v poriadku' : 'chýba' ?></span>
          </td>
        </tr>
      <?php endforeach; ?>
    </table>
    <?php if (!$envOk): ?>
      <div class="alert alert-err" style="margin-top:16px">
        Niečo chýba. Skontroluj údaje v <code>api/config.php</code> a nastavenia hostingu.
        Pri MySQL musí databáza existovať a prihlasovacie údaje sedieť.
      </div>
    <?php endif; ?>
  </div>

  <?php if ($envOk): ?>
    <div class="card">
      <p class="eyebrow">Krok 2</p>
      <h1>Účet správcu</h1>
      <p class="hint" style="margin-top:8px">
        Týmto účtom sa budeš prihlasovať do adminu. Ďalších ľudí (obsluhu) pridáš neskôr.
      </p>

      <?php foreach ($errors as $err): ?>
        <div class="alert alert-err" style="margin-top:14px"><?= htmlspecialchars($err) ?></div>
      <?php endforeach; ?>

      <form method="post" style="margin-top:16px">
        <label class="field"><span>Meno *</span>
          <input type="text" name="name" required value="<?= htmlspecialchars((string) ($_POST['name'] ?? '')) ?>"></label>
        <label class="field"><span>E-mail *</span>
          <input type="email" name="email" required value="<?= htmlspecialchars((string) ($_POST['email'] ?? '')) ?>"></label>
        <div class="row row-2">
          <label class="field"><span>Heslo * (aspoň 10 znakov)</span>
            <input type="password" name="password" required minlength="10" autocomplete="new-password"></label>
          <label class="field"><span>Heslo znova *</span>
            <input type="password" name="password2" required minlength="10" autocomplete="new-password"></label>
        </div>
        <button class="btn btn-lg btn-block" type="submit">Nainštalovať</button>
      </form>
    </div>
  <?php endif; ?>
<?php endif; ?>

</main>
</body>
</html>
