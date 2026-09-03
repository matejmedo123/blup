<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

$user = Auth::requireRole(Auth::ROLE_ADMIN);

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    Csrf::require();
    $action = (string) ($_POST['action'] ?? '');

    if ($action === 'save') {
        $eid   = (int) ($_POST['id'] ?? 0);
        $name  = Validate::clean($_POST['name'] ?? '', 120);
        $price = str_replace(',', '.', (string) ($_POST['price'] ?? '0'));
        if ($name === '') {
            flash_redirect('extras.php', 'error', 'Zadaj názov doplnku.');
        }
        $slug = Validate::clean($_POST['slug'] ?? '', 64);
        if ($slug === '') {
            $slug = trim((string) preg_replace('/[^a-z0-9]+/', '-', strtolower(iconv('UTF-8', 'ASCII//TRANSLIT', $name) ?: $name)), '-');
        }
        if ($eid > 0) {
            Db::update('extras', [
                'name' => $name, 'price_cents' => Money::fromFloat((float) $price),
            ], 'id = :id', ['id' => $eid]);
            flash_redirect('extras.php', 'ok', 'Doplnok bol uložený.');
        }
        if (Db::value('SELECT 1 FROM extras WHERE slug = ?', [$slug])) {
            flash_redirect('extras.php', 'error', 'Doplnok s takouto adresou už existuje.');
        }
        $max = (int) (Db::value('SELECT MAX(position) FROM extras') ?? 0);
        Db::insert('extras', [
            'slug' => $slug, 'name' => $name,
            'price_cents' => Money::fromFloat((float) $price),
            'is_active' => 1, 'position' => $max + 1,
        ]);
        flash_redirect('extras.php', 'ok', 'Doplnok bol pridaný.');
    }

    if ($action === 'delete') {
        Db::run('DELETE FROM extras WHERE id = ?', [(int) ($_POST['id'] ?? 0)]);
        flash_redirect('extras.php', 'ok', 'Doplnok bol zmazaný.');
    }
}

$extras = Db::all(
    'SELECT e.*, (SELECT COUNT(*) FROM product_extras pe WHERE pe.extra_id = e.id) AS used
     FROM extras e ORDER BY e.position, e.id'
);

layout_start('Doplnky', 'menu', $user);
flash_render();
?>
<div class="page-head">
  <div><p class="eyebrow">Menu</p><h1>Doplnky</h1></div>
  <a class="btn btn-ghost" href="menu.php">Späť na menu</a>
</div>

<div class="alert alert-info">
  Doplnky sú extra veci, ktoré si zákazník priráta k položke (extra porcia, chedar, jalapeños).
  Ku ktorej položke sa ponúkajú, nastavíš pri úprave položky.
</div>

<div class="grid grid-2">
  <div class="card">
    <h2>Zoznam</h2>
    <div class="table-wrap" style="margin-top:12px">
      <table class="data">
        <thead><tr><th>Názov</th><th class="num">Cena</th><th>Použitý pri</th><th></th></tr></thead>
        <tbody>
        <?php foreach ($extras as $ex): ?>
          <tr>
            <td>
              <form method="post" style="display:flex;gap:8px;align-items:center;margin:0">
                <?= Csrf::field() ?>
                <input type="hidden" name="action" value="save">
                <input type="hidden" name="id" value="<?= (int) $ex['id'] ?>">
                <input type="text" name="name" value="<?= e($ex['name']) ?>" style="min-height:38px">
            </td>
            <td class="num">
                <input type="text" name="price" inputmode="decimal" style="min-height:38px;width:88px;text-align:right"
                       value="<?= e(number_format(Money::toFloat((int) $ex['price_cents']), 2, ',', '')) ?>">
            </td>
            <td class="hint"><?= (int) $ex['used'] ?> položkách</td>
            <td>
                <button class="btn btn-sm" type="submit">Uložiť</button>
              </form>
              <?php if ((int) $ex['used'] === 0): ?>
                <form method="post" style="display:inline;margin-left:4px"
                      onsubmit="return confirm('Zmazať doplnok?')">
                  <?= Csrf::field() ?>
                  <input type="hidden" name="action" value="delete">
                  <input type="hidden" name="id" value="<?= (int) $ex['id'] ?>">
                  <button class="btn btn-sm btn-danger" type="submit">Zmazať</button>
                </form>
              <?php endif; ?>
            </td>
          </tr>
        <?php endforeach; ?>
        </tbody>
      </table>
    </div>
  </div>

  <div class="card" style="align-self:start">
    <h2>Nový doplnok</h2>
    <form method="post" style="margin-top:14px">
      <?= Csrf::field() ?>
      <input type="hidden" name="action" value="save">
      <label class="field"><span>Názov *</span><input type="text" name="name" required placeholder="Extra slanina"></label>
      <label class="field"><span>Cena v €</span><input type="text" name="price" inputmode="decimal" value="0,00"></label>
      <button class="btn btn-block" type="submit">Pridať doplnok</button>
    </form>
  </div>
</div>
<?php layout_end(); ?>
