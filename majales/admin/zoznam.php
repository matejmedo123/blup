<?php
declare(strict_types=1);

/**
 * Zoznam položiek jedného typu (interpreti, vstupenky, otázky, zóny,
 * galéria, partneri). Všetky sa správajú rovnako, takže ich obsluhuje
 * jedna stránka riadená popisom v `CrudSpec`.
 */

require __DIR__ . '/_layout.php';
Auth::requireLogin();

$spec = CrudSpec::get((string) ($_GET['typ'] ?? ''));
if ($spec === null) {
    http_response_code(404);
    exit('Neznámy zoznam.');
}

/** @var class-string<Repo> $repo */
$repo = $spec->repo;
$back = 'zoznam.php?typ=' . urlencode($spec->key);

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    Csrf::require();

    $action = (string) ($_POST['action'] ?? '');
    $id     = (int) ($_POST['id'] ?? 0);
    $row    = $id > 0 ? $repo::find($id) : null;

    if ($row === null) {
        flash('err', 'Položka sa nenašla.');
        redirect($back);
    }
    $name = (string) ($row[$spec->listColumn] ?? ('#' . $id));

    switch ($action) {
        case 'up':
        case 'down':
            $repo::move($id, $action);
            AuditLog::write('move', $spec->key, $id, ['smer' => $action]);
            break;

        case 'toggle':
            $now = (int) $row['active'] !== 1;
            $repo::setActive($id, $now);
            AuditLog::write('toggle', $spec->key, $id, ['active' => $now]);
            flash('ok', $name . ($now ? ' je na webe.' : ' je skrytý z webu.'));
            break;

        case 'headliner':
            Artists::setHeadliner($id);
            AuditLog::write('headliner', $spec->key, $id);
            flash('ok', $name . ' je teraz headliner.');
            break;

        case 'delete':
            $repo::remove($id);
            AuditLog::write('delete', $spec->key, $id, ['nazov' => $name]);
            flash('ok', $name . ' bol zmazaný.');
            break;

        default:
            flash('err', 'Neznáma akcia.');
    }
    redirect($back);
}

$rows  = $repo::listAll();
$last  = count($rows) - 1;
$e     = static fn (?string $v): string => Html::e((string) $v);

admin_head($spec->titlePlural, 'typ=' . $spec->key);
?>

<div class="actions">
  <a class="btn" href="polozka.php?typ=<?= $e($spec->key) ?>">+ Pridať <?= $e(mb_strtolower($spec->titleSingle)) ?></a>
  <a class="btn btn--ghost" href="../index.php" target="_blank" rel="noopener">Pozrieť na webe ↗</a>
</div>

<?php if ($spec->intro !== ''): ?>
<p class="panel__intro"><?= $e($spec->intro) ?></p>
<?php endif; ?>

<?php if ($rows === []): ?>
<p class="empty">Zatiaľ tu nič nie je. Začni tlačidlom „Pridať" vyššie.</p>
<?php else: ?>
<div class="panel">
<div class="table-wrap">
<table>
  <thead>
    <tr>
<?php if ($spec->hasMedia): ?>
      <th scope="col">Foto</th>
<?php endif; ?>
<?php foreach ($spec->listFields() as $f): ?>
      <th scope="col"><?= $e($f->label) ?></th>
<?php endforeach; ?>
      <th scope="col">Stav</th>
      <th scope="col">Poradie</th>
      <th scope="col"><span class="vh">Akcie</span></th>
    </tr>
  </thead>
  <tbody>
<?php foreach ($rows as $i => $row):
    $id     = (int) $row['id'];
    $active = (int) $row['active'] === 1;
    $name   = (string) ($row[$spec->listColumn] ?? '');
?>
    <tr>
<?php if ($spec->hasMedia):
    $thumb = Media::thumbUrl($row['media_id'] === null ? null : (int) $row['media_id']); ?>
      <td class="tight">
<?php if ($thumb !== ''): ?>
        <img class="thumb" src="../<?= $e($thumb) ?>" alt="" loading="lazy">
<?php else: ?>
        <span class="thumb thumb--empty">bez foto</span>
<?php endif; ?>
      </td>
<?php endif; ?>

<?php foreach ($spec->listFields() as $f): ?>
      <td>
<?php if ($f->type === 'bool'): ?>
        <?= (int) $row[$f->name] === 1 ? '<span class="tag tag--star">áno</span>' : '<span class="muted small">—</span>' ?>
<?php elseif ($f->type === 'price'): ?>
        <?= $row[$f->name] === null || $row[$f->name] === '' ? '<span class="muted small">neurčená</span>' : $e(Money::format((int) $row[$f->name])) ?>
<?php else: ?>
        <?= $e(mb_strimwidth((string) $row[$f->name], 0, 70, '…')) ?>
<?php endif; ?>
      </td>
<?php endforeach; ?>

      <td class="tight">
        <span class="tag <?= $active ? 'tag--on' : 'tag--off' ?>"><?= $active ? 'na webe' : 'skryté' ?></span>
      </td>

      <td class="tight">
        <div class="rowbtns">
          <form method="post">
            <?= Csrf::field() ?>
            <input type="hidden" name="id" value="<?= $id ?>">
            <input type="hidden" name="action" value="up">
            <button class="iconbtn" type="submit" <?= $i === 0 ? 'disabled' : '' ?>>
              <span aria-hidden="true">↑</span><span class="vh">Posunúť vyššie</span>
            </button>
          </form>
          <form method="post">
            <?= Csrf::field() ?>
            <input type="hidden" name="id" value="<?= $id ?>">
            <input type="hidden" name="action" value="down">
            <button class="iconbtn" type="submit" <?= $i === $last ? 'disabled' : '' ?>>
              <span aria-hidden="true">↓</span><span class="vh">Posunúť nižšie</span>
            </button>
          </form>
        </div>
      </td>

      <td class="tight">
        <div class="rowbtns">
          <a class="btn btn--ghost btn--small" href="polozka.php?typ=<?= $e($spec->key) ?>&id=<?= $id ?>">Upraviť</a>

<?php if ($spec->repo === Artists::class && (int) $row['is_headliner'] !== 1): ?>
          <form method="post">
            <?= Csrf::field() ?>
            <input type="hidden" name="id" value="<?= $id ?>">
            <input type="hidden" name="action" value="headliner">
            <button class="btn btn--ghost btn--small" type="submit">Headliner</button>
          </form>
<?php endif; ?>

          <form method="post">
            <?= Csrf::field() ?>
            <input type="hidden" name="id" value="<?= $id ?>">
            <input type="hidden" name="action" value="toggle">
            <button class="btn btn--ghost btn--small" type="submit"><?= $active ? 'Skryť' : 'Zobraziť' ?></button>
          </form>

          <form method="post" data-confirm="Naozaj zmazať „<?= $e($name) ?>"? Späť sa to vrátiť nedá.">
            <?= Csrf::field() ?>
            <input type="hidden" name="id" value="<?= $id ?>">
            <input type="hidden" name="action" value="delete">
            <button class="btn btn--danger btn--small" type="submit">Zmazať</button>
          </form>
        </div>
      </td>
    </tr>
<?php endforeach; ?>
  </tbody>
</table>
</div>
</div>
<?php endif; ?>

<?php admin_foot();
