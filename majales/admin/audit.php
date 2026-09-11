<?php
declare(strict_types=1);

/** Denník zmien — kto, kedy a čo v admine urobil. */

require __DIR__ . '/_layout.php';
Auth::requireAdmin();

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    Csrf::require();
    $days = max(30, min(3650, (int) ($_POST['days'] ?? 365)));
    $n = AuditLog::pruneOlderThanDays($days);
    AuditLog::write('prune', 'audit_log', '', ['days' => $days, 'zmazane' => $n]);
    flash('ok', 'Zmazaných starých záznamov: ' . $n . '.');
    redirect('audit.php');
}

$page    = max(1, (int) ($_GET['strana'] ?? 1));
$perPage = 100;
$total   = AuditLog::count();
$rows    = AuditLog::recent($perPage, ($page - 1) * $perPage);
$pages   = max(1, (int) ceil($total / $perPage));
$e       = static fn (?string $v): string => Html::e((string) $v);

$labels = [
    'login' => 'prihlásenie', 'logout' => 'odhlásenie',
    'login_failed' => 'neúspešné prihlásenie', 'login_blocked' => 'zablokované prihlásenie',
    'create' => 'pridanie', 'update' => 'úprava', 'delete' => 'zmazanie',
    'toggle' => 'zobraziť/skryť', 'move' => 'zmena poradia', 'headliner' => 'nastavený headliner',
    'settings_toggle' => 'prepínač', 'export' => 'export', 'subscribe' => 'nový odberateľ',
    'unsubscribe' => 'odhlásenie z odberu', 'password_change' => 'zmena hesla',
    'role_change' => 'zmena roly', 'prune' => 'čistenie denníka', 'install' => 'inštalácia',
];

admin_head('Denník zmien', 'audit');
?>

<p class="panel__intro">Záznamov spolu: <?= (int) $total ?>. Denník sa nemaže po kúskoch — dá sa len orezať podľa veku.</p>

<?php if ($rows === []): ?>
<p class="empty">Denník je prázdny.</p>
<?php else: ?>
<div class="panel">
<div class="table-wrap">
<table>
  <thead>
    <tr>
      <th scope="col">Kedy</th>
      <th scope="col">Kto</th>
      <th scope="col">Čo</th>
      <th scope="col">Kde</th>
      <th scope="col">Podrobnosti</th>
    </tr>
  </thead>
  <tbody>
<?php foreach ($rows as $r): ?>
    <tr>
      <td class="small muted nowrap"><?= $e(date('j. n. Y H:i:s', strtotime((string) $r['created_at']) ?: 0)) ?></td>
      <td class="small"><?= $e((string) $r['username']) ?></td>
      <td class="small"><?= $e($labels[(string) $r['action']] ?? (string) $r['action']) ?></td>
      <td class="small muted"><?= $e((string) $r['entity']) ?><?= $r['entity_id'] !== '' ? ' #' . $e((string) $r['entity_id']) : '' ?></td>
      <td class="small muted"><?= $e(mb_strimwidth((string) ($r['detail'] ?? ''), 0, 80, '…')) ?></td>
    </tr>
<?php endforeach; ?>
  </tbody>
</table>
</div>
</div>

<?php if ($pages > 1): ?>
<div class="pager">
<?php if ($page > 1): ?>
  <a class="btn btn--ghost btn--small" href="?strana=<?= $page - 1 ?>">← Predošlá</a>
<?php endif; ?>
  <span class="muted small">Strana <?= $page ?> z <?= $pages ?></span>
<?php if ($page < $pages): ?>
  <a class="btn btn--ghost btn--small" href="?strana=<?= $page + 1 ?>">Ďalšia →</a>
<?php endif; ?>
</div>
<?php endif; ?>
<?php endif; ?>

<section class="panel">
  <h2 class="panel__title">Orezať denník</h2>
  <form class="rowbtns" method="post" data-confirm="Naozaj zmazať staré záznamy denníka?" style="gap:10px;align-items:center">
    <?= Csrf::field() ?>
    <label for="days">Zmazať záznamy staršie ako</label>
    <input type="number" id="days" name="days" value="365" min="30" max="3650" style="max-width:120px">
    <span>dní</span>
    <button class="btn btn--ghost btn--small" type="submit">Orezať</button>
  </form>
</section>

<?php admin_foot();
