<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

$user  = Auth::requireLogin();
$id    = (int) ($_GET['id'] ?? 0);
$order = $id > 0 ? OrderService::findById($id) : null;

if ($order === null) {
    layout_start('Objednávka', 'dashboard', $user);
    echo '<div class="alert alert-err">Objednávka sa nenašla.</div><a class="btn" href="dashboard.php">Späť</a>';
    layout_end();
    exit;
}

$isPickup = $order['order_type'] === 'pickup';
$mailLog  = Db::all('SELECT * FROM mail_log WHERE order_id = ? ORDER BY id', [$id]);

layout_start('Objednávka #' . $order['order_number'], 'dashboard', $user);
flash_render();
?>

<div class="page-head no-print">
  <div>
    <p class="eyebrow"><?= $isPickup ? 'Osobný odber' : 'Rozvoz' ?></p>
    <h1>#<?= e($order['order_number']) ?></h1>
  </div>
  <div style="display:flex;gap:8px;flex-wrap:wrap">
    <button class="btn btn-ghost" onclick="window.print()">Vytlačiť blok</button>
    <a class="btn btn-ghost" href="dashboard.php">Späť na nástenku</a>
  </div>
</div>

<div class="grid grid-2 no-print">
  <!-- ---------- Ľavý stĺpec: stav a akcie ---------- -->
  <div>
    <div class="card">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
        <span class="badge badge-<?= e($order['status']) ?>">
          <?= e(OrderService::STATUS_LABELS[$order['status']] ?? $order['status']) ?>
        </span>
        <span class="badge badge-<?= $order['payment_status'] === 'paid' ? 'paid' : 'unpaid' ?>">
          <?= $order['payment_method'] === 'card' ? 'Karta' : 'Hotovosť' ?>
          · <?= $order['payment_status'] === 'paid' ? 'zaplatené' : 'nezaplatené' ?>
        </span>
        <?php if ($order['doc_number']): ?>
          <span class="badge badge-completed">Doklad <?= e($order['doc_number']) ?></span>
        <?php endif; ?>
      </div>

      <?php if ($order['ready_at']): ?>
        <p class="eyebrow">Hotové o</p>
        <p style="font-size:34px;font-weight:800;line-height:1.1">
          <?= e(date('H:i', strtotime((string) $order['ready_at']))) ?>
          <span style="font-size:15px;font-weight:600;color:var(--muted)">
            (<?= (int) $order['prep_minutes'] ?> min)
          </span>
        </p>
      <?php endif; ?>

      <div id="actions" style="margin-top:14px">
        <?php if ($order['status'] === OrderService::STATUS_RECEIVED): ?>
          <p class="eyebrow">Za koľko to bude hotové?</p>
          <div class="mins" id="mins">
            <?php foreach ([15, 20, 25, 30, 45, 60] as $m): ?>
              <button type="button" data-mins="<?= $m ?>"<?= $m === Settings::int('default_prep_minutes') ? ' class="sel"' : '' ?>><?= $m ?>′</button>
            <?php endforeach; ?>
          </div>
          <button class="btn btn-gold btn-lg btn-block" data-act="confirm">Potvrdiť a poslať zákazníkovi</button>
        <?php elseif ($order['status'] === OrderService::STATUS_CONFIRMED): ?>
          <button class="btn btn-gold btn-lg btn-block" data-act="ready">
            <?= $isPickup ? 'Pripravené na odber' : 'Kuriér vyrazil' ?>
          </button>
        <?php elseif ($order['status'] === OrderService::STATUS_READY): ?>
          <button class="btn btn-lg btn-block" data-act="complete">Vybavené</button>
        <?php endif; ?>

        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <?php if ($order['payment_status'] !== 'paid'): ?>
            <button class="btn btn-sm btn-ghost" data-act="mark_paid">Označiť ako zaplatené</button>
          <?php endif; ?>
          <?php if (!in_array($order['status'], [OrderService::STATUS_CANCELLED, OrderService::STATUS_COMPLETED], true)): ?>
            <button class="btn btn-sm btn-danger" data-act="cancel">Zrušiť objednávku</button>
          <?php endif; ?>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Zákazník</h2>
      <table class="data" style="margin-top:10px">
        <tr><th style="width:130px">Meno</th><td><?= e($order['first_name'] . ' ' . $order['last_name']) ?></td></tr>
        <tr><th>Telefón</th><td><a href="tel:<?= e($order['phone']) ?>"><?= e($order['phone']) ?></a></td></tr>
        <tr><th>E-mail</th><td><a href="mailto:<?= e($order['email']) ?>"><?= e($order['email']) ?></a></td></tr>
        <?php if ($isPickup): ?>
          <tr><th>Čas odberu</th><td><?= e($order['pickup_time'] ?: '—') ?></td></tr>
        <?php else: ?>
          <tr><th>Adresa</th><td>
            <?= e(trim(($order['street'] ?? '') . ' ' . ($order['house_number'] ?? ''))) ?><br>
            <?= e(($order['postal_code'] ?? '') . ' ' . ($order['city'] ?? '')) ?>
          </td></tr>
        <?php endif; ?>
        <?php if ($order['note']): ?>
          <tr><th>Poznámka</th><td style="color:var(--burgundy)"><?= e($order['note']) ?></td></tr>
        <?php endif; ?>
        <tr><th>Prijaté</th><td><?= e(date('d.m.Y H:i', strtotime((string) $order['created_at']))) ?></td></tr>
      </table>
    </div>
  </div>

  <!-- ---------- Pravý stĺpec: položky a história ---------- -->
  <div>
    <div class="card">
      <h2>Položky</h2>
      <div class="table-wrap" style="margin-top:10px">
        <table class="data">
          <?php foreach ($order['items'] as $i): ?>
            <tr>
              <td style="width:44px;font-weight:800;color:var(--burgundy)"><?= (int) $i['quantity'] ?>×</td>
              <td>
                <strong><?= e($i['name']) ?></strong>
                <?php foreach ($i['extras'] as $ex): ?>
                  <div class="hint">+ <?= e($ex['name']) ?></div>
                <?php endforeach; ?>
                <?php if ($i['note']): ?>
                  <div style="font-size:12.5px;color:var(--burgundy);font-style:italic">„<?= e($i['note']) ?>“</div>
                <?php endif; ?>
              </td>
              <td class="num"><?= e(Money::format((int) $i['line_cents'])) ?></td>
            </tr>
          <?php endforeach; ?>
          <tr><th>Medzisúčet</th><td></td><td class="num"><?= e(Money::format((int) $order['subtotal_cents'])) ?></td></tr>
          <tr><th><?= $isPickup ? 'Osobný odber' : 'Doručenie' ?></th><td></td>
              <td class="num"><?= e(Money::format((int) $order['delivery_fee_cents'])) ?></td></tr>
          <?php foreach ($order['vat'] as $group => $v): ?>
            <tr><th>DPH <?= $group === 'drinks' ? 'nápoje' : 'jedlo' ?> <?= e(rtrim(rtrim(number_format((float) $v['rate'], 2, ',', ''), '0'), ',')) ?> %</th>
                <td class="hint">základ <?= e(Money::format((int) $v['base'])) ?></td>
                <td class="num"><?= e(Money::format((int) $v['vat'])) ?></td></tr>
          <?php endforeach; ?>
          <tr><th style="font-size:15px;color:var(--ink)">CELKOM</th><td></td>
              <td class="num" style="font-size:19px;font-weight:800;color:var(--burgundy)">
                <?= e(Money::format((int) $order['total_cents'])) ?></td></tr>
        </table>
      </div>
    </div>

    <div class="card">
      <h2>Priebeh</h2>
      <table class="data" style="margin-top:10px">
        <?php foreach ($order['events'] as $ev): ?>
          <tr>
            <td style="width:120px" class="hint"><?= e(date('d.m. H:i', strtotime((string) $ev['created_at']))) ?></td>
            <td><?= e(OrderService::STATUS_LABELS[$ev['event']] ?? $ev['event']) ?>
              <?php if ($ev['detail']): ?><div class="hint"><?= e($ev['detail']) ?></div><?php endif; ?>
            </td>
          </tr>
        <?php endforeach; ?>
      </table>
    </div>

    <div class="card">
      <h2>Odoslané e-maily</h2>
      <?php if ($mailLog === []): ?>
        <p class="hint" style="margin-top:8px">Zatiaľ nič.</p>
      <?php else: ?>
        <table class="data" style="margin-top:10px">
          <?php foreach ($mailLog as $m): ?>
            <tr>
              <td class="hint" style="width:120px"><?= e(date('d.m. H:i', strtotime((string) $m['created_at']))) ?></td>
              <td><?= e($m['subject']) ?><div class="hint"><?= e($m['recipient']) ?></div>
                <?php if ($m['error']): ?><div style="color:var(--red);font-size:12px"><?= e($m['error']) ?></div><?php endif; ?>
              </td>
              <td><span class="badge badge-<?= $m['status'] === 'failed' ? 'cancelled' : 'ready' ?>"><?= e($m['status']) ?></span></td>
            </tr>
          <?php endforeach; ?>
        </table>
      <?php endif; ?>
    </div>
  </div>
</div>

<!-- ---------- Tlačový blok pre kuchyňu ---------- -->
<div class="print-only receipt">
  <div class="center">
    <div style="font-size:26px;font-weight:700;letter-spacing:3px">ENZO</div>
    <div style="font-size:9px;letter-spacing:2px">SMASH BURGERS &amp; PIZZA</div>
    <div style="font-size:9px;margin-top:5px">
      <?= e(Settings::get('shop_street')) ?>, <?= e(Settings::get('shop_postal_code')) ?> <?= e(Settings::get('shop_city')) ?><br>
      <?= e(Settings::get('shop_phone')) ?><br>
      <?= e(Settings::get('company_name')) ?> · IČO <?= e(Settings::get('company_ico')) ?> · DIČ <?= e(Settings::get('company_dic')) ?>
    </div>
  </div>
  <hr>
  <div class="rrow"><strong>OBJEDNÁVKA</strong><strong>#<?= e($order['order_number']) ?></strong></div>
  <?php if ($order['doc_number']): ?>
    <div class="rrow"><span>Doklad</span><span><?= e($order['doc_number']) ?></span></div>
  <?php endif; ?>
  <div class="rrow"><span>Dátum</span><span><?= e(date('d.m.Y H:i', strtotime((string) $order['created_at']))) ?></span></div>
  <div class="rrow"><span>Typ</span><span><?= $isPickup ? 'Osobný odber' : 'Doručenie' ?></span></div>
  <div class="rrow"><span>Platba</span><span><?= $order['payment_method'] === 'card' ? 'Karta' : 'Hotovosť' ?><?= $order['payment_status'] === 'paid' ? ' (zapl.)' : '' ?></span></div>
  <?php if ($order['ready_at']): ?>
    <div class="rrow"><span>Hotové o</span><strong><?= e(date('H:i', strtotime((string) $order['ready_at']))) ?></strong></div>
  <?php endif; ?>
  <hr>
  <div><strong>ZÁKAZNÍK</strong></div>
  <div><?= e($order['first_name'] . ' ' . $order['last_name']) ?></div>
  <div><?= e($order['phone']) ?></div>
  <?php if (!$isPickup): ?>
    <div><?= e(trim(($order['street'] ?? '') . ' ' . ($order['house_number'] ?? ''))) ?>,
      <?= e(($order['postal_code'] ?? '') . ' ' . ($order['city'] ?? '')) ?></div>
  <?php elseif ($order['pickup_time']): ?>
    <div>Odber: <?= e($order['pickup_time']) ?></div>
  <?php endif; ?>
  <?php if ($order['note']): ?><div>Pozn.: <?= e($order['note']) ?></div><?php endif; ?>
  <hr>
  <div><strong>POLOŽKY</strong></div>
  <?php foreach ($order['items'] as $i): ?>
    <div style="margin-bottom:4px">
      <div class="rrow">
        <span><?= (int) $i['quantity'] ?>× <?= e($i['name']) ?></span>
        <span><?= e(Money::plain((int) $i['line_cents'])) ?></span>
      </div>
      <?php foreach ($i['extras'] as $ex): ?>
        <div style="font-size:10px;padding-left:8px">+ <?= e($ex['name']) ?></div>
      <?php endforeach; ?>
      <?php if ($i['note']): ?>
        <div style="font-size:10px;padding-left:8px;font-style:italic">„<?= e($i['note']) ?>“</div>
      <?php endif; ?>
    </div>
  <?php endforeach; ?>
  <hr>
  <div class="rrow"><span>Medzisúčet</span><span><?= e(Money::plain((int) $order['subtotal_cents'])) ?></span></div>
  <div class="rrow"><span><?= $isPickup ? 'Osobný odber' : 'Doručenie' ?></span>
       <span><?= e(Money::plain((int) $order['delivery_fee_cents'])) ?></span></div>
  <?php foreach ($order['vat'] as $group => $v): ?>
    <div class="rrow" style="font-size:10px">
      <span>DPH <?= $group === 'drinks' ? 'nápoje' : 'jedlo' ?> <?= e(rtrim(rtrim(number_format((float) $v['rate'], 2, ',', ''), '0'), ',')) ?> % (zákl. <?= e(Money::plain((int) $v['base'])) ?>)</span>
      <span><?= e(Money::plain((int) $v['vat'])) ?></span>
    </div>
  <?php endforeach; ?>
  <hr>
  <div class="rrow big"><span>CELKOM</span><span><?= e(Money::plain((int) $order['total_cents'])) ?></span></div>
  <hr>
  <div class="center" style="font-size:10px">
    ĎAKUJEME!<br>SMASHED FRESH. SERVED HOT.<br>
    <span style="font-size:9px">Doklad nie je daňovým dokladom v zmysle zákona o eKase.</span>
  </div>
</div>

<script>
const CSRF = <?= json_encode(Csrf::token()) ?>;
const ORDER_ID = <?= (int) $order['id'] ?>;

document.addEventListener('click', function (ev) {
  const minBtn = ev.target.closest('#mins button');
  if (minBtn) {
    document.querySelectorAll('#mins button').forEach(b => b.classList.remove('sel'));
    minBtn.classList.add('sel');
    return;
  }
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;

  const act = btn.getAttribute('data-act');
  const body = { action: act, id: ORDER_ID, _csrf: CSRF };

  if (act === 'confirm') {
    const sel = document.querySelector('#mins button.sel');
    body.minutes = sel ? Number(sel.getAttribute('data-mins')) : 25;
  }
  if (act === 'cancel') {
    const reason = prompt('Dôvod zrušenia (pošle sa zákazníkovi):', 'Prevádzka je momentálne vyťažená.');
    if (reason === null) return;
    body.reason = reason;
  }
  if (act === 'complete' && !confirm('Označiť objednávku ako vybavenú?')) return;

  btn.disabled = true;
  btn.textContent = 'Ukladám…';

  fetch('api.php', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then(r => r.json())
    .then(res => {
      if (!res.ok) throw new Error(res.error || 'Nepodarilo sa uložiť.');
      location.reload();
    })
    .catch(e => { alert(e.message); location.reload(); });
});
</script>

<?php layout_end(); ?>
