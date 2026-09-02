<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

$user = Auth::requireLogin();

$id      = (int) ($_GET['id'] ?? 0);
$product = $id > 0 ? Db::one('SELECT * FROM products WHERE id = ?', [$id]) : null;
$isNew   = $product === null;

$categories = Db::all('SELECT * FROM categories ORDER BY position, id');
$allExtras  = Db::all('SELECT * FROM extras WHERE is_active = 1 ORDER BY position, id');

$selectedExtras = [];
if (!$isNew) {
    foreach (Db::all('SELECT extra_id FROM product_extras WHERE product_id = ?', [$id]) as $r) {
        $selectedExtras[] = (int) $r['extra_id'];
    }
}

$errors = [];

/* ---------------- Uloženie ---------------- */
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    Csrf::require();

    $name        = Validate::clean($_POST['name'] ?? '', 160);
    $slug        = Validate::clean($_POST['slug'] ?? '', 80);
    $categoryId  = (int) ($_POST['category_id'] ?? 0);
    $priceInput  = str_replace(',', '.', (string) ($_POST['price'] ?? ''));
    $description = Validate::clean($_POST['description'] ?? '', 500);
    $image       = Validate::clean($_POST['image'] ?? '', 255);
    $imageAlt    = Validate::clean($_POST['image_alt'] ?? '', 255);
    $badge       = Validate::clean($_POST['badge'] ?? '', 60);
    $tags        = Validate::clean($_POST['tags'] ?? '', 255);
    $vatGroup    = ($_POST['vat_group'] ?? 'food') === 'drinks' ? 'drinks' : 'food';
    $available   = isset($_POST['is_available']) ? 1 : 0;
    $extraIds    = array_map('intval', (array) ($_POST['extras'] ?? []));

    if ($name === '') {
        $errors['name'] = 'Zadaj názov položky.';
    }
    if ($categoryId <= 0) {
        $errors['category_id'] = 'Vyber kategóriu.';
    }
    if (!is_numeric($priceInput) || (float) $priceInput < 0) {
        $errors['price'] = 'Zadaj cenu, napr. 9,90.';
    }

    if ($slug === '') {
        $slug = preg_replace('/[^a-z0-9]+/', '-', strtolower(iconv('UTF-8', 'ASCII//TRANSLIT', $name) ?: $name)) ?? '';
        $slug = trim((string) $slug, '-');
    }
    if ($slug === '') {
        $errors['slug'] = 'Nepodarilo sa vytvoriť adresu položky — vyplň ju ručne.';
    } else {
        $clash = Db::value('SELECT id FROM products WHERE slug = ? AND id <> ?', [$slug, $id]);
        if ($clash) {
            $errors['slug'] = 'Takúto adresu už má iná položka.';
        }
    }

    if ($errors === []) {
        $now  = date('Y-m-d H:i:s');
        $data = [
            'slug'         => $slug,
            'category_id'  => $categoryId,
            'name'         => $name,
            'description'  => $description ?: null,
            'price_cents'  => Money::fromFloat((float) $priceInput),
            'image'        => $image ?: null,
            'image_alt'    => $imageAlt ?: ($name ?: null),
            'badge'        => $badge ?: null,
            'tags'         => $tags ?: null,
            'vat_group'    => $vatGroup,
            'is_available' => $available,
            'updated_at'   => $now,
        ];

        Db::transaction(static function () use ($isNew, $data, $now, $categoryId, $extraIds, &$id): void {
            if ($isNew) {
                $maxPos = (int) (Db::value('SELECT MAX(position) FROM products WHERE category_id = ?', [$categoryId]) ?? 0);
                $id = Db::insert('products', $data + ['position' => $maxPos + 1, 'created_at' => $now]);
            } else {
                Db::update('products', $data, 'id = :id', ['id' => $id]);
            }
            Db::run('DELETE FROM product_extras WHERE product_id = ?', [$id]);
            $pos = 0;
            foreach ($extraIds as $eid) {
                Db::insert('product_extras', ['product_id' => $id, 'extra_id' => $eid, 'position' => $pos++]);
            }
        });

        flash_redirect('menu.php', 'ok', $isNew ? "Položka „$name“ bola pridaná." : "Položka „$name“ bola uložená.");
    }

    // pri chybe zobrazíme, čo používateľ vyplnil
    $product = [
        'id' => $id, 'slug' => $slug, 'category_id' => $categoryId, 'name' => $name,
        'description' => $description, 'price_cents' => Money::fromFloat((float) ($priceInput ?: 0)),
        'image' => $image, 'image_alt' => $imageAlt, 'badge' => $badge, 'tags' => $tags,
        'vat_group' => $vatGroup, 'is_available' => $available,
    ];
    $selectedExtras = $extraIds;
}

$val = static fn (string $k, mixed $default = '') => $product[$k] ?? $default;
$preselectCategory = (int) ($_GET['category'] ?? $val('category_id', 0));

layout_start($isNew ? 'Nová položka' : 'Upraviť položku', 'menu', $user);
?>
<div class="page-head">
  <div>
    <p class="eyebrow">Menu</p>
    <h1><?= $isNew ? 'Nová položka' : 'Upraviť položku' ?></h1>
  </div>
  <a class="btn btn-ghost" href="menu.php">Späť na menu</a>
</div>

<?php if ($errors !== []): ?>
  <div class="alert alert-err">Skontroluj prosím zvýraznené polia.</div>
<?php endif; ?>

<form method="post">
  <?= Csrf::field() ?>
  <div class="grid grid-2">
    <div class="card">
      <h2>Základ</h2>
      <div style="margin-top:14px">
        <label class="field"><span>Názov *</span>
          <input type="text" name="name" value="<?= e($val('name')) ?>" required>
          <?php if (isset($errors['name'])): ?><div class="hint" style="color:var(--red)"><?= e($errors['name']) ?></div><?php endif; ?>
        </label>

        <label class="field"><span>Kategória *</span>
          <select name="category_id" required>
            <option value="">— vyber —</option>
            <?php foreach ($categories as $c): ?>
              <option value="<?= (int) $c['id'] ?>"<?= $preselectCategory === (int) $c['id'] ? ' selected' : '' ?>>
                <?= e($c['title']) ?>
              </option>
            <?php endforeach; ?>
          </select>
          <?php if (isset($errors['category_id'])): ?><div class="hint" style="color:var(--red)"><?= e($errors['category_id']) ?></div><?php endif; ?>
        </label>

        <div class="row row-2">
          <label class="field"><span>Cena v € *</span>
            <input type="text" name="price" inputmode="decimal"
                   value="<?= e(number_format(Money::toFloat((int) $val('price_cents', 0)), 2, ',', '')) ?>" required>
            <?php if (isset($errors['price'])): ?><div class="hint" style="color:var(--red)"><?= e($errors['price']) ?></div><?php endif; ?>
          </label>
          <label class="field"><span>Sadzba DPH</span>
            <select name="vat_group">
              <option value="food"<?= $val('vat_group') === 'food' ? ' selected' : '' ?>>Jedlo</option>
              <option value="drinks"<?= $val('vat_group') === 'drinks' ? ' selected' : '' ?>>Nápoje</option>
            </select>
            <div class="hint">Použije sa iba ak si platiteľ DPH.</div>
          </label>
        </div>

        <label class="field"><span>Popis</span>
          <textarea name="description" rows="3"><?= e($val('description')) ?></textarea>
          <div class="hint">Zloženie, ktoré uvidí zákazník na karte produktu.</div>
        </label>

        <div class="row row-2">
          <label class="field"><span>Štítok</span>
            <input type="text" name="badge" value="<?= e($val('badge')) ?>" placeholder="NOVINKA">
          </label>
          <label class="field"><span>Značky (oddeľ zvislou čiarou)</span>
            <input type="text" name="tags" value="<?= e($val('tags')) ?>" placeholder="Signature|Hot 🌶">
          </label>
        </div>

        <label class="checkline">
          <input type="checkbox" name="is_available" value="1"<?= (int) $val('is_available', 1) === 1 ? ' checked' : '' ?>>
          <span>V ponuke (odškrtni pri vypredaní)</span>
        </label>
      </div>
    </div>

    <div>
      <div class="card">
        <h2>Fotka</h2>
        <div style="margin-top:14px">
          <?php if (!empty($val('image'))): ?>
            <img src="../<?= e(ltrim((string) $val('image'), '/')) ?>" alt=""
                 style="width:100%;max-width:320px;border-radius:10px;margin-bottom:12px">
          <?php endif; ?>
          <label class="field"><span>Cesta k obrázku</span>
            <input type="text" name="image" value="<?= e($val('image')) ?>"
                   placeholder="/images/products/nazov.webp">
            <div class="hint">
              Fotku nahraj cez správcu súborov do <code>images/products/</code>
              a sem napíš cestu. Ideálne 1200 px široká, formát WebP alebo JPG.
            </div>
          </label>
          <label class="field"><span>Popis fotky (pre čítačky a SEO)</span>
            <input type="text" name="image_alt" value="<?= e($val('image_alt')) ?>">
          </label>
          <label class="field"><span>Adresa položky (slug)</span>
            <input type="text" name="slug" value="<?= e($val('slug')) ?>" placeholder="vygeneruje sa z názvu">
            <?php if (isset($errors['slug'])): ?><div class="hint" style="color:var(--red)"><?= e($errors['slug']) ?></div><?php endif; ?>
            <div class="hint">Nemeň pri existujúcej položke — používa sa v starých objednávkach.</div>
          </label>
        </div>
      </div>

      <div class="card">
        <h2>Doplnky ponúkané k položke</h2>
        <div style="margin-top:12px;max-height:320px;overflow:auto">
          <?php foreach ($allExtras as $ex): ?>
            <label class="checkline">
              <input type="checkbox" name="extras[]" value="<?= (int) $ex['id'] ?>"
                     <?= in_array((int) $ex['id'], $selectedExtras, true) ? ' checked' : '' ?>>
              <span><?= e($ex['name']) ?>
                <span class="hint">+<?= e(Money::format((int) $ex['price_cents'])) ?></span>
              </span>
            </label>
          <?php endforeach; ?>
          <?php if ($allExtras === []): ?>
            <p class="hint">Zatiaľ nemáš žiadne doplnky. <a href="extras.php">Pridaj ich tu.</a></p>
          <?php endif; ?>
        </div>
      </div>
    </div>
  </div>

  <div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap">
    <button class="btn btn-lg" type="submit"><?= $isNew ? 'Pridať položku' : 'Uložiť zmeny' ?></button>
    <a class="btn btn-lg btn-ghost" href="menu.php">Zrušiť</a>
    <?php if (!$isNew): ?>
      <form method="post" action="menu.php" style="margin-left:auto"
            onsubmit="return confirm('Naozaj zmazať túto položku? Objednávky ostanú nedotknuté.')">
        <?= Csrf::field() ?>
        <input type="hidden" name="action" value="delete">
        <input type="hidden" name="product_id" value="<?= (int) $id ?>">
        <button class="btn btn-lg btn-danger" type="submit">Zmazať</button>
      </form>
    <?php endif; ?>
  </div>
</form>

<?php layout_end(); ?>
