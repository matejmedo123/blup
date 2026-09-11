<?php
declare(strict_types=1);

/**
 * Vykreslenie jedného políčka formulára podľa jeho typu. Používa to
 * zoznamový editor aj stránka s nastaveniami, aby všetky polia
 * vyzerali a fungovali rovnako.
 *
 * @param array<string,string> $errors chyby po poliach
 */
function field_render(CrudField $f, mixed $value, array $errors = []): void
{
    $e   = static fn (?string $v): string => Html::e((string) $v);
    $id  = 'f-' . $f->name;
    $err = $errors[$f->name] ?? '';
    $cls = $err !== '' ? ' is-err' : '';
    $describedBy = [];
    if ($f->hint !== '') { $describedBy[] = $id . '-hint'; }
    if ($err !== '')     { $describedBy[] = $id . '-err'; }
    $aria = $describedBy === [] ? '' : ' aria-describedby="' . $e(implode(' ', $describedBy)) . '"';

    echo '<div class="field">';

    if ($f->type === 'bool') {
        echo '<div class="check">';
        echo '<input type="checkbox" id="' . $e($id) . '" name="' . $e($f->name) . '" value="1"'
            . ((int) $value === 1 ? ' checked' : '') . $aria . '>';
        echo '<label for="' . $e($id) . '">' . $e($f->label) . '</label>';
        echo '</div>';
    } elseif ($f->type === 'media') {
        echo '<span class="field__label">' . $e($f->label) . ($f->required ? ' *' : '') . '</span>';
        $thumb = Media::thumbUrl($value === null ? null : (int) $value);
        echo '<div class="mediapick">';
        if ($thumb !== '') {
            echo '<img class="mediapick__preview" src="../' . $e($thumb) . '" alt="">';
        } else {
            echo '<div class="mediapick__preview">Zatiaľ bez fotky</div>';
        }
        echo '<div class="mediapick__side">';
        echo '<input type="hidden" name="' . $e($f->name) . '" value="' . $e((string) ($value ?? '')) . '">';
        echo '<button type="button" class="btn btn--ghost btn--small" data-pick>Vybrať z knižnice</button>';
        echo '<button type="button" class="btn btn--ghost btn--small" data-pick-clear>Odobrať fotku</button>';
        echo '<p class="field__hint">Nové fotky nahráš v <a href="media.php">Knižnici fotiek</a>.</p>';
        echo '</div></div>';
    } elseif ($f->type === 'textarea') {
        echo '<label for="' . $e($id) . '">' . $e($f->label) . ($f->required ? ' *' : '') . '</label>';
        echo '<textarea class="' . ($f->max > 1500 ? 'tall' : '') . $cls . '" id="' . $e($id) . '"'
            . ' name="' . $e($f->name) . '" maxlength="' . (int) $f->max . '" data-counter'
            . ($f->required ? ' required' : '') . $aria . '>' . $e((string) $value) . '</textarea>';
    } elseif ($f->type === 'select') {
        echo '<label for="' . $e($id) . '">' . $e($f->label) . '</label>';
        echo '<select class="' . $cls . '" id="' . $e($id) . '" name="' . $e($f->name) . '"' . $aria . '>';
        foreach ($f->options as $opt) {
            echo '<option value="' . $e($opt) . '"' . ((string) $value === $opt ? ' selected' : '') . '>' . $e($opt) . '</option>';
        }
        echo '</select>';
    } else {
        $inputType = match ($f->type) {
            'url'      => 'url',
            'email'    => 'email',
            'datetime' => 'datetime-local',
            default    => 'text',
        };
        $shown = $f->type === 'price'
            ? Money::input($value === null || $value === '' ? null : (int) $value)
            : (string) $value;
        $placeholder = match ($f->type) {
            'url'      => 'https://',
            'price'    => '24,90',
            'email'    => 'meno@domena.sk',
            default    => '',
        };

        echo '<label for="' . $e($id) . '">' . $e($f->label) . ($f->required ? ' *' : '') . '</label>';
        echo '<input type="' . $e($inputType) . '" class="' . $cls . '" id="' . $e($id) . '"'
            . ' name="' . $e($f->name) . '" value="' . $e($shown) . '"'
            . ' maxlength="' . (int) $f->max . '"'
            . ($placeholder !== '' ? ' placeholder="' . $e($placeholder) . '"' : '')
            . ($f->required ? ' required' : '') . $aria . '>';
    }

    if ($f->hint !== '') {
        echo '<p class="field__hint" id="' . $e($id) . '-hint">' . $e($f->hint) . '</p>';
    }
    if ($err !== '') {
        echo '<p class="field__err" id="' . $e($id) . '-err" role="alert">' . $e($err) . '</p>';
    }
    echo '</div>';
}

/** Vyskakovacia knižnica fotiek. Vloží sa raz na stránku s formulárom. */
function media_picker_render(): void
{
    $e = static fn (?string $v): string => Html::e((string) $v);
    $items = Media::listAll(300);
    ?>
<div class="modal-back" id="media-picker" hidden>
  <div class="modal-box" role="dialog" aria-modal="true" aria-label="Knižnica fotiek">
    <div class="modal-box__head">
      <h2>Vyber fotku</h2>
      <a class="btn btn--ghost btn--small" href="media.php">Nahrať novú ↗</a>
      <button type="button" class="btn btn--ghost btn--small" data-picker-close>Zavrieť</button>
    </div>
    <div class="modal-box__body">
<?php if ($items === []): ?>
      <p class="empty">Knižnica je prázdna. Fotky nahráš v <a href="media.php">Knižnici fotiek</a>.</p>
<?php else: ?>
      <div class="mediagrid">
<?php foreach ($items as $m): ?>
        <button type="button" class="mediacard" data-id="<?= (int) $m['id'] ?>"
                data-src="../<?= $e((string) ($m['thumb_path'] ?: $m['path'])) ?>">
          <img src="../<?= $e((string) ($m['thumb_path'] ?: $m['path'])) ?>" alt="" loading="lazy">
          <span><?= $e((string) ($m['original_name'] !== '' ? $m['original_name'] : $m['path'])) ?></span>
        </button>
<?php endforeach; ?>
      </div>
<?php endif; ?>
    </div>
  </div>
</div>
    <?php
}
