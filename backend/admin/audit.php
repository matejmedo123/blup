<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

/**
 * Kto čo v systéme zmenil.
 *
 * Nie je to na kontrolovanie ľudí, ale na odpovedanie na otázky typu
 * „prečo je burger o euro drahší“ alebo „kto zrušil tú objednávku“.
 */

$user = Auth::requireRole(Auth::ROLE_ADMIN);

$perPage = 60;
$page    = max(1, (int) ($_GET['page'] ?? 1));
$total   = AuditLog::count();
$pages   = max(1, (int) ceil($total / $perPage));
$page    = min($page, $pages);
$rows    = AuditLog::recent($perPage, ($page - 1) * $perPage);

layout_start('Denník zmien', 'users', $user);
flash_render();
?>
<div class="page-head">
  <div><p class="eyebrow">Bezpečnosť</p><h1>Denník zmien</h1></div>
  <a class="btn btn-ghost" href="users.php">Používatelia</a>
</div>

<div class="alert alert-info">
  Zaznamenávame zmeny cien a ponuky, zmeny stavov objednávok a prihlásenia.
  Heslá ani obsah objednávok sa sem nikdy nezapisujú.
</div>

<div class="card">
  <div class="table-wrap">
    <table class="data">
      <thead>
        <tr><th>Kedy</th><th>Kto</th><th>Čo</th><th>Kde</th><th class="hide-sm">Odkiaľ</th></tr>
      </thead>
      <tbody>
      <?php foreach ($rows as $r): ?>
        <tr>
          <td style="white-space:nowrap"><?= e(date('j.n. H:i', strtotime((string) $r['created_at']))) ?></td>
          <td><?= e((string) ($r['user_label'] ?? 'systém')) ?></td>
          <td>
            <span class="badge badge-<?= $r['action'] === 'login_failed' ? 'cancelled' : 'completed' ?>">
              <?= e(AuditLog::label((string) $r['action'])) ?>
            </span>
            <?php if (!empty($r['summary'])): ?>
              <div class="hint" style="margin-top:3px"><?= e((string) $r['summary']) ?></div>
            <?php endif; ?>
          </td>
          <td class="hint"><?= e((string) $r['entity']) ?><?= $r['entity_id'] ? ' · ' . e((string) $r['entity_id']) : '' ?></td>
          <td class="hint hide-sm"><?= e((string) ($r['ip'] ?? '')) ?></td>
        </tr>
      <?php endforeach; ?>
      <?php if ($rows === []): ?>
        <tr><td colspan="5" class="hint">Zatiaľ žiadne záznamy.</td></tr>
      <?php endif; ?>
      </tbody>
    </table>
  </div>

  <?php if ($pages > 1): ?>
    <div class="row" style="margin-top:14px;gap:8px;align-items:center">
      <?php if ($page > 1): ?>
        <a class="btn btn-sm btn-ghost" href="?page=<?= $page - 1 ?>">Novšie</a>
      <?php endif; ?>
      <span class="hint">Strana <?= $page ?> z <?= $pages ?> · <?= $total ?> záznamov</span>
      <?php if ($page < $pages): ?>
        <a class="btn btn-sm btn-ghost" href="?page=<?= $page + 1 ?>">Staršie</a>
      <?php endif; ?>
    </div>
  <?php endif; ?>
</div>
<?php layout_end(); ?>
