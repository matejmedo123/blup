<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

$user = Auth::requireAdmin();

$month = Validate::clean($_GET['month'] ?? date('Y-m'), 7);
if (!preg_match('/^\d{4}-\d{2}$/', $month)) {
    $month = date('Y-m');
}
$from = $month . '-01 00:00:00';
$to   = date('Y-m-t 23:59:59', strtotime($month . '-01'));

/* Do účtovníctva idú len skutočne vybavené objednávky. */
$orders = Db::all(
    "SELECT * FROM orders
     WHERE created_at >= ? AND created_at <= ? AND status <> 'cancelled'
     ORDER BY created_at",
    [$from, $to]
);

$vatPayer = (bool) cfg('accounting.vat_payer', false);

$sum = ['count' => 0, 'total' => 0, 'delivery' => 0, 'cash' => 0, 'card' => 0, 'unpaid' => 0];
$vatTotals = [];
foreach ($orders as $o) {
    $sum['count']++;
    $sum['total']    += (int) $o['total_cents'];
    $sum['delivery'] += (int) $o['delivery_fee_cents'];
    if ($o['payment_status'] === 'paid') {
        $sum[$o['payment_method'] === 'card' ? 'card' : 'cash'] += (int) $o['total_cents'];
    } else {
        $sum['unpaid'] += (int) $o['total_cents'];
    }
    foreach (json_decode((string) ($o['vat_breakdown'] ?? '[]'), true) ?: [] as $g => $v) {
        $vatTotals[$g]['rate']   = $v['rate'];
        $vatTotals[$g]['base']   = ($vatTotals[$g]['base'] ?? 0) + (int) $v['base'];
        $vatTotals[$g]['vat']    = ($vatTotals[$g]['vat'] ?? 0) + (int) $v['vat'];
        $vatTotals[$g]['gross']  = ($vatTotals[$g]['gross'] ?? 0) + (int) $v['gross'];
    }
}

/* Zoznam mesiacov, v ktorých niečo je */
$months = Db::all(
    Db::driver() === 'sqlite'
        ? "SELECT DISTINCT substr(created_at, 1, 7) AS m FROM orders ORDER BY m DESC LIMIT 24"
        : "SELECT DISTINCT DATE_FORMAT(created_at, '%Y-%m') AS m FROM orders ORDER BY m DESC LIMIT 24"
);

layout_start('Účtovníctvo', 'accounting', $user);
?>
<div class="page-head">
  <div><p class="eyebrow">Tržby a doklady</p><h1>Účtovníctvo</h1></div>
  <form method="get" style="display:flex;gap:8px;align-items:center">
    <select name="month" onchange="this.form.submit()">
      <?php if ($months === []): ?><option><?= e($month) ?></option><?php endif; ?>
      <?php foreach ($months as $m): ?>
        <option value="<?= e($m['m']) ?>"<?= $m['m'] === $month ? ' selected' : '' ?>>
          <?= e(date('F Y', strtotime($m['m'] . '-01'))) ?> (<?= e($m['m']) ?>)
        </option>
      <?php endforeach; ?>
    </select>
    <noscript><button class="btn btn-sm">Zobraziť</button></noscript>
  </form>
</div>

<div class="grid grid-3">
  <div class="card">
    <p class="eyebrow">Tržba spolu</p>
    <p style="font-size:32px;font-weight:800;color:var(--burgundy);margin-top:4px">
      <?= e(Money::format($sum['total'])) ?></p>
    <p class="hint"><?= $sum['count'] ?> objednávok · z toho rozvoz <?= e(Money::format($sum['delivery'])) ?></p>
  </div>
  <div class="card">
    <p class="eyebrow">Podľa platby</p>
    <table class="data" style="margin-top:8px">
      <tr><th>Hotovosť</th><td class="num"><?= e(Money::format($sum['cash'])) ?></td></tr>
      <tr><th>Karta</th><td class="num"><?= e(Money::format($sum['card'])) ?></td></tr>
      <tr><th>Neuhradené</th><td class="num" style="color:var(--red)"><?= e(Money::format($sum['unpaid'])) ?></td></tr>
    </table>
  </div>
  <div class="card">
    <p class="eyebrow">DPH</p>
    <?php if (!$vatPayer): ?>
      <p class="hint" style="margin-top:8px">Prevádzka nie je vedená ako platiteľ DPH,
        rozpis sa preto nepočíta. Zmeníš to v <code>api/config.php</code>.</p>
    <?php elseif ($vatTotals === []): ?>
      <p class="hint" style="margin-top:8px">Za tento mesiac nič.</p>
    <?php else: ?>
      <table class="data" style="margin-top:8px">
        <?php foreach ($vatTotals as $g => $v): ?>
          <tr>
            <th><?= $g === 'drinks' ? 'Nápoje' : 'Jedlo' ?>
              <?= e(rtrim(rtrim(number_format((float) $v['rate'], 2, ',', ''), '0'), ',')) ?> %</th>
            <td class="num"><?= e(Money::format((int) $v['vat'])) ?>
              <div class="hint">základ <?= e(Money::format((int) $v['base'])) ?></div></td>
          </tr>
        <?php endforeach; ?>
      </table>
    <?php endif; ?>
  </div>
</div>

<div class="card" style="margin-top:16px">
  <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
    <h2>Export pre účtovníčku</h2>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <a class="btn" href="export.php?month=<?= e($month) ?>&amp;type=orders">Objednávky (CSV)</a>
      <a class="btn btn-ghost" href="export.php?month=<?= e($month) ?>&amp;type=items">Položky (CSV)</a>
    </div>
  </div>
  <p class="hint" style="margin-top:8px">
    CSV je v kódovaní UTF-8 s BOM a bodkočiarkou ako oddeľovačom — Excel ho otvorí správne.
    Export obsahuje len nezrušené objednávky.
  </p>
</div>

<div class="alert alert-info" style="margin-top:16px">
  <strong>Dôležité k eKase.</strong> Tento systém eviduje objednávky a vytvára k nim doklady,
  ale <strong>nenahrádza registračnú pokladnicu eKasa</strong>. Ak prijímaš platby v hotovosti
  alebo kartou na prevádzke, na vydanie daňového dokladu potrebuješ eKasu.
  Over si to so svojou účtovníčkou — pravidlá sa líšia podľa toho, či ide o predaj
  na prevádzke alebo o zásielkový predaj hradený vopred.
</div>

<div class="card" style="margin-top:16px">
  <h2>Doklady v mesiaci</h2>
  <div class="table-wrap" style="margin-top:12px">
    <table class="data">
      <thead><tr>
        <th>Doklad</th><th>Objednávka</th><th>Dátum</th><th>Zákazník</th>
        <th>Platba</th><th class="num">Bez DPH</th><th class="num">DPH</th><th class="num">Spolu</th>
      </tr></thead>
      <tbody>
      <?php foreach ($orders as $o): ?>
        <?php
        $vat  = json_decode((string) ($o['vat_breakdown'] ?? '[]'), true) ?: [];
        $base = 0;
        $tax  = 0;
        foreach ($vat as $v) {
            $base += (int) $v['base'];
            $tax  += (int) $v['vat'];
        }
        ?>
        <tr>
          <td><?= $o['doc_number'] ? '<strong>' . e($o['doc_number']) . '</strong>' : '<span class="hint">—</span>' ?></td>
          <td><a href="order.php?id=<?= (int) $o['id'] ?>">#<?= e($o['order_number']) ?></a></td>
          <td class="hint"><?= e(date('d.m.Y H:i', strtotime((string) $o['created_at']))) ?></td>
          <td><?= e($o['first_name'] . ' ' . $o['last_name']) ?></td>
          <td>
            <?= $o['payment_method'] === 'card' ? 'Karta' : 'Hotovosť' ?>
            <?php if ($o['payment_status'] !== 'paid'): ?>
              <span class="badge badge-unpaid">nezapl.</span>
            <?php endif; ?>
          </td>
          <td class="num"><?= $base > 0 ? e(Money::format($base)) : '<span class="hint">—</span>' ?></td>
          <td class="num"><?= $tax > 0 ? e(Money::format($tax)) : '<span class="hint">—</span>' ?></td>
          <td class="num"><strong><?= e(Money::format((int) $o['total_cents'])) ?></strong></td>
        </tr>
      <?php endforeach; ?>
      <?php if ($orders === []): ?>
        <tr><td colspan="8" class="hint">Za tento mesiac nič nie je.</td></tr>
      <?php endif; ?>
      </tbody>
    </table>
  </div>
</div>

<?php layout_end(); ?>
