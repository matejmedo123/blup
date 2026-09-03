<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

/**
 * Skupiny doplnkov — varianty s pravidlami.
 *
 * Kým obyčajný doplnok je „prirátaj mi extra syr“, skupina rieši výber,
 * ktorý musí sedieť: veľkosť pizze je práve jedna z troch, omáčky
 * najviac dve. Pravidlá potom vynucuje server pri objednávke.
 */

$user = Auth::requireRole(Auth::ROLE_ADMIN);

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    Csrf::require();
    $action = (string) ($_POST['action'] ?? '');

    if ($action === 'save_group') {
        $gid  = (int) ($_POST['id'] ?? 0);
        $name = Validate::clean($_POST['name'] ?? '', 120);
        if ($name === '') {
            flash_redirect('modifiers.php', 'error', 'Zadaj názov skupiny.');
        }

        $data = [
            'name'        => $name,
            'hint'        => Validate::clean($_POST['hint'] ?? '', 190) ?: null,
            'is_required' => isset($_POST['is_required']) ? 1 : 0,
            'min_select'  => max(0, (int) ($_POST['min_select'] ?? 0)),
            'max_select'  => max(0, (int) ($_POST['max_select'] ?? 0)),
            'is_active'   => isset($_POST['is_active']) ? 1 : 0,
        ];

        if ($data['max_select'] > 0 && $data['min_select'] > $data['max_select']) {
            flash_redirect('modifiers.php', 'error', 'Najmenší počet nemôže byť väčší než najväčší.');
        }

        if ($gid > 0) {
            Db::update('modifier_groups', $data, 'id = :id', ['id' => $gid]);
            AuditLog::record($user, 'update', 'modifier_group', (string) $gid, "Skupina „$name“ upravená");
            flash_redirect('modifiers.php', 'ok', 'Skupina bola uložená.');
        }

        $slug = slugify($name);
        if (Db::value('SELECT 1 FROM modifier_groups WHERE slug = ?', [$slug])) {
            flash_redirect('modifiers.php', 'error', 'Skupina s takýmto názvom už existuje.');
        }
        $max = (int) (Db::value('SELECT MAX(position) FROM modifier_groups') ?? 0);
        $newId = Db::insert('modifier_groups', $data + ['slug' => $slug, 'position' => $max + 1]);
        AuditLog::record($user, 'create', 'modifier_group', (string) $newId, "Skupina „$name“ vytvorená");
        flash_redirect('modifiers.php', 'ok', 'Skupina bola pridaná.');
    }

    if ($action === 'add_option') {
        $gid   = (int) ($_POST['group_id'] ?? 0);
        $name  = Validate::clean($_POST['name'] ?? '', 120);
        $price = (float) str_replace(',', '.', (string) ($_POST['price'] ?? '0'));
        if ($gid === 0 || $name === '') {
            flash_redirect('modifiers.php', 'error', 'Zadaj názov možnosti.');
        }
        $slug = slugify($name);
        if (Db::value('SELECT 1 FROM extras WHERE slug = ?', [$slug])) {
            $slug .= '-' . substr((string) time(), -4);
        }
        $max = (int) (Db::value('SELECT MAX(position) FROM extras') ?? 0);
        Db::insert('extras', [
            'slug'        => $slug,
            'name'        => $name,
            'price_cents' => Money::fromFloat($price),
            'is_active'   => 1,
            'position'    => $max + 1,
            'group_id'    => $gid,
        ]);
        AuditLog::record($user, 'create', 'modifier', $slug, "Možnosť „$name“ pridaná do skupiny");
        flash_redirect('modifiers.php', 'ok', 'Možnosť bola pridaná.');
    }

    if ($action === 'delete_option') {
        $eid = (int) ($_POST['id'] ?? 0);
        // Doplnok, ktorý už bol v objednávke, sa nemaže — objednávka
        // má vlastnú kópiu, ale zoznam by sa zbytočne rozpadol.
        Db::run('UPDATE extras SET is_active = 0 WHERE id = ?', [$eid]);
        AuditLog::record($user, 'deactivate', 'modifier', (string) $eid, 'Možnosť vypnutá');
        flash_redirect('modifiers.php', 'ok', 'Možnosť bola vypnutá.');
    }

    if ($action === 'assign') {
        $gid      = (int) ($_POST['group_id'] ?? 0);
        $products = array_map('intval', (array) ($_POST['products'] ?? []));
        Db::transaction(static function () use ($gid, $products): void {
            Db::run('DELETE FROM product_modifier_groups WHERE group_id = ?', [$gid]);
            foreach ($products as $i => $pid) {
                Db::insert('product_modifier_groups', [
                    'product_id' => $pid,
                    'group_id'   => $gid,
                    'position'   => $i,
                ]);
            }
        });
        AuditLog::record($user, 'update', 'modifier_group', (string) $gid, 'Zmenené priradenie k položkám');
        flash_redirect('modifiers.php', 'ok', 'Priradenie bolo uložené.');
    }
}

function slugify(string $name): string
{
    $ascii = iconv('UTF-8', 'ASCII//TRANSLIT', $name) ?: $name;
    return trim((string) preg_replace('/[^a-z0-9]+/', '-', strtolower($ascii)), '-') ?: 'skupina';
}

$groups   = ModifierGroups::all();
$products = Db::all(
    'SELECT p.id, p.name, c.label AS category
     FROM products p JOIN categories c ON c.id = p.category_id
     ORDER BY c.position, p.position, p.id'
);

$assigned = [];
foreach (Db::all('SELECT group_id, product_id FROM product_modifier_groups') as $row) {
    $assigned[(int) $row['group_id']][(int) $row['product_id']] = true;
}

layout_start('Varianty', 'menu', $user);
flash_render();
?>
<div class="page-head">
  <div><p class="eyebrow">Menu</p><h1>Varianty a skupiny</h1></div>
  <a class="btn btn-ghost" href="menu.php">Späť na menu</a>
</div>

<div class="alert alert-info">
  <strong>Na čo to je.</strong> Obyčajný doplnok si zákazník pridá, keď chce.
  Skupina rieši výber, ktorý musí sedieť — napríklad <em>veľkosť</em>, kde si
  musí vybrať práve jednu možnosť. Pravidlá kontroluje server, takže ich
  nikto neobíde.
  <br><br>
  <strong>Povinná</strong> = bez výberu sa položka nedá objednať.
  <strong>Najmenej / najviac</strong> = koľko možností si môže vybrať
  (najviac <code>0</code> znamená koľko chce).
</div>

<?php foreach ($groups as $g): $gid = (int) $g['id']; ?>
  <div class="card" style="margin-bottom:18px">
    <form method="post" class="row row-wrap" style="align-items:flex-end;gap:12px">
      <?= Csrf::field() ?>
      <input type="hidden" name="action" value="save_group">
      <input type="hidden" name="id" value="<?= $gid ?>">

      <label class="field" style="flex:2 1 220px"><span>Názov skupiny</span>
        <input type="text" name="name" value="<?= e($g['name']) ?>" required></label>
      <label class="field" style="flex:2 1 220px"><span>Popis pod názvom</span>
        <input type="text" name="hint" value="<?= e((string) ($g['hint'] ?? '')) ?>" placeholder="Vyber si jednu"></label>
      <label class="field" style="flex:0 0 110px"><span>Najmenej</span>
        <input type="number" name="min_select" min="0" max="20" value="<?= (int) $g['min_select'] ?>"></label>
      <label class="field" style="flex:0 0 110px"><span>Najviac</span>
        <input type="number" name="max_select" min="0" max="20" value="<?= (int) $g['max_select'] ?>"></label>

      <label class="check"><input type="checkbox" name="is_required" <?= (int) $g['is_required'] ? 'checked' : '' ?>> Povinná</label>
      <label class="check"><input type="checkbox" name="is_active" <?= (int) $g['is_active'] ? 'checked' : '' ?>> Zapnutá</label>
      <button class="btn" type="submit">Uložiť</button>
    </form>

    <div class="grid grid-2" style="margin-top:18px">
      <div>
        <h3>Možnosti</h3>
        <table class="data" style="margin-top:10px">
          <tbody>
          <?php foreach ($g['options'] as $o): ?>
            <tr>
              <td><?= e($o['name']) ?></td>
              <td class="num"><?= e(number_format($o['price'], 2, ',', ' ')) ?> €</td>
              <td class="num">
                <form method="post" style="margin:0" onsubmit="return confirm('Vypnúť možnosť?')">
                  <?= Csrf::field() ?>
                  <input type="hidden" name="action" value="delete_option">
                  <input type="hidden" name="id" value="<?= e((string) Db::value('SELECT id FROM extras WHERE slug = ?', [$o['id']])) ?>">
                  <button class="btn btn-sm btn-danger" type="submit">Vypnúť</button>
                </form>
              </td>
            </tr>
          <?php endforeach; ?>
          <?php if ($g['options'] === []): ?>
            <tr><td class="hint" colspan="3">Zatiaľ žiadne možnosti.</td></tr>
          <?php endif; ?>
          </tbody>
        </table>

        <form method="post" class="row" style="margin-top:12px;gap:8px;align-items:flex-end">
          <?= Csrf::field() ?>
          <input type="hidden" name="action" value="add_option">
          <input type="hidden" name="group_id" value="<?= $gid ?>">
          <label class="field" style="flex:2 1 160px"><span>Nová možnosť</span>
            <input type="text" name="name" placeholder="Veľká 40 cm" required></label>
          <label class="field" style="flex:0 0 110px"><span>Príplatok €</span>
            <input type="text" name="price" inputmode="decimal" value="0,00"></label>
          <button class="btn" type="submit">Pridať</button>
        </form>
      </div>

      <div>
        <h3>Pri ktorých položkách</h3>
        <form method="post" style="margin-top:10px">
          <?= Csrf::field() ?>
          <input type="hidden" name="action" value="assign">
          <input type="hidden" name="group_id" value="<?= $gid ?>">
          <div class="checklist">
            <?php foreach ($products as $p): ?>
              <label class="check">
                <input type="checkbox" name="products[]" value="<?= (int) $p['id'] ?>"
                  <?= isset($assigned[$gid][(int) $p['id']]) ? 'checked' : '' ?>>
                <?= e($p['name']) ?> <span class="hint"><?= e($p['category']) ?></span>
              </label>
            <?php endforeach; ?>
          </div>
          <button class="btn btn-block" type="submit" style="margin-top:12px">Uložiť priradenie</button>
        </form>
      </div>
    </div>
  </div>
<?php endforeach; ?>

<div class="card">
  <h2>Nová skupina</h2>
  <p class="hint" style="margin-top:6px">
    Napríklad <em>Veľkosť</em> (povinná, najmenej 1, najviac 1)
    alebo <em>Omáčky</em> (nepovinná, najviac 2).
  </p>
  <form method="post" class="row row-wrap" style="margin-top:14px;align-items:flex-end;gap:12px">
    <?= Csrf::field() ?>
    <input type="hidden" name="action" value="save_group">
    <input type="hidden" name="is_active" value="1">
    <label class="field" style="flex:2 1 220px"><span>Názov *</span>
      <input type="text" name="name" required placeholder="Veľkosť"></label>
    <label class="field" style="flex:2 1 220px"><span>Popis</span>
      <input type="text" name="hint" placeholder="Vyber si jednu"></label>
    <label class="field" style="flex:0 0 110px"><span>Najmenej</span>
      <input type="number" name="min_select" min="0" max="20" value="1"></label>
    <label class="field" style="flex:0 0 110px"><span>Najviac</span>
      <input type="number" name="max_select" min="0" max="20" value="1"></label>
    <label class="check"><input type="checkbox" name="is_required" checked> Povinná</label>
    <button class="btn" type="submit">Vytvoriť skupinu</button>
  </form>
</div>
<?php layout_end(); ?>
