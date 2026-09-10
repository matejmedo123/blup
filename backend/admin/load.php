<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

/**
 * Automatické predlžovanie časov podľa vyťaženia.
 *
 * Keď je kuchyňa zavalená, web nemá zákazníkovi sľubovať tých istých
 * 20 minút ako o tretej poobede. Tu sa nastaví, koľko objednávok naraz
 * prevádzka zvládne a o koľko sa čas predĺži, keď ich je viac.
 */

$user = Auth::requireRole(Auth::ROLE_ADMIN);

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    Csrf::require();

    $before = [
        'auto_prep_enabled'  => (string) Settings::get('auto_prep_enabled'),
        'auto_prep_capacity' => (string) Settings::get('auto_prep_capacity'),
        'auto_prep_step'     => (string) Settings::get('auto_prep_step'),
        'auto_prep_max'      => (string) Settings::get('auto_prep_max'),
    ];

    $after = [
        'auto_prep_enabled'  => isset($_POST['enabled']) ? '1' : '0',
        'auto_prep_capacity' => (string) max(1, min(100, (int) ($_POST['capacity'] ?? 5))),
        'auto_prep_step'     => (string) max(1, min(60, (int) ($_POST['step'] ?? 5))),
        'auto_prep_max'      => (string) max(0, min(180, (int) ($_POST['max'] ?? 30))),
    ];

    foreach ($after as $key => $value) {
        Settings::set($key, $value);
        AuditLog::change($user, 'settings', $key, $before[$key], $value);
    }

    Workload::forget();
    flash_redirect('load.php', 'ok', 'Nastavenie automatických časov je uložené.');
}

$load = Workload::snapshot();

/** Ukážka, čo súčasné nastavenie spraví pri rôznom počte objednávok. */
$capacity = (int) $load['capacity'];
$step     = max(1, Settings::int('auto_prep_step'));
$max      = max(0, Settings::int('auto_prep_max'));
$preview  = [];
foreach ([0, $capacity, $capacity + 1, $capacity * 2, $capacity * 3, $capacity * 5] as $count) {
    $extra = $count > $capacity
        ? min($max, (int) ceil(($count - $capacity) / $capacity) * $step)
        : 0;
    $preview[$count] = $extra;
}

$pickup   = (string) Settings::get('prep_time_pickup');
$delivery = (string) Settings::get('prep_time_delivery');

layout_start('Automatické časy', 'settings', $user);
flash_render();
?>
<div class="page-head">
  <div><p class="eyebrow">Objednávky</p><h1>Automatické časy</h1></div>
  <a class="btn btn-ghost" href="settings.php">Späť na nastavenia</a>
</div>

<div class="alert alert-info">
  Systém sleduje, koľko objednávok má kuchyňa rozrobených — teda prijaté,
  potvrdené a tie na platni. Hotové jedlo, ktoré čaká na kuriéra, sa
  nepočíta. Keď je ich viac, než zvládaš naraz, k časom na webe pripočíta
  minúty. <strong>Už prijatých objednávok sa to nedotkne</strong> — ich
  čas ostáva ten, ktorý si odklikol.
</div>

<div class="grid grid-2">
  <div class="card">
    <h2>Teraz</h2>
    <div class="stats" style="grid-template-columns:1fr 1fr;margin-top:14px">
      <div class="stat">
        <span class="stat-label">V kuchyni</span>
        <span class="stat-value"><?= (int) $load['inFlight'] ?></span>
        <span class="hint">objednávok z <?= (int) $load['capacity'] ?> zvládnuteľných</span>
      </div>
      <div class="stat">
        <span class="stat-label">Web pripočítava</span>
        <span class="stat-value">+<?= (int) $load['extraMinutes'] ?> min</span>
        <span class="hint"><?= $load['enabled'] ? 'automatika je zapnutá' : 'automatika je vypnutá' ?></span>
      </div>
    </div>

    <div class="table-wrap" style="margin-top:16px">
      <table class="data">
        <tr>
          <th>Osobný odber</th>
          <td><?= e(Workload::stretchText($pickup, (int) $load['extraMinutes'])) ?>
            <?php if ($load['extraMinutes'] > 0): ?>
              <span class="hint">namiesto <?= e($pickup) ?></span>
            <?php endif; ?>
          </td>
        </tr>
        <tr>
          <th>Rozvoz</th>
          <td><?= e(Workload::stretchText($delivery, (int) $load['extraMinutes'])) ?>
            <?php if ($load['extraMinutes'] > 0): ?>
              <span class="hint">namiesto <?= e($delivery) ?></span>
            <?php endif; ?>
          </td>
        </tr>
        <tr>
          <th>Návrh na nástenke</th>
          <td><?= Workload::suggestedMinutes() ?> minút</td>
        </tr>
      </table>
    </div>
  </div>

  <div class="card">
    <h2>Nastavenie</h2>
    <form method="post" style="margin-top:14px">
      <?= Csrf::field() ?>
      <label class="checkline">
        <input type="checkbox" name="enabled" value="1"<?= $load['enabled'] ? ' checked' : '' ?>>
        <span>Predlžovať časy automaticky</span>
      </label>
      <p class="hint" style="margin:0 0 16px">
        Keď je vypnuté, na webe svietia stále tie isté časy z nastavení.
      </p>

      <label class="field">
        <span>Koľko objednávok zvládneme naraz</span>
        <input type="number" name="capacity" min="1" max="100"
               value="<?= (int) Settings::int('auto_prep_capacity') ?>">
        <span class="hint">Do tohto počtu sa časy nepredlžujú vôbec.</span>
      </label>

      <label class="field">
        <span>Za každú ďalšiu dávku pridaj (min)</span>
        <input type="number" name="step" min="1" max="60"
               value="<?= (int) Settings::int('auto_prep_step') ?>">
        <span class="hint">Dávka je toľko objednávok, koľko zvládneš naraz.</span>
      </label>

      <label class="field">
        <span>Najviac pridaj (min)</span>
        <input type="number" name="max" min="0" max="180"
               value="<?= (int) Settings::int('auto_prep_max') ?>">
        <span class="hint">Strop, aby web nesľuboval nezmyselné čakanie.</span>
      </label>

      <button class="btn btn-lg btn-block" type="submit">Uložiť</button>
    </form>
  </div>
</div>

<div class="card" style="margin-top:16px">
  <h2>Čo to spraví</h2>
  <p class="hint" style="margin-top:6px">Podľa toho, čo je uložené teraz.</p>
  <div class="table-wrap" style="margin-top:12px">
    <table class="data">
      <thead>
        <tr>
          <th class="num">Objednávok v kuchyni</th>
          <th class="num">Pripočíta</th>
          <th>Osobný odber</th>
          <th>Rozvoz</th>
        </tr>
      </thead>
      <tbody>
        <?php foreach ($preview as $count => $extra): ?>
          <tr>
            <td class="num"><?= (int) $count ?></td>
            <td class="num"><?= $extra ? '+' . $extra . ' min' : '—' ?></td>
            <td><?= e(Workload::stretchText($pickup, $extra)) ?></td>
            <td><?= e(Workload::stretchText($delivery, $extra)) ?></td>
          </tr>
        <?php endforeach; ?>
      </tbody>
    </table>
  </div>
</div>
<?php layout_end(); ?>
