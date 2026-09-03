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

<div class="card no-print statusbar">
  <label class="checkline" style="margin:0">
    <input type="checkbox" id="soundOn" checked>
    <span>Zvuk pri novej objednávke</span>
  </label>
  <span class="hint refresh-note">Stránka sa sama obnovuje každých 10 sekúnd.</span>
  <span class="hint" id="lastUpdate"></span>
</div>

<?php /* Na telefóne slúžia záložky namiesto troch stĺpcov pod sebou. */ ?>
<div class="board-tabs no-print" id="boardTabs" role="tablist" aria-label="Stĺpce objednávok">
  <button type="button" role="tab" data-tab="received" class="active" aria-selected="true">
    Nové <span class="count" id="t-received">0</span>
  </button>
  <button type="button" role="tab" data-tab="working" aria-selected="false">
    V príprave <span class="count" id="t-working">0</span>
  </button>
  <button type="button" role="tab" data-tab="ready" aria-selected="false">
    Hotové <span class="count" id="t-ready">0</span>
  </button>
</div>

<div class="board" id="board" data-active="received">
  <div class="column" data-col="received">
    <h2>Nové <span class="count" id="c-received">0</span></h2>
    <div id="col-received"></div>
  </div>
  <div class="column" data-col="working">
    <h2>V príprave <span class="count" id="c-working">0</span></h2>
    <div id="col-working"></div>
  </div>
  <div class="column" data-col="ready">
    <h2>Hotové <span class="count" id="c-ready">0</span></h2>
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
<script src="assets/board.js?v=3"></script>

<?php layout_end(); ?>
