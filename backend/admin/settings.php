<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

$user = Auth::requireAdmin();

/** Polia, ktoré sa dajú meniť z adminu. */
$FIELDS = [
    'Prevádzka' => [
        'shop_name'        => ['Názov', 'text'],
        'shop_street'      => ['Ulica a číslo', 'text'],
        'shop_city'        => ['Obec', 'text'],
        'shop_postal_code' => ['PSČ', 'text'],
        'shop_phone'       => ['Telefón', 'text'],
        'shop_email'       => ['E-mail', 'text'],
        'instagram_url'    => ['Instagram (celá adresa)', 'text'],
        'facebook_url'     => ['Facebook (celá adresa)', 'text'],
    ],
    'Fakturačné údaje' => [
        'company_name'    => ['Obchodné meno', 'text'],
        'company_ico'     => ['IČO', 'text'],
        'company_dic'     => ['DIČ', 'text'],
        'company_seat'    => ['Sídlo', 'text'],
        'company_manager' => ['Zodpovedný vedúci', 'text'],
    ],
    'Objednávky' => [
        'delivery_fee'         => ['Poplatok za rozvoz (€)', 'money'],
        'free_delivery_from'   => ['Rozvoz zdarma od (€)', 'money'],
        'min_order'            => ['Minimálna objednávka (€)', 'money'],
        'prep_time_pickup'     => ['Text — čas osobného odberu', 'text'],
        'prep_time_delivery'   => ['Text — čas rozvozu', 'text'],
        'default_prep_minutes' => ['Predvolená minutáž v admine', 'number'],
        'closed_message'       => ['Hláška pri zastavenom príjme', 'textarea'],
    ],
    'Rozvoz a otváracie hodiny' => [
        'delivery_zones' => ['Rozvozové obce (každá na nový riadok)', 'textarea'],
        'opening_hours'  => ['Otváracie hodiny (Dni|Čas na každom riadku)', 'textarea'],
    ],
];

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    Csrf::require();
    foreach ($FIELDS as $group) {
        foreach ($group as $key => [$label, $type]) {
            if (!array_key_exists($key, $_POST)) {
                continue;
            }
            $value = (string) $_POST[$key];
            if ($type === 'money') {
                $value = number_format((float) str_replace(',', '.', $value), 2, '.', '');
            } elseif ($type === 'number') {
                $value = (string) max(1, (int) $value);
            } elseif ($type === 'textarea') {
                $value = trim(str_replace("\r\n", "\n", $value));
            } else {
                $value = Validate::clean($value, 255);
            }
            Settings::set($key, $value);
        }
    }
    flash_redirect('settings.php', 'ok', 'Nastavenia boli uložené.');
}

$stripe = (array) cfg('payments.stripe', []);
$mail   = (array) cfg('mail', []);

layout_start('Nastavenia', 'settings', $user);
flash_render();
?>
<div class="page-head">
  <div><p class="eyebrow">Web a prevádzka</p><h1>Nastavenia</h1></div>
  <button class="btn" type="submit" form="settingsForm">Uložiť zmeny</button>
</div>

<form method="post" id="settingsForm">
  <?= Csrf::field() ?>
  <div class="grid grid-2">
    <?php foreach ($FIELDS as $groupName => $fields): ?>
      <div class="card">
        <h2><?= e($groupName) ?></h2>
        <div style="margin-top:14px">
          <?php foreach ($fields as $key => [$label, $type]): ?>
            <label class="field">
              <span><?= e($label) ?></span>
              <?php $v = (string) Settings::get($key); ?>
              <?php if ($type === 'textarea'): ?>
                <textarea name="<?= e($key) ?>" rows="<?= $key === 'opening_hours' ? 4 : 6 ?>"><?= e($v) ?></textarea>
              <?php elseif ($type === 'money'): ?>
                <input type="text" name="<?= e($key) ?>" inputmode="decimal"
                       value="<?= e(number_format((float) $v, 2, ',', '')) ?>">
              <?php elseif ($type === 'number'): ?>
                <input type="number" name="<?= e($key) ?>" min="5" max="180" value="<?= e($v) ?>">
              <?php else: ?>
                <input type="text" name="<?= e($key) ?>" value="<?= e($v) ?>">
              <?php endif; ?>
              <?php if ($key === 'opening_hours'): ?>
                <div class="hint">Napr. <code>Pondelok — Štvrtok|11:00 — 21:00</code></div>
              <?php endif; ?>
            </label>
          <?php endforeach; ?>
        </div>
      </div>
    <?php endforeach; ?>
  </div>

  <button class="btn btn-lg" type="submit" style="margin-top:18px">Uložiť zmeny</button>
</form>

<div class="card" style="margin-top:26px">
  <h2>Platby a e-maily</h2>
  <p class="hint" style="margin-top:6px">
    Tieto veci sa z bezpečnostných dôvodov nastavujú v súbore
    <code>api/config.php</code> na serveri, nie odtiaľto.
  </p>
  <div class="table-wrap" style="margin-top:12px">
    <table class="data">
      <tr>
        <th style="width:220px">Platba kartou</th>
        <td>
          <?php $cardOn = ($stripe['enabled'] ?? false) && ($stripe['secret_key'] ?? '') !== ''; ?>
          <span class="badge badge-<?= $cardOn ? 'ready' : 'completed' ?>">
            <?= $cardOn ? 'Zapnutá' : 'Vypnutá' ?>
          </span>
          <div class="hint">
            <?= $cardOn
              ? 'Zákazníci môžu platiť kartou cez Stripe.'
              : 'Kým nedoplníš Stripe kľúče, v pokladni sa karta vôbec neponúkne.' ?>
          </div>
        </td>
      </tr>
      <tr>
        <th>Platba v hotovosti</th>
        <td><span class="badge badge-<?= cfg('payments.cash_enabled', true) ? 'ready' : 'completed' ?>">
          <?= cfg('payments.cash_enabled', true) ? 'Zapnutá' : 'Vypnutá' ?></span></td>
      </tr>
      <tr>
        <th>Odosielanie e-mailov</th>
        <td>
          <?php $t = (string) ($mail['transport'] ?? ''); ?>
          <span class="badge badge-<?= $t === 'smtp' ? 'ready' : ($t === 'log' ? 'received' : 'completed') ?>">
            <?= $t === 'smtp' ? 'SMTP' : ($t === 'log' ? 'Testovací režim' : 'PHP mail()') ?>
          </span>
          <div class="hint">
            <?php if ($t === 'log'): ?>
              E-maily sa <strong>neposielajú</strong>, iba ukladajú do <code>storage/mail/</code>. Pred spustením prepni na <code>smtp</code>.
            <?php else: ?>
              Odosielateľ: <?= e((string) ($mail['from_email'] ?? '')) ?> ·
              Upozornenia na nové objednávky: <?= e((string) ($mail['shop_notify'] ?? '')) ?>
            <?php endif; ?>
          </div>
        </td>
      </tr>
      <tr>
        <th>Platiteľ DPH</th>
        <td><span class="badge badge-<?= cfg('accounting.vat_payer', false) ? 'ready' : 'completed' ?>">
          <?= cfg('accounting.vat_payer', false) ? 'Áno' : 'Nie' ?></span>
          <div class="hint">Ak si platiteľ, na dokladoch pribudne rozpis DPH.</div>
        </td>
      </tr>
    </table>
  </div>
</div>

<?php layout_end(); ?>
