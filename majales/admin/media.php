<?php
declare(strict_types=1);

/**
 * Knižnica fotiek. Nahraté obrázky sa prekreslia, zmenšia a uložia
 * ako WEBP — z pôvodného súboru neostane nič okrem obrazu.
 */

require __DIR__ . '/_layout.php';
Auth::requireLogin();

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    Csrf::require();
    $action = (string) ($_POST['action'] ?? 'upload');

    if ($action === 'delete') {
        $id = (int) ($_POST['id'] ?? 0);
        $m  = Media::find($id);
        if ($m === null) {
            flash('err', 'Fotka sa nenašla.');
        } else {
            Media::remove($id);
            AuditLog::write('delete', 'media', $id, ['subor' => $m['path']]);
            flash('ok', 'Fotka bola zmazaná. Tam, kde bola použitá, je teraz prázdne miesto.');
        }
        redirect('media.php');
    }

    if ($action === 'alt') {
        $id = (int) ($_POST['id'] ?? 0);
        $v  = new Validate($_POST);
        Media::setAlt($id, $v->text('alt', 'Popis fotky', false, 255));
        AuditLog::write('update', 'media', $id);
        flash('ok', 'Popis fotky je uložený.');
        redirect('media.php');
    }

    // Naraz sa dá nahrať viac súborov — obsluha ich väčšinou má v jednom priečinku.
    $files = $_FILES['photos'] ?? null;
    $ok = 0;
    $problems = [];

    if (is_array($files) && isset($files['name']) && is_array($files['name'])) {
        foreach (array_keys($files['name']) as $i) {
            $one = [
                'name'     => $files['name'][$i],
                'type'     => $files['type'][$i],
                'tmp_name' => $files['tmp_name'][$i],
                'error'    => $files['error'][$i],
                'size'     => $files['size'][$i],
            ];
            if ((int) $one['error'] === UPLOAD_ERR_NO_FILE) {
                continue;
            }
            try {
                $newId = Media::store($one);
                AuditLog::write('create', 'media', $newId, ['subor' => $one['name']]);
                $ok++;
            } catch (Throwable $ex) {
                $problems[] = (string) $one['name'] . ': ' . $ex->getMessage();
            }
        }
    }

    if ($ok > 0) {
        flash('ok', 'Nahraté: ' . $ok . ' ' . ($ok === 1 ? 'fotka' : 'fotiek') . '.');
    }
    foreach ($problems as $p) {
        flash('err', $p);
    }
    if ($ok === 0 && $problems === []) {
        flash('err', 'Nevybral si žiadny súbor.');
    }
    redirect('media.php');
}

$items  = Media::listAll(500);
$unused = Media::unusedCount();
$e      = static fn (?string $v): string => Html::e((string) $v);

$maxMb = round(((int) Config::get('uploads.max_bytes', 12582912)) / 1048576);

admin_head('Knižnica fotiek', 'media');
?>

<section class="panel">
  <h2 class="panel__title">Nahrať fotky</h2>
  <p class="panel__intro">
    JPG, PNG, WEBP alebo GIF, najviac <?= (int) $maxMb ?> MB na súbor.
    Veľké fotky sa automaticky zmenšia na <?= (int) Config::get('uploads.max_width', 2000) ?> px
    a prevedú na formát WEBP, aby sa web načítaval rýchlo.
    Naraz môžeš vybrať aj viac súborov.
  </p>
  <form class="form" method="post" enctype="multipart/form-data">
    <?= Csrf::field() ?>
    <input type="hidden" name="action" value="upload">
    <div class="field">
      <label for="photos">Vyber súbory</label>
      <input type="file" id="photos" name="photos[]" accept="image/jpeg,image/png,image/webp,image/gif" multiple required>
    </div>
    <div class="form__foot">
      <button class="btn" type="submit">Nahrať</button>
    </div>
  </form>
</section>

<p class="panel__intro">
  V knižnici je <?= count($items) ?> fotiek<?= $unused > 0 ? ', z toho ' . $unused . ' nie je nikde použitých' : '' ?>.
</p>

<?php if ($items === []): ?>
<p class="empty">Knižnica je zatiaľ prázdna.</p>
<?php else: ?>
<div class="panel">
<div class="table-wrap">
<table>
  <thead>
    <tr>
      <th scope="col">Náhľad</th>
      <th scope="col">Súbor</th>
      <th scope="col">Popis pre čítačky obrazovky</th>
      <th scope="col">Rozmer</th>
      <th scope="col"><span class="vh">Akcie</span></th>
    </tr>
  </thead>
  <tbody>
<?php foreach ($items as $m): $id = (int) $m['id']; ?>
    <tr>
      <td class="tight">
        <a href="../<?= $e((string) $m['path']) ?>" target="_blank" rel="noopener">
          <img class="thumb" src="../<?= $e((string) ($m['thumb_path'] ?: $m['path'])) ?>" alt="" loading="lazy">
        </a>
      </td>
      <td class="small"><?= $e(mb_strimwidth((string) ($m['original_name'] !== '' ? $m['original_name'] : $m['path']), 0, 40, '…')) ?></td>
      <td>
        <form method="post" style="display:flex;gap:8px;align-items:center">
          <?= Csrf::field() ?>
          <input type="hidden" name="action" value="alt">
          <input type="hidden" name="id" value="<?= $id ?>">
          <label class="vh" for="alt-<?= $id ?>">Popis fotky</label>
          <input type="text" id="alt-<?= $id ?>" name="alt" value="<?= $e((string) $m['alt']) ?>"
                 maxlength="255" placeholder="Čo je na fotke">
          <button class="btn btn--ghost btn--small nowrap" type="submit">Uložiť</button>
        </form>
      </td>
      <td class="small muted nowrap"><?= (int) $m['width'] ?>×<?= (int) $m['height'] ?> px<br><?= $e(number_format((int) $m['size_bytes'] / 1024, 0, ',', ' ')) ?> kB</td>
      <td class="tight">
        <form method="post" data-confirm="Naozaj zmazať túto fotku? Zmizne aj z miest, kde je použitá.">
          <?= Csrf::field() ?>
          <input type="hidden" name="action" value="delete">
          <input type="hidden" name="id" value="<?= $id ?>">
          <button class="btn btn--danger btn--small" type="submit">Zmazať</button>
        </form>
      </td>
    </tr>
<?php endforeach; ?>
  </tbody>
</table>
</div>
</div>
<?php endif; ?>

<?php admin_foot();
