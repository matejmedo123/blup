<?php
declare(strict_types=1);

/** Pridanie a úprava jednej položky ľubovoľného zoznamu. */

require __DIR__ . '/_layout.php';
require __DIR__ . '/_form.php';
Auth::requireLogin();

$spec = CrudSpec::get((string) ($_GET['typ'] ?? ''));
if ($spec === null) {
    http_response_code(404);
    exit('Neznámy zoznam.');
}

/** @var class-string<Repo> $repo */
$repo = $spec->repo;
$id   = (int) ($_GET['id'] ?? 0);
$row  = $id > 0 ? $repo::find($id) : null;

if ($id > 0 && $row === null) {
    flash('err', 'Položka sa nenašla.');
    redirect('zoznam.php?typ=' . urlencode($spec->key));
}

$errors = [];
$values = [];
foreach ($spec->fields as $f) {
    $values[$f->name] = $row[$f->name] ?? ($f->type === 'bool' ? 0 : '');
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    Csrf::require();

    [$data, $v] = $spec->readForm($_POST, $id > 0 ? $id : null);

    if (!$v->ok()) {
        $errors = $v->errors();
        // Formulár sa vráti s tým, čo používateľ napísal — nič sa nestratí.
        foreach ($spec->fields as $f) {
            $values[$f->name] = $f->type === 'price'
                ? ($v->raw($f->name) === '' ? '' : $data[$f->name])
                : ($data[$f->name] ?? '');
        }
        flash('err', 'Skontroluj označené políčka.');
    } else {
        $wasHeadliner = $spec->repo === Artists::class && (int) ($data['is_headliner'] ?? 0) === 1;

        if ($id > 0) {
            $repo::save($id, $data);
            AuditLog::write('update', $spec->key, $id, ['nazov' => $data[$spec->listColumn] ?? '']);
            flash('ok', 'Zmeny sú uložené a hneď viditeľné na webe.');
        } else {
            $id = $repo::create($data);
            AuditLog::write('create', $spec->key, $id, ['nazov' => $data[$spec->listColumn] ?? '']);
            flash('ok', 'Položka je pridaná.');
        }

        // Headlinerom môže byť len jeden — ostatných treba odznačiť.
        if ($wasHeadliner) {
            Artists::setHeadliner($id);
        }

        redirect(isset($_POST['save_and_back'])
            ? 'zoznam.php?typ=' . urlencode($spec->key)
            : 'polozka.php?typ=' . urlencode($spec->key) . '&id=' . $id);
    }
}

$e     = static fn (?string $v): string => Html::e((string) $v);
$title = $id > 0 ? $spec->titleSingle . ' — úprava' : 'Nový ' . mb_strtolower($spec->titleSingle);

admin_head($title, 'typ=' . $spec->key);
?>

<div class="actions">
  <a class="btn btn--ghost" href="zoznam.php?typ=<?= $e($spec->key) ?>">← Späť na <?= $e(mb_strtolower($spec->titlePlural)) ?></a>
</div>

<form class="form panel" method="post" novalidate>
  <?= Csrf::field() ?>

<?php foreach ($spec->fields as $f): ?>
  <?php field_render($f, $values[$f->name], $errors); ?>
<?php endforeach; ?>

  <div class="form__foot">
    <button class="btn" type="submit">Uložiť</button>
    <button class="btn btn--ghost" type="submit" name="save_and_back" value="1">Uložiť a späť na zoznam</button>
<?php if ($id > 0): ?>
    <span class="muted small">Zmeny sú na webe okamžite po uložení.</span>
<?php endif; ?>
  </div>
</form>

<?php
if ($spec->hasMedia) {
    media_picker_render();
}
admin_foot();
