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
    'Oznam na webe' => [
        'notice_enabled' => ['Ukazovať oznam návštevníkom', 'toggle'],
        'notice_title'   => ['Nadpis', 'text'],
        'notice_text'    => ['Text', 'textarea'],
        'notice_cta'     => ['Text tlačidla (prázdne = bez tlačidla)', 'text'],
    ],
];

$mailTest = null;

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' && ($_POST['action'] ?? '') === 'test_mail') {
    Csrf::require();

    // Skúšobný e-mail ide vždy na adresu prihláseného — nikam inam sa
    // odtiaľto poslať nedá, aby sa z adminu nedal robiť rozosielač.
    // Adresu berieme z databázy, v relácii je len id, meno a rola.
    $testTo = (string) (Db::value('SELECT email FROM users WHERE id = ?', [(int) $user['id']]) ?? '');

    $mailer = new Mailer((array) cfg('mail', []));
    $mailTest = $mailer->send(
        $testTo,
        'Skúšobný e-mail z ENZO',
        '<p>Toto je skúšobný e-mail z tvojho objednávkového systému.'
            . ' Keď ti prišiel, odosielanie funguje.</p>',
        "Toto je skúšobný e-mail z tvojho objednávkového systému.\n"
            . "Keď ti prišiel, odosielanie funguje.\n",
    );
    AuditLog::record($user, 'test', 'mail', null, $mailTest['ok'] ? 'Skúšobný e-mail odoslaný' : 'Skúšobný e-mail zlyhal');
}

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' && ($_POST['action'] ?? '') !== 'test_mail') {
    Csrf::require();
    foreach ($FIELDS as $group) {
        foreach ($group as $key => [$label, $type]) {
            if (!array_key_exists($key, $_POST)) {
                continue;
            }
            $value = (string) $_POST[$key];
            if ($type === 'toggle') {
                $value = $value === '1' ? '1' : '0';
            } elseif ($type === 'money') {
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

<?php /* Rozcestník sa sám poskladá podľa šírky — kariet pribúda. */ ?>
<div class="grid" style="margin-bottom:18px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))">
  <a class="card linkcard" href="hours.php">
    <h2>Otváracie hodiny</h2>
    <p class="hint">Hodiny po dňoch, posledná objednávka pred zatvorením
      a mimoriadne zatvorenia. Systém ich naozaj vynucuje.</p>
    <span class="linkcard-go">Nastaviť →</span>
  </a>
  <a class="card linkcard" href="zones.php">
    <h2>Doručovacie zóny</h2>
    <p class="hint">Obce, kam vozíš — každá s vlastným poplatkom, minimom
      a časom. Adresu mimo zón systém odmietne.</p>
    <span class="linkcard-go">Nastaviť →</span>
  </a>
  <a class="card linkcard" href="coupons.php">
    <h2>Zľavové kódy</h2>
    <p class="hint">Percentá, pevná suma alebo doručenie zdarma;
      s obmedzením počtu použití a platnosti.</p>
    <span class="linkcard-go">Nastaviť →</span>
  </a>
  <a class="card linkcard" href="content.php">
    <h2>Fotky a texty na webe</h2>
    <p class="hint">Veľká fotka navrchu, dlaždice a fotky pri značke —
      aj s nadpismi. Fotky položiek sa menia priamo v menu.</p>
    <span class="linkcard-go">Nastaviť →</span>
  </a>
  <a class="card linkcard" href="kontrola.php">
    <h2>Kontrola</h2>
    <p class="hint">Či sú na serveri všetky fotky a či prenos súborov na
      hosting prešiel celý. Chýbajúce cesty vie opraviť jedným klikom.</p>
    <span class="linkcard-go">Pozrieť →</span>
  </a>
  <a class="card linkcard" href="load.php">
    <h2>Automatické časy</h2>
    <p class="hint">Keď je kuchyňa zavalená, web sám predĺži sľúbené časy.
      Nastav, koľko objednávok zvládaš naraz a o koľko sa pridáva.</p>
    <span class="linkcard-go">Nastaviť →</span>
  </a>
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
              <?php if ($type === 'toggle'): ?>
                <input type="hidden" name="<?= e($key) ?>" value="0">
                <span class="checkline" style="margin:6px 0 0">
                  <input type="checkbox" name="<?= e($key) ?>" value="1"<?= $v === '1' ? ' checked' : '' ?>>
                  <span>zapnuté</span>
                </span>
              <?php elseif ($type === 'textarea'): ?>
                <textarea name="<?= e($key) ?>" rows="4"><?= e($v) ?></textarea>
              <?php elseif ($type === 'money'): ?>
                <input type="text" name="<?= e($key) ?>" inputmode="decimal"
                       value="<?= e(number_format((float) $v, 2, ',', '')) ?>">
              <?php elseif ($type === 'number'): ?>
                <input type="number" name="<?= e($key) ?>" min="5" max="180" value="<?= e($v) ?>">
              <?php else: ?>
                <input type="text" name="<?= e($key) ?>" value="<?= e($v) ?>">
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
        <th>Skúška odosielania</th>
        <td>
          <form method="post" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <?= Csrf::field() ?>
            <input type="hidden" name="action" value="test_mail">
            <button class="btn btn-sm" type="submit">Poslať skúšobný e-mail</button>
            <span class="hint" style="margin:0">Príde na adresu tvojho účtu.</span>
          </form>
          <?php if ($mailTest !== null && $mailTest['ok'] && $mailTest['logged']): ?>
            <div class="alert alert-info" style="margin-top:12px">
              Systém beží v testovacom režime, takže sa nič neodoslalo —
              správa je uložená v <code>storage/mail/</code>. Pred spustením
              naostro prepni <code>transport</code> v <code>api/config.php</code>
              na <code>smtp</code>.
            </div>
          <?php elseif ($mailTest !== null && $mailTest['ok']): ?>
            <div class="alert alert-ok" style="margin-top:12px">
              E-mail odoslaný. Ak nie je v schránke, pozri sa do spamu.
            </div>
          <?php elseif ($mailTest !== null): ?>
            <div class="alert alert-err" style="margin-top:12px">
              <strong>Odoslanie zlyhalo.</strong>
              <div style="margin-top:6px"><code><?= e((string) $mailTest['error']) ?></code></div>
              <?php if (str_contains((string) $mailTest['error'], '535')): ?>
                <div style="margin-top:10px">
                  Server odmietol prihlásenie do schránky. Spojenie aj port sú
                  v poriadku, nesedí meno alebo heslo v <code>api/config.php</code>:
                  <br>· <code>username</code> musí byť <strong>celá adresa</strong>
                  (napr. <code>objednavky@tvojadomena.sk</code>), nie len časť pred zavináčom,
                  <br>· <code>password</code> je heslo <strong>k schránke</strong>, nie k hostingu,
                  <br>· heslo v <code>config.php</code> daj do <strong>jednoduchých</strong> úvodzoviek —
                  v dvojitých by PHP znaky <code>$</code> a <code>\</code> premenilo na niečo iné.
                </div>
              <?php endif; ?>
            </div>
          <?php endif; ?>
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
