<?php
declare(strict_types=1);

/** Odberatelia noviniek z pätičky webu + export do CSV. */

require __DIR__ . '/_layout.php';
Auth::requireLogin();

if (($_GET['export'] ?? '') === 'csv') {
    $status = (string) ($_GET['stav'] ?? Subscribers::STATUS_ACTIVE);
    if (!in_array($status, [Subscribers::STATUS_ACTIVE, Subscribers::STATUS_UNSUBSCRIBED, ''], true)) {
        $status = Subscribers::STATUS_ACTIVE;
    }
    AuditLog::write('export', 'subscribers', $status);

    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="odberatelia-' . date('Y-m-d') . '.csv"');
    header('Cache-Control: no-store');
    echo Subscribers::toCsv($status);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    Csrf::require();
    $id  = (int) ($_POST['id'] ?? 0);
    $row = Db::one('SELECT email FROM subscribers WHERE id = ?', [$id]);

    if ($row === null) {
        flash('err', 'Odberateľ sa nenašiel.');
    } else {
        Subscribers::remove($id);
        AuditLog::write('delete', 'subscriber', $id, ['email' => $row['email']]);
        flash('ok', 'Odberateľ bol vymazaný z databázy.');
    }
    redirect('odberatelia.php');
}

$filter = (string) ($_GET['stav'] ?? '');
if (!in_array($filter, [Subscribers::STATUS_ACTIVE, Subscribers::STATUS_UNSUBSCRIBED], true)) {
    $filter = '';
}

$page    = max(1, (int) ($_GET['strana'] ?? 1));
$perPage = 100;
$total   = Subscribers::count($filter);
$rows    = Subscribers::listAll($filter, $perPage, ($page - 1) * $perPage);
$pages   = max(1, (int) ceil($total / $perPage));
$e       = static fn (?string $v): string => Html::e((string) $v);

admin_head('Odberatelia noviniek', 'odberatelia');
?>

<div class="grid" style="margin-bottom:18px">
  <div class="stat"><b><?= Subscribers::count(Subscribers::STATUS_ACTIVE) ?></b><span>aktívnych odberateľov</span></div>
  <div class="stat"><b><?= Subscribers::count(Subscribers::STATUS_UNSUBSCRIBED) ?></b><span>odhlásených</span></div>
</div>

<div class="actions">
  <a class="btn" href="?export=csv&stav=active">Stiahnuť aktívnych (CSV)</a>
  <a class="btn btn--ghost" href="?export=csv&stav=">Stiahnuť všetkých (CSV)</a>
  <span style="flex:1"></span>
  <a class="btn btn--ghost btn--small<?= $filter === '' ? ' is-active' : '' ?>" href="?">Všetci</a>
  <a class="btn btn--ghost btn--small" href="?stav=active">Aktívni</a>
  <a class="btn btn--ghost btn--small" href="?stav=unsubscribed">Odhlásení</a>
</div>

<p class="panel__intro">
  Súbor CSV sa dá priamo nahrať do Mailchimpu, Ecomailu aj do Excelu.
  Odhlásených z rozposielania vynechaj — odhlásili sa sami cez odkaz v e-maile.
</p>

<?php if ($rows === []): ?>
<p class="empty">Zatiaľ tu nikto nie je.</p>
<?php else: ?>
<div class="panel">
<div class="table-wrap">
<table>
  <thead>
    <tr>
      <th scope="col">E-mail</th>
      <th scope="col">Stav</th>
      <th scope="col">Prihlásený</th>
      <th scope="col"><span class="vh">Akcie</span></th>
    </tr>
  </thead>
  <tbody>
<?php foreach ($rows as $r): $active = $r['status'] === Subscribers::STATUS_ACTIVE; ?>
    <tr>
      <td><?= $e((string) $r['email']) ?></td>
      <td class="tight"><span class="tag <?= $active ? 'tag--on' : 'tag--off' ?>"><?= $active ? 'aktívny' : 'odhlásený' ?></span></td>
      <td class="small muted nowrap"><?= $e(date('j. n. Y H:i', strtotime((string) $r['created_at']) ?: 0)) ?></td>
      <td class="tight">
        <form method="post" data-confirm="Naozaj vymazať tento e-mail z databázy?">
          <?= Csrf::field() ?>
          <input type="hidden" name="id" value="<?= (int) $r['id'] ?>">
          <button class="btn btn--danger btn--small" type="submit">Vymazať</button>
        </form>
      </td>
    </tr>
<?php endforeach; ?>
  </tbody>
</table>
</div>
</div>

<?php if ($pages > 1): ?>
<div class="pager">
<?php if ($page > 1): ?>
  <a class="btn btn--ghost btn--small" href="?stav=<?= $e($filter) ?>&strana=<?= $page - 1 ?>">← Predošlá</a>
<?php endif; ?>
  <span class="muted small">Strana <?= $page ?> z <?= $pages ?></span>
<?php if ($page < $pages): ?>
  <a class="btn btn--ghost btn--small" href="?stav=<?= $e($filter) ?>&strana=<?= $page + 1 ?>">Ďalšia →</a>
<?php endif; ?>
</div>
<?php endif; ?>
<?php endif; ?>

<?php admin_foot();
