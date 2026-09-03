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

/**
 * Skúsi si sám stiahnuť súbor z priečinka storage.
 *
 * Na Apache aj LiteSpeed (teda aj na Websupporte) ho zamkne `.htaccess`.
 * Keby hosting `.htaccess` ignoroval — napríklad nginx — bola by cez web
 * stiahnuteľná celá databáza aj s údajmi zákazníkov. Radšej to overíme
 * naozaj, než aby sme sa spoliehali na to, že to tak asi bude.
 *
 * @return bool|null true = zamknuté, false = dostupné zvonku, null = nevieme
 */
function storage_is_locked(): ?bool
{
    $probe = __DIR__ . '/storage/.pristupnost-test';
    $token = bin2hex(random_bytes(8));
    if (@file_put_contents($probe, $token) === false) {
        return null;
    }

    $scheme = (($_SERVER['HTTPS'] ?? '') === 'on' || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
        ? 'https' : 'http';
    $host = (string) ($_SERVER['HTTP_HOST'] ?? '');
    $base = rtrim(str_replace('\\', '/', dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '/'))), '/');
    if ($host === '') {
        @unlink($probe);
        return null;
    }

    $url = "$scheme://$host$base/storage/.pristupnost-test";
    $ctx = stream_context_create([
        'http' => ['timeout' => 4, 'ignore_errors' => true],
        'ssl'  => ['verify_peer' => false, 'verify_peer_name' => false],
    ]);

    $http_response_header = [];
    $body = @file_get_contents($url, false, $ctx);
    @unlink($probe);

    // Keď sa spojenie vôbec nepodarilo, nevieme nič. Tváriť sa, že je
    // teda všetko v poriadku, by bola tá horšia z dvoch možných chýb.
    if ($body === false && $http_response_header === []) {
        return null;
    }

    $status = 0;
    foreach ($http_response_header as $line) {
        if (preg_match('~^HTTP/\S+\s+(\d{3})~', $line, $m) === 1) {
            $status = (int) $m[1];
        }
    }
    if ($status === 0) {
        return null;
    }
    if ($status === 403 || $status === 401 || $status === 404) {
        return true;
    }
    // Server obsah vydal — a je to naozaj náš súbor.
    return trim((string) $body) !== $token;
}

$storageLocked = storage_is_locked();

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
      <tr>
        <td>Priečinok storage nie je dostupný z internetu</td>
        <td class="num">
          <?php if ($storageLocked === true): ?>
            <span class="badge badge-ready">zamknutý</span>
          <?php elseif ($storageLocked === false): ?>
            <span class="badge badge-cancelled">dostupný zvonku</span>
          <?php else: ?>
            <span class="badge badge-completed">nedá sa overiť</span>
          <?php endif; ?>
        </td>
      </tr>
    </table>
    <?php if ($storageLocked === false): ?>
      <div class="alert alert-err" style="margin-top:16px">
        <strong>Priečinok <code>storage</code> je stiahnuteľný z internetu.</strong>
        Tvoj hosting zrejme neberie do úvahy súbor <code>.htaccess</code>.
        Keď použiješ SQLite, dala by sa takto stiahnuť celá databáza aj
        s údajmi zákazníkov.
        <br><br>
        Rieši sa to jedným z týchto spôsobov:
        <br>· prepni sa v <code>api/config.php</code> na <strong>MySQL</strong> (na Websupporte je v základe),
        <br>· alebo daj <code>sqlite_path</code> mimo verejného priečinka (napr. <code>__DIR__ . '/../../enzo.sqlite'</code>),
        <br>· alebo si u hostingu vypýtaj zamknutie priečinka <code>storage</code>.
      </div>
    <?php elseif ($storageLocked === null): ?>
      <div class="alert alert-info" style="margin-top:16px">
        Dostupnosť priečinka <code>storage</code> sa nedala overiť. Po inštalácii
        si skús otvoriť <code>/storage/</code> v prehliadači — nemal by si vidieť nič.
      </div>
    <?php endif; ?>

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
