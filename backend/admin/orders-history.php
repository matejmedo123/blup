<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

$user = Auth::requireLogin();

$from = Validate::clean($_GET['from'] ?? date('Y-m-01'), 10);
$to   = Validate::clean($_GET['to'] ?? date('Y-m-d'), 10);
$q    = Validate::clean($_GET['q'] ?? '', 60);

$sql    = 'SELECT * FROM orders WHERE created_at >= ? AND created_at <= ?';
$params = [$from . ' 00:00:00', $to . ' 23:59:59'];
if ($q !== '') {
    $sql .= ' AND (order_number LIKE ? OR last_name LIKE ? OR phone LIKE ?)';
    array_push($params, "%$q%", "%$q%", "%$q%");
}
$sql .= ' ORDER BY id DESC LIMIT 300';
$orders = Db::all($sql, $params);

$sum = 0;
foreach ($orders as $o) {
    if ($o['status'] !== 'cancelled') {
        $sum += (int) $o['total_cents'];
    }
}

layout_start('História objednávok', 'dashboard', $user);
?>
<div class="page-head">
  <div><p class="eyebrow">Prehľad</p><h1>História objednávok</h1></div>
  <a class="btn btn-sm btn-ghost" href="dashboard.php">Späť na nástenku</a>
</div>

<div class="card no-print" style="margin-bottom:16px">
  <form method="get" class="row row-3" style="align-items:end">
    <label class="field" style="margin:0"><span>Od</span><input type="date" name="from" value="<?= e($from) ?>"></label>
    <label class="field" style="margin:0"><span>Do</span><input type="date" name="to" value="<?= e($to) ?>"></label>
    <label class="field" style="margin:0"><span>Hľadať (číslo, priezvisko, telefón)</span>
      <input type="text" name="q" value="<?= e($q) ?>" placeholder="ENZO-1042">
    </label>
    <div><button class="btn btn-block" type="submit">Zobraziť</button></div>
  </form>
</div>

<div class="card">
  <p class="eyebrow" style="margin-bottom:10px">
    <?= count($orders) ?> objednávok · tržba (bez zrušených) <?= e(Money::format($sum)) ?>
  </p>
  <div class="table-wrap">
    <table class="data">
      <thead><tr>
        <th>Číslo</th><th>Dátum</th><th>Zákazník</th><th>Typ</th><th>Platba</th><th>Stav</th><th class="num">Suma</th><th></th>
      </tr></thead>
      <tbody>
      <?php foreach ($orders as $o): ?>
        <tr>
          <td><strong>#<?= e($o['order_number']) ?></strong><?= $o['doc_number'] ? '<div class="hint">' . e($o['doc_number']) . '</div>' : '' ?></td>
          <td><?= e(date('d.m.Y H:i', strtotime((string) $o['created_at']))) ?></td>
          <td><?= e($o['first_name'] . ' ' . $o['last_name']) ?><div class="hint"><?= e($o['phone']) ?></div></td>
          <td><?= $o['order_type'] === 'pickup' ? 'Odber' : 'Rozvoz' ?></td>
          <td>
            <?= $o['payment_method'] === 'card' ? 'Karta' : 'Hotovosť' ?>
            <span class="badge badge-<?= $o['payment_status'] === 'paid' ? 'paid' : 'unpaid' ?>">
              <?= $o['payment_status'] === 'paid' ? 'zaplatené' : 'nezapl.' ?>
            </span>
          </td>
          <td><span class="badge badge-<?= e($o['status']) ?>"><?= e(OrderService::STATUS_LABELS[$o['status']] ?? $o['status']) ?></span></td>
          <td class="num"><?= e(Money::format((int) $o['total_cents'])) ?></td>
          <td><a class="btn btn-sm btn-ghost" href="order.php?id=<?= (int) $o['id'] ?>">Detail</a></td>
        </tr>
      <?php endforeach; ?>
      <?php if ($orders === []): ?>
        <tr><td colspan="8" class="hint">Za zvolené obdobie nič nie je.</td></tr>
      <?php endif; ?>
      </tbody>
    </table>
  </div>
</div>
<?php layout_end(); ?>
