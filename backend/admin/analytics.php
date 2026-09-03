<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

/**
 * Prehľad prevádzky — čo sa deje dnes a ako sa darí za posledné dni.
 * Účtovné podklady sú inde (accounting.php); toto je pre šéfa kuchyne.
 */

$user = Auth::requireRole(Auth::ROLE_ADMIN);

$days  = max(7, min(90, (int) ($_GET['days'] ?? 14)));
$today = Analytics::day();
$live  = Analytics::liveCounts();
$from  = date('Y-m-d', strtotime('-' . ($days - 1) . ' days')) . ' 00:00:00';
$to    = date('Y-m-d') . ' 23:59:59';
$top   = Analytics::topProducts($from, $to, 8);
$daily = Analytics::daily($days);
$times = Analytics::timings(30);

$maxRevenue = 0;
foreach ($daily as $d) {
    $maxRevenue = max($maxRevenue, $d['revenue']);
}
$periodRevenue = array_sum(array_column($daily, 'revenue'));
$periodOrders  = array_sum(array_column($daily, 'orders'));

layout_start('Prehľad', 'analytics', $user);
flash_render();

/** Sekundy na „2 min“ / „45 s“. */
function human_secs(?int $s): string
{
    if ($s === null) {
        return '—';
    }
    return $s < 90 ? $s . ' s' : round($s / 60) . ' min';
}
?>
<div class="page-head">
  <div><p class="eyebrow">Prevádzka</p><h1>Prehľad</h1></div>
  <form method="get" class="row" style="gap:8px;align-items:flex-end;margin:0">
    <label class="field" style="margin:0"><span>Obdobie</span>
      <select name="days" onchange="this.form.submit()">
        <?php foreach ([7 => 'posledných 7 dní', 14 => 'posledných 14 dní', 30 => 'posledných 30 dní', 90 => 'posledných 90 dní'] as $v => $l): ?>
          <option value="<?= $v ?>" <?= $days === $v ? 'selected' : '' ?>><?= $l ?></option>
        <?php endforeach; ?>
      </select>
    </label>
  </form>
</div>

<?php /* Dnešok — to, čo šéfa zaujíma najviac */ ?>
<div class="stats">
  <div class="stat">
    <span class="stat-label">Dnešná tržba</span>
    <strong class="stat-value"><?= e(Money::format($today['revenue'])) ?></strong>
    <span class="hint"><?= (int) $today['orders'] ?> objednávok</span>
  </div>
  <div class="stat">
    <span class="stat-label">Priemerná objednávka</span>
    <strong class="stat-value"><?= e(Money::format($today['averageOrder'])) ?></strong>
    <span class="hint">dnes</span>
  </div>
  <div class="stat">
    <span class="stat-label">Práve rozrobené</span>
    <strong class="stat-value"><?= (int) array_sum($live) ?></strong>
    <span class="hint">
      <?= (int) $live['received'] ?> nových ·
      <?= (int) ($live['accepted'] + $live['preparing']) ?> v príprave ·
      <?= (int) ($live['ready'] + $live['delivering']) ?> hotových
    </span>
  </div>
  <div class="stat">
    <span class="stat-label">Odmietnuté dnes</span>
    <strong class="stat-value"><?= (int) $today['rejected'] ?></strong>
    <span class="hint">zrušené aj odmietnuté</span>
  </div>
</div>

<div class="grid grid-2" style="margin-top:16px">
  <div class="card">
    <h2>Tržba po dňoch</h2>
    <p class="hint" style="margin-top:4px">
      Spolu <strong><?= e(Money::format($periodRevenue)) ?></strong>
      za <?= (int) $periodOrders ?> objednávok.
    </p>
    <?php /* Jednoduchý stĺpcový graf z divov — netreba naň knižnicu. */ ?>
    <div class="chart" style="margin-top:14px">
      <?php foreach ($daily as $d): ?>
        <?php $h = $maxRevenue > 0 ? max(2, (int) round($d['revenue'] / $maxRevenue * 100)) : 2; ?>
        <div class="chart-col" title="<?= e(date('j.n.', strtotime($d['date'])) . ' — ' . Money::format($d['revenue'])) ?>">
          <div class="chart-bar" style="height:<?= $h ?>%"></div>
          <span class="chart-label"><?= e(date('j.n.', strtotime($d['date']))) ?></span>
        </div>
      <?php endforeach; ?>
    </div>
    <?php /* Zaujíma nás koniec grafu — dnešok, nie čo bolo pred dvoma týždňami. */ ?>
    <script>
      (function () {
        var c = document.currentScript.previousElementSibling;
        if (c) c.scrollLeft = c.scrollWidth;
      })();
    </script>
  </div>

  <div class="card">
    <h2>Najpredávanejšie</h2>
    <div class="table-wrap" style="margin-top:12px">
      <table class="data">
        <thead><tr><th>Položka</th><th class="num">Ks</th><th class="num">Tržba</th></tr></thead>
        <tbody>
        <?php foreach ($top as $t): ?>
          <tr>
            <td><?= e($t['name']) ?></td>
            <td class="num"><?= (int) $t['quantity'] ?></td>
            <td class="num"><?= e(Money::format($t['revenue'])) ?></td>
          </tr>
        <?php endforeach; ?>
        <?php if ($top === []): ?>
          <tr><td colspan="3" class="hint">Za toto obdobie zatiaľ nič.</td></tr>
        <?php endif; ?>
        </tbody>
      </table>
    </div>
  </div>
</div>

<div class="card" style="margin-top:16px">
  <h2>Ako nám to ide</h2>
  <div class="stats" style="margin-top:12px">
    <div class="stat">
      <span class="stat-label">Kým objednávku prijmeme</span>
      <strong class="stat-value"><?= e(human_secs($times['acceptMedian'])) ?></strong>
      <span class="hint">medián za 30 dní</span>
    </div>
    <div class="stat">
      <span class="stat-label">Sľúbený čas prípravy</span>
      <strong class="stat-value"><?= $times['prepAverage'] !== null ? (int) $times['prepAverage'] . ' min' : '—' ?></strong>
      <span class="hint">priemer za 30 dní</span>
    </div>
    <div class="stat">
      <span class="stat-label">Nestihnutých v čase</span>
      <strong class="stat-value"><?= $times['lateShare'] !== null ? round($times['lateShare'] * 100) . ' %' : '—' ?></strong>
      <span class="hint">hotové neskôr, než sme sľúbili</span>
    </div>
  </div>
  <p class="hint" style="margin-top:12px">
    Keď je podiel nestihnutých vysoký, netreba variť rýchlejšie — stačí
    zákazníkom sľubovať realistickejší čas.
  </p>
</div>
<?php layout_end(); ?>
