<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

Auth::start();

if (!Installer::isInstalled()) {
    header('Location: ../install.php');
    exit;
}
if (Auth::check()) {
    header('Location: dashboard.php');
    exit;
}

$error = '';
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    Csrf::require();
    $res = Auth::attempt((string) ($_POST['email'] ?? ''), (string) ($_POST['password'] ?? ''));
    if ($res['ok']) {
        $next = (string) ($_GET['next'] ?? 'dashboard.php');
        // presmerúvame len v rámci vlastného webu
        if (!str_starts_with($next, '/') || str_starts_with($next, '//')) {
            $next = 'dashboard.php';
        }
        header('Location: ' . $next);
        exit;
    }
    $error = (string) $res['error'];
    usleep(400000);
}

layout_start('Prihlásenie');
?>
<div style="max-width:400px;margin:6vh auto">
  <div class="card">
    <p class="eyebrow">ENZO prevádzka</p>
    <h1 style="margin-top:6px">Prihlásenie</h1>
    <?php if ($error !== ''): ?>
      <div class="alert alert-err" style="margin-top:16px"><?= e($error) ?></div>
    <?php endif; ?>
    <form method="post" style="margin-top:18px">
      <?= Csrf::field() ?>
      <label class="field"><span>E-mail</span>
        <input type="email" name="email" autocomplete="username" required autofocus>
      </label>
      <label class="field"><span>Heslo</span>
        <input type="password" name="password" autocomplete="current-password" required>
      </label>
      <button class="btn btn-block btn-lg" type="submit">Prihlásiť sa</button>
    </form>
  </div>
</div>
<?php
layout_end();
