<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

/**
 * Kontrola nasadenia.
 *
 * Dve veci, ktoré sa pri prenose súborov na hosting pokazia ticho:
 *
 * 1. Fotka. Web berie cestu z databázy, súbor leží v priečinku `images/`.
 *    Keď sa priečinok nahrá len z časti, databáza o tom nevie a v karte
 *    burgra svieti otáznik. Väčšinu sa dá opraviť klikom.
 * 2. Súbor systému. Keď prenos preskočí jeden PHP súbor, stránka beží
 *    ďalej, len sa časť systému správa podľa pravidiel, ktoré sme dávno
 *    zmenili. Preto porovnávame odtlačky súborov s tým, čo bolo v balíku.
 * 3. Databáza. Nové súbory vedia o tabuľkách, ktoré v databáze ešte nie sú,
 *    kým sa nedobehnú migrácie. Tu sa to dá dobehnúť jedným klikom.
 */

$user = Auth::requireRole(Auth::ROLE_ADMIN);

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    Csrf::require();
    if ((string) ($_POST['action'] ?? '') === 'migrate') {
        $before = Migrations::currentVersion();
        Migrations::run();
        $after = Migrations::currentVersion();
        AuditLog::record($user, 'update', 'database', null, "Databáza dobehnutá z {$before} na {$after}");
        flash_redirect(
            'kontrola.php',
            'ok',
            $before === $after
                ? 'Databáza už bola aktuálna.'
                : "Databáza dobehnutá na verziu {$after}.",
        );
    }

    if ((string) ($_POST['action'] ?? '') === 'repair') {
        $fixed = AssetAudit::repair();
        AuditLog::record($user, 'update', 'assets', null, "Opravené cesty na fotky: {$fixed}");
        flash_redirect(
            'fotky.php',
            'ok',
            $fixed > 0
                ? "Opravených ciest: {$fixed}."
                : 'Nebolo čo opraviť — pre chýbajúce fotky sa náhrada nenašla.',
        );
    }
}

Assets::forget();
$rows = AssetAudit::report();

$counts = ['ok' => 0, 'alternative' => 0, 'missing' => 0, 'unknown' => 0];
foreach ($rows as $row) {
    $counts[$row['state']]++;
}

// Odznaky stavov si berieme z existujúcej palety adminu, aby sa farby
// naprieč stránkami nerozchádzali: zelená v poriadku, zlatá pozor,
// červená chyba, sivá neviem.
$LABEL = [
    'ok'          => ['Fotka je na mieste', 'badge-ready'],
    'alternative' => ['Súbor chýba — náhrada sa našla', 'badge-received'],
    'missing'     => ['Súbor na serveri nie je', 'badge-cancelled'],
    'unknown'     => ['Nedá sa overiť', 'badge-completed'],
];

$deploy  = Deployment::check();
$pending = Migrations::pending();

layout_start('Kontrola', 'menu', $user);
flash_render();
?>
<div class="page-head">
  <div><p class="eyebrow">Web</p><h1>Kontrola</h1></div>
  <a class="btn btn-ghost" href="menu.php">Späť na menu</a>
</div>

<?php /* ---------- Databáza ---------- */ ?>
<div class="card" style="margin-bottom:16px">
  <h2>Databáza</h2>
  <?php if ($pending === []): ?>
    <p style="margin-top:10px">
      Databáza je na verzii <strong><?= e(Migrations::currentVersion()) ?></strong>
      a nič nečaká na dobehnutie.
    </p>
  <?php else: ?>
    <div class="alert alert-err" style="margin-top:12px">
      <strong>Databáza zaostáva za súbormi.</strong>
      Nedobehnutých úprav: <?= count($pending) ?>
      (<?= e(implode(', ', $pending)) ?>). Kým sa nedobehnú, časť systému
      pracuje s tým, čo v databáze ešte nie je.
    </div>
    <form method="post">
      <?= Csrf::field() ?>
      <input type="hidden" name="action" value="migrate">
      <button class="btn btn-lg" type="submit">Dobehnúť databázu</button>
    </form>
  <?php endif; ?>
</div>

<?php /* ---------- Súbory systému ---------- */ ?>
<div class="card" style="margin-bottom:16px">
  <h2>Súbory na serveri</h2>
  <?php if (!$deploy['available']): ?>
    <p class="hint" style="margin-top:10px">
      Zoznam odtlačkov na serveri nie je — buď ide o starší balík, alebo sa
      súbor <code>api/lib/manifest.json</code> nenahral. Po nasadení
      najnovšieho ZIP-u tu bude vidieť, či prenos prešiel celý.
    </p>
  <?php elseif ($deploy['ok']): ?>
    <p style="margin-top:10px">
      Všetkých <?= (int) $deploy['total'] ?> súborov z balíka je na serveri
      a v nezmenenej podobe. Prenos prešiel celý.
    </p>
    <p class="hint">Balík zo dňa <?= e((string) $deploy['generated']) ?>.</p>
  <?php else: ?>
    <div class="alert alert-err" style="margin-top:12px">
      <strong>Prenos na hosting neprešiel celý.</strong>
      Systém potom beží z polovice starý a chyby sa hľadajú veľmi ťažko.
      Nahraj priečinky <code>api/</code>, <code>admin/</code> a
      <code>images/</code> z posledného ZIP-u ešte raz, s prepísaním
      existujúcich súborov.
    </div>
    <?php foreach ([['Chýbajú na serveri', $deploy['missing']], ['Sú staršie než balík', $deploy['stale']]] as [$title, $list]): ?>
      <?php if ($list !== []): ?>
        <p style="margin-top:12px"><strong><?= e($title) ?></strong> (<?= count($list) ?>)</p>
        <ul class="hint" style="margin:6px 0 0 18px">
          <?php foreach (array_slice($list, 0, 40) as $path): ?>
            <li><code><?= e($path) ?></code></li>
          <?php endforeach; ?>
          <?php if (count($list) > 40): ?>
            <li>… a ďalších <?= count($list) - 40 ?></li>
          <?php endif; ?>
        </ul>
      <?php endif; ?>
    <?php endforeach; ?>
  <?php endif; ?>
</div>

<h2 style="margin-bottom:12px">Fotky</h2>

<?php if ($counts['missing'] === 0 && $counts['alternative'] === 0 && $counts['unknown'] === 0): ?>
  <div class="alert alert-ok">
    Všetky fotky (<?= count($rows) ?>) sú na serveri na svojom mieste. Nič netreba riešiť.
  </div>
<?php else: ?>
  <div class="alert alert-info">
    Web berie cesty na fotky z databázy, súbory ležia v priečinku
    <code>images/</code> na hostingu. Keď sa nahrá len časť priečinka,
    v karte svieti otáznik. Zákazník namiesto rozbitého obrázka vidí
    pokojnú plochu so značkou, ale fotka mu chýba.
    <?php if ($counts['alternative'] > 0): ?>
      <strong>Pri <?= e(sk_count($counts['alternative'], 'fotke', 'fotkách', 'fotkách')) ?>
      sme našli náhradu</strong> — tú vieme zapísať jedným klikom.
    <?php endif; ?>
    <?php if ($counts['missing'] > 0): ?>
      Pri <?= e(sk_count($counts['missing'], 'fotke', 'fotkách', 'fotkách')) ?>
      náhrada neexistuje; treba ju nahrať z počítača nanovo.
    <?php endif; ?>
  </div>
<?php endif; ?>

<?php if ($counts['alternative'] > 0): ?>
  <form method="post" style="margin-bottom:16px">
    <?= Csrf::field() ?>
    <input type="hidden" name="action" value="repair">
    <button class="btn btn-lg" type="submit">
      Opraviť cesty (<?= (int) $counts['alternative'] ?>)
    </button>
  </form>
<?php endif; ?>

<div class="card">
  <div class="table-wrap">
  <table class="data">
    <thead>
      <tr><th>Kde</th><th>Cesta v databáze</th><th>Stav</th><th></th></tr>
    </thead>
    <tbody>
      <?php foreach ($rows as $row): ?>
        <?php [$text, $badge] = $LABEL[$row['state']]; ?>
        <tr>
          <td><a href="<?= e($row['where']) ?>"><?= e($row['label']) ?></a></td>
          <td><code style="font-size:0.78rem"><?= e($row['path']) ?></code></td>
          <td>
            <span class="badge <?= $badge ?>"><?= e($text) ?></span>
            <?php if ($row['suggestion'] !== null): ?>
              <div class="hint">namiesto nej <code><?= e($row['suggestion']) ?></code></div>
            <?php endif; ?>
          </td>
          <td style="text-align:right">
            <?php if ($row['state'] === 'missing'): ?>
              <a class="btn btn-sm" href="<?= e($row['where']) ?>">Nahrať fotku</a>
            <?php endif; ?>
          </td>
        </tr>
      <?php endforeach; ?>
    </tbody>
  </table>
  </div>
</div>
<?php
layout_end();
