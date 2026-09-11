<?php
declare(strict_types=1);

/** Prihlásenie do správy webu. */

require __DIR__ . '/_layout.php';

if (Auth::check()) {
    redirect('dashboard.php');
}

$error = '';
$username = '';
$next = (string) ($_GET['next'] ?? '');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    Csrf::require();

    $username = trim((string) ($_POST['username'] ?? ''));
    $password = (string) ($_POST['password'] ?? '');
    $ip       = RateLimit::clientIp();

    // Brzda na hádanie hesla: 8 pokusov z jednej adresy za 15 minút.
    if (!RateLimit::attempt('login', $ip, 8, 900)) {
        $wait  = max(1, (int) ceil(RateLimit::retryAfter('login', $ip) / 60));
        $error = 'Priveľa pokusov o prihlásenie. Skús to znova o ' . $wait . ' min.';
        AuditLog::write('login_blocked', 'user', $username);
    } elseif ($username === '' || $password === '') {
        $error = 'Vyplň meno aj heslo.';
    } else {
        $user = Auth::attempt($username, $password);
        if ($user === null) {
            // Zámerne nehovoríme, či bolo zlé meno alebo heslo.
            $error = 'Nesprávne meno alebo heslo.';
            AuditLog::write('login_failed', 'user', $username);
        } else {
            Auth::login($user);
            RateLimit::clear('login', $ip);
            AuditLog::write('login', 'user', (int) $user['id']);

            // Návrat tam, kam používateľ pôvodne smeroval — ale len v rámci
            // adminu, aby sa dal odkaz zneužiť na presmerovanie inam.
            $target = 'dashboard.php';
            $back   = (string) ($_POST['next'] ?? '');
            if ($back !== '' && preg_match('#^[a-z0-9_\-]+\.php(\?[^"\'<>\s]*)?$#i', basename($back))) {
                $target = basename($back);
            }
            redirect($target);
        }
    }
}

$e = static fn (?string $v): string => Html::e($v);
?>
<!doctype html>
<html lang="sk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Prihlásenie — Správa webu Majáles</title>
<link rel="icon" href="../assets/img/favicon.png" type="image/png">
<link rel="stylesheet" href="assets/admin.css">
</head>
<body class="login-page">
<main class="login">
  <h1>Správa webu</h1>
  <p class="sub">Majáles Nitra</p>

<?php if ($error !== ''): ?>
  <p class="flash flash--err" role="alert"><?= $e($error) ?></p>
<?php endif; ?>

  <form class="form" method="post" autocomplete="on">
    <?= Csrf::field() ?>
    <input type="hidden" name="next" value="<?= $e($next) ?>">

    <div class="field">
      <label for="username">Prihlasovacie meno</label>
      <input type="text" id="username" name="username" value="<?= $e($username) ?>"
             autocomplete="username" autocapitalize="none" required autofocus>
    </div>

    <div class="field">
      <label for="password">Heslo</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required>
    </div>

    <button class="btn" type="submit">Prihlásiť sa</button>
  </form>
</main>
</body>
</html>
