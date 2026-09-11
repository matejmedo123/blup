<?php
declare(strict_types=1);

/** Používatelia adminu. Spravuje ich len správca. */

require __DIR__ . '/_layout.php';
Auth::requireAdmin();

$me = Auth::user();

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    Csrf::require();
    $action = (string) ($_POST['action'] ?? '');
    $v = new Validate($_POST);

    if ($action === 'create') {
        $username = $v->text('username', 'Prihlasovacie meno', true, 64);
        $display  = $v->text('display_name', 'Meno a priezvisko', false, 120);
        $password = (string) ($_POST['password'] ?? '');
        $role     = (string) ($_POST['role'] ?? Auth::ROLE_EDITOR) === Auth::ROLE_ADMIN
            ? Auth::ROLE_ADMIN : Auth::ROLE_EDITOR;

        if (!preg_match('/^[a-zA-Z0-9._-]{3,64}$/', $username)) {
            $v->fail('username', 'Meno: 3–64 znakov, písmená, číslice, bodka, pomlčka alebo podčiarkovník.');
        } elseif (Db::value('SELECT 1 FROM users WHERE username = ?', [$username]) !== null) {
            $v->fail('username', 'Toto meno je už obsadené.');
        }
        if (mb_strlen($password) < 10) {
            $v->fail('password', 'Heslo musí mať aspoň 10 znakov.');
        }

        if ($v->ok()) {
            $id = Auth::createUser($username, $password, $role, $display);
            AuditLog::write('create', 'user', $id, ['username' => $username, 'role' => $role]);
            flash('ok', 'Používateľ ' . $username . ' bol vytvorený.');
        } else {
            flash('err', $v->firstError());
        }
        redirect('pouzivatelia.php');
    }

    $id   = (int) ($_POST['id'] ?? 0);
    $user = Db::one('SELECT * FROM users WHERE id = ?', [$id]);
    if ($user === null) {
        flash('err', 'Používateľ sa nenašiel.');
        redirect('pouzivatelia.php');
    }

    if ($action === 'password') {
        $password = (string) ($_POST['password'] ?? '');
        if (mb_strlen($password) < 10) {
            flash('err', 'Heslo musí mať aspoň 10 znakov.');
        } else {
            Db::update('users', $id, ['password_hash' => password_hash($password, PASSWORD_DEFAULT)]);
            AuditLog::write('password_change', 'user', $id, ['username' => $user['username']]);
            flash('ok', 'Heslo pre ' . $user['username'] . ' je zmenené.');
        }
        redirect('pouzivatelia.php');
    }

    // Posledný správca sa nesmie vypnúť ani degradovať — inak by sa už
    // nikto nedostal do nastavení.
    $adminCount = (int) Db::value('SELECT COUNT(*) FROM users WHERE role = ? AND active = 1', [Auth::ROLE_ADMIN]);
    $isLastAdmin = $user['role'] === Auth::ROLE_ADMIN && (int) $user['active'] === 1 && $adminCount <= 1;

    if ($action === 'toggle') {
        if ($isLastAdmin) {
            flash('err', 'Toto je posledný správca — najprv vytvor iného.');
        } elseif ($id === (int) $me['id']) {
            flash('err', 'Seba samého vypnúť nemôžeš.');
        } else {
            $now = (int) $user['active'] !== 1;
            Db::update('users', $id, ['active' => $now ? 1 : 0]);
            AuditLog::write('toggle', 'user', $id, ['active' => $now]);
            flash('ok', $user['username'] . ($now ? ' má opäť prístup.' : ' už nemá prístup.'));
        }
        redirect('pouzivatelia.php');
    }

    if ($action === 'role') {
        $role = $user['role'] === Auth::ROLE_ADMIN ? Auth::ROLE_EDITOR : Auth::ROLE_ADMIN;
        if ($isLastAdmin && $role === Auth::ROLE_EDITOR) {
            flash('err', 'Toto je posledný správca — najprv vytvor iného.');
        } else {
            Db::update('users', $id, ['role' => $role]);
            AuditLog::write('role_change', 'user', $id, ['role' => $role]);
            flash('ok', $user['username'] . ' je teraz ' . ($role === Auth::ROLE_ADMIN ? 'správca' : 'redaktor') . '.');
        }
        redirect('pouzivatelia.php');
    }

    if ($action === 'delete') {
        if ($isLastAdmin || $id === (int) $me['id']) {
            flash('err', 'Tohto používateľa zmazať nemôžeš.');
        } else {
            Db::delete('users', $id);
            AuditLog::write('delete', 'user', $id, ['username' => $user['username']]);
            flash('ok', 'Používateľ ' . $user['username'] . ' bol zmazaný.');
        }
        redirect('pouzivatelia.php');
    }

    flash('err', 'Neznáma akcia.');
    redirect('pouzivatelia.php');
}

$users = Db::all('SELECT * FROM users ORDER BY role, username');
$e     = static fn (?string $v): string => Html::e((string) $v);

admin_head('Používatelia', 'pouzivatelia');
?>

<p class="panel__intro">
  <strong>Správca</strong> vidí a mení všetko vrátane používateľov a meracích kódov.
  <strong>Redaktor</strong> spravuje obsah stránky — texty, interpretov, fotky, vstupenky.
</p>

<div class="panel">
<div class="table-wrap">
<table>
  <thead>
    <tr>
      <th scope="col">Meno</th>
      <th scope="col">Rola</th>
      <th scope="col">Stav</th>
      <th scope="col">Naposledy prihlásený</th>
      <th scope="col"><span class="vh">Akcie</span></th>
    </tr>
  </thead>
  <tbody>
<?php foreach ($users as $u):
    $id = (int) $u['id'];
    $active = (int) $u['active'] === 1;
    $isMe = $id === (int) $me['id'];
?>
    <tr>
      <td>
        <strong><?= $e((string) $u['username']) ?></strong><?= $isMe ? ' <span class="tag">to si ty</span>' : '' ?>
<?php if (($u['display_name'] ?? '') !== '' && $u['display_name'] !== $u['username']): ?>
        <br><span class="small muted"><?= $e((string) $u['display_name']) ?></span>
<?php endif; ?>
      </td>
      <td class="tight"><span class="tag <?= $u['role'] === Auth::ROLE_ADMIN ? 'tag--star' : '' ?>"><?= $u['role'] === Auth::ROLE_ADMIN ? 'správca' : 'redaktor' ?></span></td>
      <td class="tight"><span class="tag <?= $active ? 'tag--on' : 'tag--off' ?>"><?= $active ? 'aktívny' : 'vypnutý' ?></span></td>
      <td class="small muted nowrap"><?= $u['last_login_at'] !== null ? $e(date('j. n. Y H:i', strtotime((string) $u['last_login_at']) ?: 0)) : 'nikdy' ?></td>
      <td class="tight">
        <div class="rowbtns">
          <form method="post">
            <?= Csrf::field() ?>
            <input type="hidden" name="id" value="<?= $id ?>">
            <input type="hidden" name="action" value="role">
            <button class="btn btn--ghost btn--small" type="submit">
              <?= $u['role'] === Auth::ROLE_ADMIN ? 'Na redaktora' : 'Na správcu' ?>
            </button>
          </form>
<?php if (!$isMe): ?>
          <form method="post">
            <?= Csrf::field() ?>
            <input type="hidden" name="id" value="<?= $id ?>">
            <input type="hidden" name="action" value="toggle">
            <button class="btn btn--ghost btn--small" type="submit"><?= $active ? 'Vypnúť' : 'Zapnúť' ?></button>
          </form>
          <form method="post" data-confirm="Naozaj zmazať používateľa <?= $e((string) $u['username']) ?>?">
            <?= Csrf::field() ?>
            <input type="hidden" name="id" value="<?= $id ?>">
            <input type="hidden" name="action" value="delete">
            <button class="btn btn--danger btn--small" type="submit">Zmazať</button>
          </form>
<?php endif; ?>
        </div>
      </td>
    </tr>
    <tr>
      <td colspan="5">
        <form class="rowbtns" method="post" style="gap:8px;align-items:center">
          <?= Csrf::field() ?>
          <input type="hidden" name="id" value="<?= $id ?>">
          <input type="hidden" name="action" value="password">
          <label class="vh" for="pw-<?= $id ?>">Nové heslo pre <?= $e((string) $u['username']) ?></label>
          <input type="password" id="pw-<?= $id ?>" name="password" placeholder="Nové heslo (min. 10 znakov)"
                 autocomplete="new-password" style="max-width:320px">
          <button class="btn btn--ghost btn--small nowrap" type="submit">Zmeniť heslo</button>
        </form>
      </td>
    </tr>
<?php endforeach; ?>
  </tbody>
</table>
</div>
</div>

<section class="panel">
  <h2 class="panel__title">Pridať používateľa</h2>
  <form class="form" method="post" novalidate>
    <?= Csrf::field() ?>
    <input type="hidden" name="action" value="create">
    <div class="form__cols">
      <div class="field">
        <label for="new-username">Prihlasovacie meno *</label>
        <input type="text" id="new-username" name="username" required maxlength="64" autocapitalize="none">
        <p class="field__hint">Bez medzier a diakritiky.</p>
      </div>
      <div class="field">
        <label for="new-display">Meno a priezvisko</label>
        <input type="text" id="new-display" name="display_name" maxlength="120">
      </div>
      <div class="field">
        <label for="new-password">Heslo *</label>
        <input type="password" id="new-password" name="password" required autocomplete="new-password">
        <p class="field__hint">Aspoň 10 znakov.</p>
      </div>
      <div class="field">
        <label for="new-role">Rola</label>
        <select id="new-role" name="role">
          <option value="editor">Redaktor</option>
          <option value="admin">Správca</option>
        </select>
      </div>
    </div>
    <div class="form__foot">
      <button class="btn" type="submit">Vytvoriť používateľa</button>
    </div>
  </form>
</section>

<?php admin_foot();
