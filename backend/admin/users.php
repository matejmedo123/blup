<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

$user = Auth::requireAdmin();

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    Csrf::require();
    $action = (string) ($_POST['action'] ?? '');
    $uid    = (int) ($_POST['id'] ?? 0);

    if ($action === 'create') {
        $res = Installer::createUser(
            (string) ($_POST['name'] ?? ''),
            (string) ($_POST['email'] ?? ''),
            (string) ($_POST['password'] ?? ''),
            ($_POST['role'] ?? 'staff') === 'admin' ? Auth::ROLE_ADMIN : Auth::ROLE_STAFF
        );
        flash_redirect('users.php', $res['ok'] ? 'ok' : 'error',
            $res['ok'] ? 'Používateľ bol pridaný.' : (string) $res['error']);
    }

    if ($action === 'password' && $uid > 0) {
        $pw = (string) ($_POST['password'] ?? '');
        if (mb_strlen($pw) < 10) {
            flash_redirect('users.php', 'error', 'Heslo musí mať aspoň 10 znakov.');
        }
        Db::run('UPDATE users SET password_hash = ? WHERE id = ?', [Auth::hash($pw), $uid]);
        flash_redirect('users.php', 'ok', 'Heslo bolo zmenené.');
    }

    if ($action === 'toggle' && $uid > 0) {
        if ($uid === $user['id']) {
            flash_redirect('users.php', 'error', 'Vlastný účet si vypnúť nemôžeš.');
        }
        $cur = (int) (Db::value('SELECT is_active FROM users WHERE id = ?', [$uid]) ?? 1);
        Db::run('UPDATE users SET is_active = ? WHERE id = ?', [$cur ? 0 : 1, $uid]);
        flash_redirect('users.php', 'ok', $cur ? 'Účet bol vypnutý.' : 'Účet bol zapnutý.');
    }

    if ($action === 'delete' && $uid > 0) {
        if ($uid === $user['id']) {
            flash_redirect('users.php', 'error', 'Vlastný účet zmazať nemôžeš.');
        }
        $admins = (int) (Db::value("SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1") ?? 0);
        $isAdmin = (string) (Db::value('SELECT role FROM users WHERE id = ?', [$uid]) ?? '') === 'admin';
        if ($isAdmin && $admins <= 1) {
            flash_redirect('users.php', 'error', 'Musí ostať aspoň jeden správca.');
        }
        Db::run('DELETE FROM users WHERE id = ?', [$uid]);
        flash_redirect('users.php', 'ok', 'Používateľ bol zmazaný.');
    }
}

$users = Db::all('SELECT * FROM users ORDER BY role, name');

layout_start('Používatelia', 'users', $user);
flash_render();
?>
<div class="page-head">
  <div><p class="eyebrow">Prístupy</p><h1>Používatelia</h1></div>
</div>

<div class="alert alert-info">
  <strong>Správca</strong> vidí všetko vrátane nastavení a účtovníctva.
  <strong>Obsluha</strong> vidí len objednávky a menu — hodí sa pre brigádnikov.
</div>

<div class="grid grid-2">
  <div class="card">
    <h2>Zoznam</h2>
    <div class="table-wrap" style="margin-top:12px">
      <table class="data">
        <thead><tr><th>Meno</th><th>Rola</th><th>Posledné prihlásenie</th><th></th></tr></thead>
        <tbody>
        <?php foreach ($users as $u): ?>
          <tr<?= (int) $u['is_active'] === 0 ? ' style="opacity:.5"' : '' ?>>
            <td><strong><?= e($u['name']) ?></strong><div class="hint"><?= e($u['email']) ?></div></td>
            <td><span class="badge badge-<?= $u['role'] === 'admin' ? 'confirmed' : 'completed' ?>">
              <?= $u['role'] === 'admin' ? 'Správca' : 'Obsluha' ?></span></td>
            <td class="hint"><?= $u['last_login_at'] ? e(date('d.m.Y H:i', strtotime((string) $u['last_login_at']))) : 'nikdy' ?></td>
            <td>
              <div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end">
                <form method="post" style="margin:0" onsubmit="return promptPassword(this)">
                  <?= Csrf::field() ?>
                  <input type="hidden" name="action" value="password">
                  <input type="hidden" name="id" value="<?= (int) $u['id'] ?>">
                  <input type="hidden" name="password" value="">
                  <button class="btn btn-sm btn-ghost" type="submit">Zmeniť heslo</button>
                </form>
                <?php if ((int) $u['id'] !== $user['id']): ?>
                  <form method="post" style="margin:0"><?= Csrf::field() ?>
                    <input type="hidden" name="action" value="toggle">
                    <input type="hidden" name="id" value="<?= (int) $u['id'] ?>">
                    <button class="btn btn-sm btn-ghost"><?= (int) $u['is_active'] === 1 ? 'Vypnúť' : 'Zapnúť' ?></button>
                  </form>
                  <form method="post" style="margin:0" onsubmit="return confirm('Zmazať používateľa?')">
                    <?= Csrf::field() ?>
                    <input type="hidden" name="action" value="delete">
                    <input type="hidden" name="id" value="<?= (int) $u['id'] ?>">
                    <button class="btn btn-sm btn-danger">Zmazať</button>
                  </form>
                <?php endif; ?>
              </div>
            </td>
          </tr>
        <?php endforeach; ?>
        </tbody>
      </table>
    </div>
  </div>

  <div class="card" style="align-self:start">
    <h2>Nový používateľ</h2>
    <form method="post" style="margin-top:14px">
      <?= Csrf::field() ?>
      <input type="hidden" name="action" value="create">
      <label class="field"><span>Meno *</span><input type="text" name="name" required></label>
      <label class="field"><span>E-mail *</span><input type="email" name="email" required autocomplete="off"></label>
      <label class="field"><span>Heslo * (aspoň 10 znakov)</span>
        <input type="password" name="password" required minlength="10" autocomplete="new-password"></label>
      <label class="field"><span>Rola</span>
        <select name="role"><option value="staff">Obsluha</option><option value="admin">Správca</option></select>
      </label>
      <button class="btn btn-block" type="submit">Pridať používateľa</button>
    </form>
  </div>
</div>

<script>
function promptPassword(form) {
  const pw = prompt('Nové heslo (aspoň 10 znakov):');
  if (!pw) return false;
  if (pw.length < 10) { alert('Heslo musí mať aspoň 10 znakov.'); return false; }
  form.querySelector('input[name=password]').value = pw;
  return true;
}
</script>
<?php layout_end(); ?>
