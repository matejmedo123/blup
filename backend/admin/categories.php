<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

$user = Auth::requireRole(Auth::ROLE_ADMIN);

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    Csrf::require();
    $action = (string) ($_POST['action'] ?? '');
    $cid    = (int) ($_POST['id'] ?? 0);

    if ($action === 'save') {
        $label   = Validate::clean($_POST['label'] ?? '', 64);
        $title   = Validate::clean($_POST['title'] ?? '', 120);
        $caption = Validate::clean($_POST['caption'] ?? '', 255);
        $active  = isset($_POST['is_active']) ? 1 : 0;
        if ($label === '' || $title === '') {
            flash_redirect('categories.php', 'error', 'Vyplň názov v taboch aj nadpis.');
        }
        if ($cid > 0) {
            Db::update('categories', [
                'label' => $label, 'title' => $title, 'caption' => $caption ?: null, 'is_active' => $active,
            ], 'id = :id', ['id' => $cid]);
            flash_redirect('categories.php', 'ok', 'Kategória bola uložená.');
        }
        $slug = trim((string) preg_replace('/[^a-z0-9]+/', '-', strtolower(iconv('UTF-8', 'ASCII//TRANSLIT', $label) ?: $label)), '-');
        if ($slug === '' || Db::value('SELECT 1 FROM categories WHERE slug = ?', [$slug])) {
            flash_redirect('categories.php', 'error', 'Takáto kategória už existuje.');
        }
        $max = (int) (Db::value('SELECT MAX(position) FROM categories') ?? 0);
        Db::insert('categories', [
            'slug' => $slug, 'label' => $label, 'title' => $title,
            'caption' => $caption ?: null, 'position' => $max + 1, 'is_active' => $active,
        ]);
        flash_redirect('categories.php', 'ok', 'Kategória bola pridaná.');
    }

    if ($action === 'move' && $cid > 0) {
        $dir   = (string) ($_POST['dir'] ?? 'up');
        $cur   = Db::one('SELECT id, position FROM categories WHERE id = ?', [$cid]);
        $cmp   = $dir === 'up' ? '<' : '>';
        $order = $dir === 'up' ? 'DESC' : 'ASC';
        $swap  = Db::one("SELECT id, position FROM categories WHERE position $cmp ? ORDER BY position $order LIMIT 1", [$cur['position']]);
        if ($swap !== null) {
            Db::run('UPDATE categories SET position = ? WHERE id = ?', [$swap['position'], $cur['id']]);
            Db::run('UPDATE categories SET position = ? WHERE id = ?', [$cur['position'], $swap['id']]);
        }
        flash_redirect('categories.php', 'ok', 'Poradie upravené.');
    }

    if ($action === 'delete' && $cid > 0) {
        $count = (int) (Db::value('SELECT COUNT(*) FROM products WHERE category_id = ?', [$cid]) ?? 0);
        if ($count > 0) {
            flash_redirect('categories.php', 'error', "Kategória obsahuje $count položiek — najprv ich presuň inam.");
        }
        Db::run('DELETE FROM categories WHERE id = ?', [$cid]);
        flash_redirect('categories.php', 'ok', 'Kategória bola zmazaná.');
    }
}

$categories = Db::all(
    'SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
     FROM categories c ORDER BY c.position, c.id'
);

layout_start('Kategórie', 'menu', $user);
flash_render();
?>
<div class="page-head">
  <div><p class="eyebrow">Menu</p><h1>Kategórie</h1></div>
  <a class="btn btn-ghost" href="menu.php">Späť na menu</a>
</div>

<div class="grid grid-2">
  <div class="card">
    <h2>Zoznam</h2>
    <?php foreach ($categories as $c): ?>
      <form method="post" style="border-top:1px solid var(--line);padding:14px 0;margin:0">
        <?= Csrf::field() ?>
        <input type="hidden" name="action" value="save">
        <input type="hidden" name="id" value="<?= (int) $c['id'] ?>">
        <div class="row row-2">
          <label class="field" style="margin:0"><span>Názov v taboch</span>
            <input type="text" name="label" value="<?= e($c['label']) ?>"></label>
          <label class="field" style="margin:0"><span>Nadpis sekcie</span>
            <input type="text" name="title" value="<?= e($c['title']) ?>"></label>
        </div>
        <label class="field" style="margin-top:10px"><span>Podtitulok</span>
          <input type="text" name="caption" value="<?= e($c['caption']) ?>"></label>
        <label class="checkline"><input type="checkbox" name="is_active" value="1"<?= (int) $c['is_active'] === 1 ? ' checked' : '' ?>>
          <span>Zobrazovať na webe</span></label>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-sm" type="submit">Uložiť</button>
          <span class="hint" style="align-self:center"><?= (int) $c['product_count'] ?> položiek · <?= e($c['slug']) ?></span>
        </div>
      </form>
      <div style="display:flex;gap:6px;margin-bottom:6px">
        <form method="post" style="margin:0"><?= Csrf::field() ?>
          <input type="hidden" name="action" value="move"><input type="hidden" name="dir" value="up">
          <input type="hidden" name="id" value="<?= (int) $c['id'] ?>">
          <button class="btn btn-sm btn-ghost">↑</button></form>
        <form method="post" style="margin:0"><?= Csrf::field() ?>
          <input type="hidden" name="action" value="move"><input type="hidden" name="dir" value="down">
          <input type="hidden" name="id" value="<?= (int) $c['id'] ?>">
          <button class="btn btn-sm btn-ghost">↓</button></form>
        <?php if ((int) $c['product_count'] === 0): ?>
          <form method="post" style="margin:0" onsubmit="return confirm('Zmazať kategóriu?')"><?= Csrf::field() ?>
            <input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="<?= (int) $c['id'] ?>">
            <button class="btn btn-sm btn-danger">Zmazať</button></form>
        <?php endif; ?>
      </div>
    <?php endforeach; ?>
  </div>

  <div class="card" style="align-self:start">
    <h2>Nová kategória</h2>
    <form method="post" style="margin-top:14px">
      <?= Csrf::field() ?>
      <input type="hidden" name="action" value="save">
      <label class="field"><span>Názov v taboch *</span><input type="text" name="label" required placeholder="Šaláty"></label>
      <label class="field"><span>Nadpis sekcie *</span><input type="text" name="title" required placeholder="ŠALÁTY"></label>
      <label class="field"><span>Podtitulok</span><input type="text" name="caption" placeholder="Čerstvé a chrumkavé."></label>
      <label class="checkline"><input type="checkbox" name="is_active" value="1" checked><span>Zobrazovať na webe</span></label>
      <button class="btn btn-block" type="submit">Pridať kategóriu</button>
    </form>
  </div>
</div>
<?php layout_end(); ?>
