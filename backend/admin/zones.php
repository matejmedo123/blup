<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

/**
 * Doručovacie zóny.
 *
 * Do vzdialenejšej dediny sa oplatí vyraziť až pri väčšej objednávke —
 * preto má každá obec vlastný poplatok, vlastné minimum a vlastný čas.
 * Adresu mimo zón systém odmietne a zákazníkovi vypíše, kam vozíme.
 */

$user = Auth::requireRole(Auth::ROLE_ADMIN);

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    Csrf::require();
    $action = (string) ($_POST['action'] ?? '');

    if ($action === 'save') {
        $id   = (int) ($_POST['id'] ?? 0);
        $name = Validate::clean($_POST['name'] ?? '', 120);
        if ($name === '') {
            flash_redirect('zones.php', 'error', 'Zadaj názov obce.');
        }

        $freeFrom = trim((string) ($_POST['free_from'] ?? ''));

        $data = [
            'name'            => $name,
            'postal_codes'    => Validate::clean($_POST['postal_codes'] ?? '', 255) ?: null,
            'fee_cents'       => Money::fromFloat((float) str_replace(',', '.', (string) ($_POST['fee'] ?? '0'))),
            'min_order_cents' => Money::fromFloat((float) str_replace(',', '.', (string) ($_POST['min_order'] ?? '0'))),
            // Prázdne pole = doručenie zdarma sa v tejto zóne nedáva.
            'free_from_cents' => $freeFrom === ''
                ? null
                : Money::fromFloat((float) str_replace(',', '.', $freeFrom)),
            'eta_minutes'     => max(5, min(180, (int) ($_POST['eta'] ?? 45))),
            'is_active'       => isset($_POST['is_active']) ? 1 : 0,
        ];

        if ($id > 0) {
            Db::update('delivery_zones', $data, 'id = :id', ['id' => $id]);
            AuditLog::record($user, 'update', 'delivery_zone', (string) $id, "Zóna „$name“ upravená");
            flash_redirect('zones.php', 'ok', 'Zóna bola uložená.');
        }

        $max = (int) (Db::value('SELECT MAX(position) FROM delivery_zones') ?? 0);
        $new = Db::insert('delivery_zones', $data + ['position' => $max + 1]);
        AuditLog::record($user, 'create', 'delivery_zone', (string) $new, "Zóna „$name“ pridaná");
        flash_redirect('zones.php', 'ok', 'Zóna bola pridaná.');
    }

    if ($action === 'delete') {
        $id   = (int) ($_POST['id'] ?? 0);
        $name = (string) Db::value('SELECT name FROM delivery_zones WHERE id = ?', [$id]);
        Db::run('DELETE FROM delivery_zones WHERE id = ?', [$id]);
        AuditLog::record($user, 'delete', 'delivery_zone', (string) $id, "Zóna „$name“ zmazaná");
        flash_redirect('zones.php', 'ok', 'Zóna bola zmazaná.');
    }
}

$zones = DeliveryZones::all(false);

layout_start('Doručovacie zóny', 'settings', $user);
flash_render();
?>
<div class="page-head">
  <div><p class="eyebrow">Prevádzka</p><h1>Doručovacie zóny</h1></div>
  <a class="btn btn-ghost" href="settings.php">Späť na nastavenia</a>
</div>

<div class="alert alert-info">
  Zákazník si v pokladni vyberie obec zo zoznamu a hneď vidí poplatok.
  Adresu, ktorá sem nepatrí, systém odmietne — nestane sa, že objednávku
  prijmeš a až potom zistíš, že je to 30 km.
  <br><br>
  <strong>PSČ</strong> je nepovinné, oddeľuj medzerou alebo čiarkou. Keď ho
  vyplníš, obec sa nájde aj vtedy, keď si zákazník názov napíše inak.
  <br>
  <strong>Zdarma od</strong> nechaj prázdne, ak sa v tejto zóne doručenie
  zdarma nedáva.
</div>

<div class="card">
  <h2>Zóny</h2>
  <div class="table-wrap" style="margin-top:12px">
    <table class="data">
      <thead>
        <tr>
          <th>Obec</th><th class="hide-sm">PSČ</th>
          <th class="num">Poplatok</th><th class="num">Minimum</th>
          <th class="num hide-sm">Zdarma od</th><th class="num hide-sm">Čas</th>
          <th>Aktívna</th><th></th>
        </tr>
      </thead>
      <tbody>
      <?php foreach ($zones as $z): ?>
        <tr>
          <form method="post" style="display:contents">
            <?= Csrf::field() ?>
            <input type="hidden" name="action" value="save">
            <input type="hidden" name="id" value="<?= (int) $z['id'] ?>">
            <td><input type="text" name="name" value="<?= e((string) $z['name']) ?>" required style="min-width:120px"></td>
            <td class="hide-sm"><input type="text" name="postal_codes" value="<?= e((string) ($z['postal_codes'] ?? '')) ?>" style="min-width:100px"></td>
            <td class="num"><input type="text" name="fee" inputmode="decimal" style="width:80px;text-align:right"
                   value="<?= e(number_format(Money::toFloat((int) $z['fee_cents']), 2, ',', '')) ?>"></td>
            <td class="num"><input type="text" name="min_order" inputmode="decimal" style="width:80px;text-align:right"
                   value="<?= e(number_format(Money::toFloat((int) $z['min_order_cents']), 2, ',', '')) ?>"></td>
            <td class="num hide-sm"><input type="text" name="free_from" inputmode="decimal" style="width:80px;text-align:right"
                   value="<?= $z['free_from_cents'] !== null ? e(number_format(Money::toFloat((int) $z['free_from_cents']), 2, ',', '')) : '' ?>"></td>
            <td class="num hide-sm"><input type="number" name="eta" min="5" max="180" style="width:70px" value="<?= (int) $z['eta_minutes'] ?>"></td>
            <td>
              <label class="check" style="margin:0">
                <input type="checkbox" name="is_active" <?= (int) $z['is_active'] ? 'checked' : '' ?>>
              </label>
            </td>
            <td class="num"><button class="btn btn-sm" type="submit">Uložiť</button></td>
          </form>
        </tr>
      <?php endforeach; ?>
      <?php if ($zones === []): ?>
        <tr><td colspan="8" class="hint">
          Zatiaľ žiadne zóny. Kým tu nič nie je, platí jednotný poplatok
          z nastavení a rozvoz sa neobmedzuje podľa obce.
        </td></tr>
      <?php endif; ?>
      </tbody>
    </table>
  </div>

  <?php if ($zones !== []): ?>
    <p class="hint" style="margin-top:12px">
      Zmazať zónu má zmysel len keď tam naozaj nevozíš. Keď tam len teraz
      nestíhaš, odškrtni <strong>Aktívna</strong> — objednávky sa odtiaľ
      prestanú brať a vieš to jedným klikom vrátiť.
    </p>
    <div class="row row-wrap" style="margin-top:10px;gap:8px">
      <?php foreach ($zones as $z): ?>
        <form method="post" style="margin:0" onsubmit="return confirm('Zmazať zónu <?= e((string) $z['name']) ?>?')">
          <?= Csrf::field() ?>
          <input type="hidden" name="action" value="delete">
          <input type="hidden" name="id" value="<?= (int) $z['id'] ?>">
          <button class="btn btn-sm btn-danger" type="submit">Zmazať <?= e((string) $z['name']) ?></button>
        </form>
      <?php endforeach; ?>
    </div>
  <?php endif; ?>
</div>

<div class="card" style="margin-top:16px">
  <h2>Nová zóna</h2>
  <form method="post" class="row row-wrap" style="margin-top:14px;gap:12px;align-items:flex-end">
    <?= Csrf::field() ?>
    <input type="hidden" name="action" value="save">
    <input type="hidden" name="is_active" value="1">
    <label class="field" style="flex:2 1 160px"><span>Obec *</span>
      <input type="text" name="name" required placeholder="Ludanice"></label>
    <label class="field" style="flex:1 1 130px"><span>PSČ</span>
      <input type="text" name="postal_codes" placeholder="956 11"></label>
    <label class="field" style="flex:0 0 110px"><span>Poplatok €</span>
      <input type="text" name="fee" inputmode="decimal" value="2,50"></label>
    <label class="field" style="flex:0 0 110px"><span>Minimum €</span>
      <input type="text" name="min_order" inputmode="decimal" value="12,00"></label>
    <label class="field" style="flex:0 0 110px"><span>Zdarma od €</span>
      <input type="text" name="free_from" inputmode="decimal" value="35,00"></label>
    <label class="field" style="flex:0 0 100px"><span>Čas (min)</span>
      <input type="number" name="eta" min="5" max="180" value="45"></label>
    <button class="btn" type="submit">Pridať zónu</button>
  </form>
</div>
<?php layout_end(); ?>
