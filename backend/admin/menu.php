<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

$user = Auth::requireRole(Auth::ROLE_ADMIN);

/* ---------- Rýchle akcie (dostupnosť, poradie, zmazanie) ---------- */
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    Csrf::require();
    $action = (string) ($_POST['action'] ?? '');
    $pid    = (int) ($_POST['product_id'] ?? 0);

    if ($action === 'toggle' && $pid > 0) {
        $cur = (int) (Db::value('SELECT is_available FROM products WHERE id = ?', [$pid]) ?? 1);
        Db::run('UPDATE products SET is_available = ?, updated_at = ? WHERE id = ?', [$cur ? 0 : 1, date('Y-m-d H:i:s'), $pid]);
        flash_redirect('menu.php', 'ok', $cur ? 'Položka je označená ako vypredaná.' : 'Položka je opäť v ponuke.');
    }

    if ($action === 'delete' && $pid > 0) {
        $name = (string) (Db::value('SELECT name FROM products WHERE id = ?', [$pid]) ?? '');
        Db::run('DELETE FROM products WHERE id = ?', [$pid]);
        flash_redirect('menu.php', 'ok', "Položka „$name“ bola zmazaná.");
    }

    if ($action === 'move' && $pid > 0) {
        $dir = (string) ($_POST['dir'] ?? 'up');
        $cur = Db::one('SELECT id, category_id, position FROM products WHERE id = ?', [$pid]);
        if ($cur !== null) {
            $cmp   = $dir === 'up' ? '<' : '>';
            $order = $dir === 'up' ? 'DESC' : 'ASC';
            $swap  = Db::one(
                "SELECT id, position FROM products
                 WHERE category_id = ? AND position $cmp ? ORDER BY position $order LIMIT 1",
                [$cur['category_id'], $cur['position']]
            );
            if ($swap !== null) {
                Db::run('UPDATE products SET position = ? WHERE id = ?', [$swap['position'], $cur['id']]);
                Db::run('UPDATE products SET position = ? WHERE id = ?', [$cur['position'], $swap['id']]);
            }
        }
        flash_redirect('menu.php', 'ok', 'Poradie upravené.');
    }
}

$categories = Db::all('SELECT * FROM categories ORDER BY position, id');
$byCategory = [];
foreach (Db::all(
    'SELECT p.*, (SELECT COUNT(*) FROM product_extras pe WHERE pe.product_id = p.id) AS extras_count
     FROM products p ORDER BY p.position, p.id'
) as $p) {
    $byCategory[(int) $p['category_id']][] = $p;
}

layout_start('Menu', 'menu', $user);
flash_render();
?>

<div class="page-head">
  <div><p class="eyebrow">Ponuka</p><h1>Menu</h1></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap">
    <a class="btn btn-ghost" href="categories.php">Kategórie</a>
    <a class="btn btn-ghost" href="extras.php">Doplnky</a>
    <a class="btn btn-ghost" href="modifiers.php">Varianty</a>
    <a class="btn" href="product.php">+ Nová položka</a>
  </div>
</div>

<div class="alert alert-info">
  Zmena sa na webe prejaví do pol minúty — zákazníci nemusia nič obnovovať.
  <strong>Vypredané</strong> položky ostanú v menu, ale nedajú sa objednať.
</div>

<?php foreach ($categories as $c): ?>
  <?php $products = $byCategory[(int) $c['id']] ?? []; ?>
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
      <h2><?= e($c['title']) ?>
        <span class="hint" style="font-weight:400">· <?= count($products) ?> položiek</span>
      </h2>
      <a class="btn btn-sm btn-ghost" href="product.php?category=<?= (int) $c['id'] ?>">+ Pridať sem</a>
    </div>

    <div class="table-wrap" style="margin-top:12px">
      <table class="data">
        <thead><tr>
          <th style="width:64px"></th><th>Názov</th><th class="num">Cena</th>
          <th>Doplnky</th><th>Stav</th><th style="width:210px"></th>
        </tr></thead>
        <tbody>
        <?php foreach ($products as $p): ?>
          <tr<?= (int) $p['is_available'] === 0 ? ' style="opacity:.55"' : '' ?>>
            <td>
              <?php if (!empty($p['image'])): ?>
                <img src="../<?= e(ltrim((string) $p['image'], '/')) ?>" alt="" width="52" height="40"
                     style="object-fit:cover;border-radius:6px" loading="lazy">
              <?php else: ?>
                <div style="width:52px;height:40px;border-radius:6px;background:var(--cream-2)"></div>
              <?php endif; ?>
            </td>
            <td>
              <strong><?= e($p['name']) ?></strong>
              <?php if ($p['badge']): ?>
                <span class="badge badge-received" style="margin-left:6px"><?= e($p['badge']) ?></span>
              <?php endif; ?>
              <div class="hint"><?= e(mb_strimwidth((string) $p['description'], 0, 70, '…')) ?></div>
            </td>
            <td class="num"><strong><?= e(Money::format((int) $p['price_cents'])) ?></strong></td>
            <td class="hint"><?= (int) $p['extras_count'] ?></td>
            <td>
              <span class="badge badge-<?= (int) $p['is_available'] === 1 ? 'ready' : 'cancelled' ?>">
                <?= (int) $p['is_available'] === 1 ? 'V ponuke' : 'Vypredané' ?>
              </span>
            </td>
            <td>
              <div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end">
                <form method="post" style="margin:0"><?= Csrf::field() ?>
                  <input type="hidden" name="action" value="move">
                  <input type="hidden" name="dir" value="up">
                  <input type="hidden" name="product_id" value="<?= (int) $p['id'] ?>">
                  <button class="btn btn-sm btn-ghost" title="Posunúť vyššie">↑</button>
                </form>
                <form method="post" style="margin:0"><?= Csrf::field() ?>
                  <input type="hidden" name="action" value="move">
                  <input type="hidden" name="dir" value="down">
                  <input type="hidden" name="product_id" value="<?= (int) $p['id'] ?>">
                  <button class="btn btn-sm btn-ghost" title="Posunúť nižšie">↓</button>
                </form>
                <form method="post" style="margin:0"><?= Csrf::field() ?>
                  <input type="hidden" name="action" value="toggle">
                  <input type="hidden" name="product_id" value="<?= (int) $p['id'] ?>">
                  <button class="btn btn-sm btn-ghost">
                    <?= (int) $p['is_available'] === 1 ? 'Vypredané' : 'Do ponuky' ?>
                  </button>
                </form>
                <a class="btn btn-sm" href="product.php?id=<?= (int) $p['id'] ?>">Upraviť</a>
              </div>
            </td>
          </tr>
        <?php endforeach; ?>
        <?php if ($products === []): ?>
          <tr><td colspan="6" class="hint">V tejto kategórii zatiaľ nič nie je.</td></tr>
        <?php endif; ?>
        </tbody>
      </table>
    </div>
  </div>
<?php endforeach; ?>

<?php layout_end(); ?>
