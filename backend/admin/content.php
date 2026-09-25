<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

/**
 * Ilustračné fotky a texty na webe.
 *
 * Sú to miesta, ktoré nepatria ku konkrétnej položke menu — veľká fotka
 * navrchu, tri dlaždice a fotky pri sekcii o značke. Prevádzka si ich
 * má vedieť vymeniť sama, bez toho, aby sa čokoľvek nasadzovalo.
 */

$user = Auth::requireRole(Auth::ROLE_ADMIN);

/** Bloky, ktoré sa dajú meniť. [kľúč fotky, kľúč nadpisu, kľúč textu] */
$BLOCKS = [
    'Veľká fotka navrchu stránky' => [
        'image' => 'content_hero_image',
        'alt'   => 'content_hero_alt',
    ],
    'Dlaždica 1' => [
        'image' => 'content_promo1_image',
        'title' => 'content_promo1_title',
        'text'  => 'content_promo1_text',
    ],
    'Dlaždica 2' => [
        'image' => 'content_promo2_image',
        'title' => 'content_promo2_title',
        'text'  => 'content_promo2_text',
    ],
    'Dlaždica 3' => [
        'image' => 'content_promo3_image',
        'title' => 'content_promo3_title',
        'text'  => 'content_promo3_text',
    ],
    'Fotka pri značke — vľavo' => ['image' => 'content_story1_image'],
    'Fotka pri značke — vpravo' => ['image' => 'content_story2_image'],
];

$errors = [];

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    Csrf::require();

    foreach ($BLOCKS as $label => $keys) {
        // Text a nadpis
        foreach (['alt', 'title', 'text'] as $field) {
            if (!isset($keys[$field]) || !array_key_exists($keys[$field], $_POST)) {
                continue;
            }
            Settings::set($keys[$field], Validate::clean((string) $_POST[$keys[$field]], 255));
        }

        // Fotka: buď nahratá z počítača, alebo ručne zadaná cesta
        $key   = $keys['image'];
        $field = 'file_' . $key;
        if (($_FILES[$field]['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_NO_FILE) {
            $res = ImageUpload::store($_FILES[$field], $key, 'editorial');
            if ($res['ok']) {
                $old = (string) Settings::get($key);
                Settings::set($key, (string) $res['path']);
                if ($old !== '' && $old !== $res['path']) {
                    ImageUpload::discard($old);
                }
            } else {
                $errors[$key] = (string) $res['error'];
            }
        } elseif (array_key_exists($key, $_POST)) {
            Settings::set($key, Validate::clean((string) $_POST[$key], 255));
        }
    }

    Settings::set('content_story_badge', Validate::clean((string) ($_POST['content_story_badge'] ?? ''), 255));

    if ($errors === []) {
        AuditLog::record($user, 'update', 'content', null, 'Fotky a texty na webe upravené');
        flash_redirect('content.php', 'ok', 'Uložené. Na webe sa to prejaví do pár sekúnd.');
    }
}

layout_start('Fotky a texty na webe', 'settings', $user);
flash_render();
?>
<div class="page-head">
  <div><p class="eyebrow">Web</p><h1>Fotky a texty na webe</h1></div>
  <a class="btn btn-ghost" href="settings.php">Späť na nastavenia</a>
</div>

<div class="alert alert-info">
  Toto sú ilustračné miesta, ktoré nepatria ku konkrétnej položke menu.
  Fotky položiek sa menia priamo pri položke v <a href="menu.php">Menu</a>.
  Keď pole necháš prázdne, ostane to, čo je na webe teraz.
</div>

<form method="post" enctype="multipart/form-data">
  <?= Csrf::field() ?>

  <div class="grid grid-2">
    <?php foreach ($BLOCKS as $label => $keys): ?>
      <?php $img = (string) Settings::get($keys['image']); ?>
      <div class="card">
        <h2><?= e($label) ?></h2>

        <?php if ($img !== ''): ?>
          <img src="../<?= e(ltrim($img, '/')) ?>" alt=""
               style="width:100%;max-width:280px;border-radius:10px;margin:14px 0 6px">
        <?php endif; ?>

        <label class="field"><span>Nahrať fotku z počítača</span>
          <input type="file" name="file_<?= e($keys['image']) ?>" accept="image/jpeg,image/png,image/webp">
          <?php if (isset($errors[$keys['image']])): ?>
            <div class="hint" style="color:var(--red)"><?= e($errors[$keys['image']]) ?></div>
          <?php endif; ?>
          <div class="hint">JPG, PNG alebo WebP do 8&nbsp;MB. Systém ju sám zmenší.</div>
        </label>

        <label class="field"><span>Alebo cesta k fotke</span>
          <input type="text" name="<?= e($keys['image']) ?>" value="<?= e($img) ?>">
        </label>

        <?php if (isset($keys['alt'])): ?>
          <label class="field"><span>Popis fotky (pre čítačky a SEO)</span>
            <input type="text" name="<?= e($keys['alt']) ?>" value="<?= e((string) Settings::get($keys['alt'])) ?>">
          </label>
        <?php endif; ?>

        <?php if (isset($keys['title'])): ?>
          <label class="field"><span>Nadpis</span>
            <input type="text" name="<?= e($keys['title']) ?>" value="<?= e((string) Settings::get($keys['title'])) ?>">
          </label>
          <label class="field"><span>Text</span>
            <textarea name="<?= e($keys['text']) ?>" rows="3"><?= e((string) Settings::get($keys['text'])) ?></textarea>
          </label>
        <?php endif; ?>
      </div>
    <?php endforeach; ?>
  </div>

  <div class="card" style="margin-top:16px">
    <h2>Pásik pri fotkách o značke</h2>
    <label class="field" style="margin-top:14px"><span>Text v zlatom rámčeku</span>
      <input type="text" name="content_story_badge" value="<?= e((string) Settings::get('content_story_badge')) ?>">
    </label>
  </div>

  <button class="btn btn-lg" type="submit" style="margin-top:18px">Uložiť</button>
</form>
<?php layout_end(); ?>
