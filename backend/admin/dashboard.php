<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

$user = Auth::requireLogin();
$accepting = Settings::bool('accepting_orders');
$defaultMins = max(5, Settings::int('default_prep_minutes'));

layout_start('Objednávky', 'dashboard', $user);
flash_render();
?>

<div class="page-head">
  <div>
    <p class="eyebrow">Živý prehľad</p>
    <h1>Objednávky</h1>
  </div>
  <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <span id="pulse" class="badge badge-completed">Načítavam…</span>
    <form method="post" action="toggle-orders.php" style="margin:0">
      <?= Csrf::field() ?>
      <button class="btn btn-sm <?= $accepting ? 'btn-ghost' : 'btn-gold' ?>" type="submit">
        <?= $accepting ? 'Zastaviť príjem objednávok' : 'Spustiť príjem objednávok' ?>
      </button>
    </form>
    <a class="btn btn-sm btn-ghost" href="orders-history.php">História</a>
  </div>
</div>

<?php if (!$accepting): ?>
  <div class="alert alert-info">
    <strong>Príjem objednávok je zastavený.</strong>
    Zákazníci na webe vidia hlášku: „<?= e(Settings::get('closed_message')) ?>“
  </div>
<?php endif; ?>

<div class="card no-print" style="margin-bottom:16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap">
  <label class="checkline" style="margin:0">
    <input type="checkbox" id="soundOn" checked>
    <span>Zvuk pri novej objednávke</span>
  </label>
  <span class="hint" style="margin:0">Stránka sa sama obnovuje každých 10 sekúnd.</span>
  <span class="hint" style="margin:0;margin-left:auto" id="lastUpdate"></span>
</div>

<div class="board" id="board">
  <div class="column">
    <h2>Nové <span class="count" id="c-received">0</span></h2>
    <div id="col-received"></div>
  </div>
  <div class="column">
    <h2>V príprave <span class="count" id="c-confirmed">0</span></h2>
    <div id="col-confirmed"></div>
  </div>
  <div class="column">
    <h2>Pripravené <span class="count" id="c-ready">0</span></h2>
    <div id="col-ready"></div>
  </div>
</div>

<template id="tpl-empty">
  <p class="hint" style="padding:10px 4px">Zatiaľ nič.</p>
</template>

<script>
const DEFAULT_MINS = <?= (int) $defaultMins ?>;
const CSRF = <?= json_encode(Csrf::token()) ?>;
</script>
<script src="assets/board.js?v=2"></script>

<?php layout_end(); ?>
