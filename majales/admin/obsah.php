<?php
declare(strict_types=1);

/**
 * Texty na stránke. Sú rozdelené podľa sekcií webu, aby sa dali nájsť
 * podľa toho, kde na stránke stoja.
 */

require __DIR__ . '/_layout.php';
require __DIR__ . '/_form.php';
Auth::requireLogin();

$sections = Blocks::bySection();

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    Csrf::require();

    $values  = [];
    $changed = [];
    $v = new Validate($_POST);

    foreach (Blocks::listAll() as $block) {
        $key = (string) $block['skey'];
        if (!array_key_exists($key, $_POST)) {
            continue;
        }
        $new = $block['kind'] === 'richtext'
            ? $v->multiline($key, (string) $block['label'], false, 8000)
            : $v->text($key, (string) $block['label'], false, 1000);

        if ($new !== (string) ($block['value'] ?? '')) {
            $values[$key] = $new;
            $changed[] = (string) $block['label'];
        }
    }

    if (!$v->ok()) {
        flash('err', $v->firstError());
    } elseif ($values === []) {
        flash('ok', 'Nič sa nezmenilo.');
    } else {
        Blocks::setMany($values);
        AuditLog::write('update', 'blocks', '', ['zmenene' => $changed]);
        flash('ok', 'Uložené: ' . count($values) . ' ' . (count($values) === 1 ? 'text' : 'textov') . '. Na webe sú hneď.');
    }
    redirect('obsah.php');
}

$e = static fn (?string $v): string => Html::e((string) $v);

admin_head('Texty na stránke', 'obsah');
?>

<p class="panel__intro">
  Každý text tu zodpovedá jednému miestu na webe. Zmeny sú viditeľné hneď
  po uložení — stránku netreba nikam nahrávať.
</p>

<form class="form form--wide" method="post" novalidate>
  <?= Csrf::field() ?>

<?php foreach ($sections as $section => $blocks): ?>
  <section class="panel blocks-section">
    <h2><?= $e($section !== '' ? $section : 'Ostatné') ?></h2>
<?php foreach ($blocks as $block):
    $field = new CrudField(
        name: (string) $block['skey'],
        label: (string) $block['label'],
        type: $block['kind'] === 'richtext' ? 'textarea' : 'text',
        hint: (string) $block['hint'],
        max: $block['kind'] === 'richtext' ? 8000 : 1000,
    );
    field_render($field, (string) ($block['value'] ?? ''));
endforeach; ?>
  </section>
<?php endforeach; ?>

  <div class="form__foot" style="position:sticky;bottom:0;background:var(--bg);padding:14px 0">
    <button class="btn" type="submit">Uložiť všetky texty</button>
    <a class="btn btn--ghost" href="../index.php" target="_blank" rel="noopener">Pozrieť web ↗</a>
  </div>
</form>

<?php admin_foot();
