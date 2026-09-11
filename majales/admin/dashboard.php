<?php
declare(strict_types=1);

/** Prehľad: čo je na webe, čo treba doplniť a rýchle prepínače. */

require __DIR__ . '/_layout.php';
Auth::requireLogin();

// Rýchle prepínače priamo z prehľadu — najčastejšie zmeny počas sezóny.
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    Csrf::require();
    $toggle = (string) ($_POST['toggle'] ?? '');
    $allowed = [
        'sale_live'          => 'Predaj vstupeniek',
        'show_countdown'     => 'Odpočet v hero',
        'newsletter_enabled' => 'Odber noviniek',
        'show_aftermovie'    => 'Sekcia aftermovie',
    ];
    if (isset($allowed[$toggle])) {
        $new = Settings::bool($toggle) ? '0' : '1';
        Settings::set($toggle, $new);
        Settings::bumpContentVersion();
        AuditLog::write('settings_toggle', 'settings', $toggle, ['value' => $new]);
        flash('ok', $allowed[$toggle] . ': ' . ($new === '1' ? 'zapnuté' : 'vypnuté') . '.');
    }
    redirect('dashboard.php');
}

$e = static fn (?string $v): string => Html::e($v);

$stats = [
    ['Interpretov', Artists::count(true), 'zoznam.php?typ=interpreti'],
    ['Fotiek v galérii', count(Gallery::withPhotos()), 'zoznam.php?typ=galeria'],
    ['Typov vstupeniek', Tickets::count(true), 'zoznam.php?typ=vstupenky'],
    ['Odberateľov noviniek', Subscribers::count(Subscribers::STATUS_ACTIVE), 'odberatelia.php'],
];

// Čo ešte na webe chýba — obsluha to nemusí hľadať po stránke.
$todo = [];
if (Artists::headliner() === null) {
    $todo[] = ['Nie je označený headliner.', 'zoznam.php?typ=interpreti'];
}
$bezFotky = (int) Db::value('SELECT COUNT(*) FROM artists WHERE active = 1 AND media_id IS NULL');
if ($bezFotky > 0) {
    $todo[] = [$bezFotky . ' interpretov nemá fotku.', 'zoznam.php?typ=interpreti'];
}
if (Gallery::withPhotos() === []) {
    $todo[] = ['Galéria je prázdna — na webe sa vôbec nezobrazí.', 'zoznam.php?typ=galeria'];
}
$partnerBezLoga = (int) Db::value('SELECT COUNT(*) FROM partners WHERE active = 1 AND media_id IS NULL');
if ($partnerBezLoga > 0) {
    $todo[] = [$partnerBezLoga . ' partnerov nemá logo.', 'zoznam.php?typ=partneri'];
}
$zonaBezFotky = (int) Db::value('SELECT COUNT(*) FROM zones WHERE active = 1 AND media_id IS NULL');
if ($zonaBezFotky > 0) {
    $todo[] = [$zonaBezFotky . ' zón nemá fotku.', 'zoznam.php?typ=zony'];
}
if (Settings::bool('sale_live') && Html::safeUrl(Settings::get('tickets_url')) === '') {
    $todo[] = ['Predaj je zapnutý, ale chýba odkaz na predajný systém.', 'nastavenia.php'];
}
if (Html::safeUrl(Settings::get('social_facebook')) === '' && Html::safeUrl(Settings::get('social_instagram')) === '') {
    $todo[] = ['V pätičke nie sú odkazy na sociálne siete.', 'nastavenia.php'];
}

$health = Installer::healthChecks();

$toggles = [
    ['sale_live', 'Predaj vstupeniek beží', 'Kým je vypnutý, na kartách je nápis ČOSKORO namiesto ceny.'],
    ['show_countdown', 'Odpočet do festivalu', 'Zobrazuje sa v hero nad dátumom.'],
    ['newsletter_enabled', 'Odber noviniek', 'Formulár v pätičke stránky.'],
    ['show_aftermovie', 'Sekcia aftermovie', 'Veľká karta s tlačidlom prehrávania.'],
];

admin_head('Prehľad', 'dashboard');
?>

<div class="grid" style="margin-bottom:18px">
<?php foreach ($stats as [$label, $value, $link]): ?>
  <div class="stat">
    <b><?= (int) $value ?></b>
    <span><?= $e($label) ?></span><br>
    <a href="<?= $e($link) ?>">Otvoriť →</a>
  </div>
<?php endforeach; ?>
</div>

<?php if ($health !== []): ?>
<section class="panel">
  <h2 class="panel__title">Nastavenie servera</h2>
  <p class="panel__intro">Toto treba vyriešiť na hostingu, nie v tomto rozhraní.</p>
  <ul>
<?php foreach ($health as $h): ?>
    <li><?= $e($h) ?></li>
<?php endforeach; ?>
  </ul>
</section>
<?php endif; ?>

<section class="panel">
  <h2 class="panel__title">Rýchle prepínače</h2>
  <p class="panel__intro">Zmena je na webe okamžite.</p>
  <div class="grid">
<?php foreach ($toggles as [$key, $label, $hint]): $on = Settings::bool($key, $key !== 'sale_live'); ?>
    <form method="post" class="stat">
      <?= Csrf::field() ?>
      <input type="hidden" name="toggle" value="<?= $e($key) ?>">
      <p style="margin:0 0 6px"><strong><?= $e($label) ?></strong></p>
      <p class="small muted" style="margin:0 0 12px"><?= $e($hint) ?></p>
      <p style="margin:0 0 12px">
        <span class="tag <?= $on ? 'tag--on' : 'tag--off' ?>"><?= $on ? 'zapnuté' : 'vypnuté' ?></span>
      </p>
      <button class="btn btn--ghost btn--small" type="submit">
        <?= $on ? 'Vypnúť' : 'Zapnúť' ?>
      </button>
    </form>
<?php endforeach; ?>
  </div>
</section>

<section class="panel">
  <h2 class="panel__title">Čo ešte doplniť</h2>
<?php if ($todo === []): ?>
  <p class="muted" style="margin:0">Všetko podstatné je vyplnené. 🎉</p>
<?php else: ?>
  <ul>
<?php foreach ($todo as [$text, $link]): ?>
    <li><?= $e($text) ?> <a href="<?= $e($link) ?>">Doplniť →</a></li>
<?php endforeach; ?>
  </ul>
<?php endif; ?>
</section>

<section class="panel">
  <h2 class="panel__title">Ako to funguje</h2>
  <p class="panel__intro" style="margin-bottom:0">
    Stránka sa skladá priamo z tejto databázy. Čokoľvek tu uložíš, je na webe
    hneď po obnovení stránky — nič sa nemusí nahrávať ani prekladať.
    Texty meň v <a href="obsah.php">Textoch na stránke</a>, fotky nahrávaj
    v <a href="media.php">Knižnici fotiek</a>.
  </p>
</section>

<?php admin_foot();
