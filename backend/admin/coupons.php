<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

/**
 * Zľavové kódy.
 *
 * Kód overuje a zľavu počíta server pri každej objednávke, takže sa
 * nedá obísť ani vyčerpaný, ani prepadnutý kód.
 */

$user = Auth::requireRole(Auth::ROLE_ADMIN);

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    Csrf::require();
    $action = (string) ($_POST['action'] ?? '');

    if ($action === 'save') {
        $id   = (int) ($_POST['id'] ?? 0);
        $code = Coupons::normalize((string) ($_POST['code'] ?? ''));
        $kind = (string) ($_POST['kind'] ?? Coupons::PERCENT);

        if (!preg_match('/^[A-Z0-9\-]{3,40}$/', $code)) {
            flash_redirect('coupons.php', 'error', 'Kód môže mať 3 – 40 znakov: veľké písmená, čísla a pomlčku.');
        }
        if (!in_array($kind, [Coupons::PERCENT, Coupons::FIXED, Coupons::FREE_DELIVERY], true)) {
            flash_redirect('coupons.php', 'error', 'Neznámy druh zľavy.');
        }

        $rawValue = (float) str_replace(',', '.', (string) ($_POST['value'] ?? '0'));
        // Percentá sú celé čísla, pevná zľava sú centy — inak by sa 5 €
        // uložilo ako 5 centov.
        $value = match ($kind) {
            Coupons::PERCENT => max(1, min(100, (int) round($rawValue))),
            Coupons::FIXED   => Money::fromFloat($rawValue),
            default          => 0,
        };

        if ($kind !== Coupons::FREE_DELIVERY && $value <= 0) {
            flash_redirect('coupons.php', 'error', 'Zadaj hodnotu zľavy.');
        }

        $maxUses = trim((string) ($_POST['max_uses'] ?? ''));
        $endsAt  = trim((string) ($_POST['ends_at'] ?? ''));

        $data = [
            'description'     => Validate::clean($_POST['description'] ?? '', 190) ?: null,
            'kind'            => $kind,
            'value'           => $value,
            'min_order_cents' => Money::fromFloat((float) str_replace(',', '.', (string) ($_POST['min_order'] ?? '0'))),
            'max_uses'        => $maxUses === '' ? null : max(1, (int) $maxUses),
            'ends_at'         => $endsAt === '' ? null : date('Y-m-d H:i:s', (int) strtotime($endsAt)),
            'is_active'       => isset($_POST['is_active']) ? 1 : 0,
        ];

        if ($id > 0) {
            Db::update('coupons', $data, 'id = :id', ['id' => $id]);
            AuditLog::record($user, 'update', 'coupon', $code, "Kód $code upravený");
            flash_redirect('coupons.php', 'ok', "Kód $code je uložený.");
        }

        if (Db::value('SELECT 1 FROM coupons WHERE UPPER(code) = ?', [$code])) {
            flash_redirect('coupons.php', 'error', "Kód $code už existuje.");
        }

        Db::insert('coupons', $data + [
            'code'       => $code,
            'used_count' => 0,
            'starts_at'  => null,
            'created_at' => date('Y-m-d H:i:s'),
        ]);
        AuditLog::record($user, 'create', 'coupon', $code, "Kód $code vytvorený");
        flash_redirect('coupons.php', 'ok', "Kód $code je pripravený.");
    }

    if ($action === 'delete') {
        $id   = (int) ($_POST['id'] ?? 0);
        $code = (string) Db::value('SELECT code FROM coupons WHERE id = ?', [$id]);
        Db::run('DELETE FROM coupons WHERE id = ?', [$id]);
        AuditLog::record($user, 'delete', 'coupon', $code, "Kód $code zmazaný");
        flash_redirect('coupons.php', 'ok', 'Kód bol zmazaný.');
    }
}

$coupons = Db::tableExists('coupons')
    ? Db::all('SELECT * FROM coupons ORDER BY is_active DESC, created_at DESC')
    : [];

/** Ľudský popis zľavy do tabuľky. */
function coupon_value(array $c): string
{
    return match ((string) $c['kind']) {
        Coupons::PERCENT       => '−' . (int) $c['value'] . ' %',
        Coupons::FIXED         => '−' . Money::format((int) $c['value']),
        Coupons::FREE_DELIVERY => 'doprava zdarma',
        default                => '—',
    };
}

layout_start('Zľavové kódy', 'settings', $user);
flash_render();
?>
<div class="page-head">
  <div><p class="eyebrow">Marketing</p><h1>Zľavové kódy</h1></div>
  <a class="btn btn-ghost" href="settings.php">Späť na nastavenia</a>
</div>

<div class="alert alert-info">
  Zákazník kód zadá v pokladni. Zľava sa vždy počíta <strong>z jedla</strong>,
  nie z poplatku za doručenie, a nikdy nespraví objednávku zápornou.
  <br><br>
  <strong>Počet použití</strong> nechaj prázdne, ak má kód platiť bez obmedzenia.
  <strong>Platí do</strong> nechaj prázdne, ak nemá vypršať.
</div>

<div class="card">
  <h2>Kódy</h2>
  <div class="table-wrap" style="margin-top:12px">
    <table class="data">
      <thead>
        <tr>
          <th>Kód</th><th class="hide-sm">Popis</th><th>Zľava</th>
          <th class="num">Od objednávky</th><th class="num">Použité</th>
          <th class="hide-sm">Platí do</th><th>Aktívny</th><th></th>
        </tr>
      </thead>
      <tbody>
      <?php foreach ($coupons as $c): ?>
        <tr>
          <form method="post" style="display:contents">
            <?= Csrf::field() ?>
            <input type="hidden" name="action" value="save">
            <input type="hidden" name="id" value="<?= (int) $c['id'] ?>">
            <input type="hidden" name="code" value="<?= e((string) $c['code']) ?>">
            <input type="hidden" name="kind" value="<?= e((string) $c['kind']) ?>">
            <td><strong><?= e((string) $c['code']) ?></strong></td>
            <td class="hide-sm"><input type="text" name="description" value="<?= e((string) ($c['description'] ?? '')) ?>" style="min-width:140px"></td>
            <td>
              <?php if ((string) $c['kind'] === Coupons::FREE_DELIVERY): ?>
                <input type="hidden" name="value" value="0">
                <span class="badge badge-ready">doprava zdarma</span>
              <?php else: ?>
                <input type="text" name="value" inputmode="decimal" style="width:80px;text-align:right"
                       value="<?= (string) $c['kind'] === Coupons::PERCENT
                         ? (int) $c['value']
                         : e(number_format(Money::toFloat((int) $c['value']), 2, ',', '')) ?>">
                <span class="hint"><?= (string) $c['kind'] === Coupons::PERCENT ? '%' : '€' ?></span>
              <?php endif; ?>
            </td>
            <td class="num"><input type="text" name="min_order" inputmode="decimal" style="width:80px;text-align:right"
                   value="<?= e(number_format(Money::toFloat((int) $c['min_order_cents']), 2, ',', '')) ?>"></td>
            <td class="num">
              <?= (int) $c['used_count'] ?><?= $c['max_uses'] !== null ? ' / ' . (int) $c['max_uses'] : '' ?>
              <input type="hidden" name="max_uses" value="<?= $c['max_uses'] !== null ? (int) $c['max_uses'] : '' ?>">
            </td>
            <td class="hide-sm">
              <input type="date" name="ends_at"
                     value="<?= $c['ends_at'] ? e(date('Y-m-d', strtotime((string) $c['ends_at']))) : '' ?>">
            </td>
            <td>
              <label class="check" style="margin:0">
                <input type="checkbox" name="is_active" <?= (int) $c['is_active'] ? 'checked' : '' ?>>
              </label>
            </td>
            <td class="num"><button class="btn btn-sm" type="submit">Uložiť</button></td>
          </form>
        </tr>
      <?php endforeach; ?>
      <?php if ($coupons === []): ?>
        <tr><td colspan="8" class="hint">Zatiaľ žiadne kódy.</td></tr>
      <?php endif; ?>
      </tbody>
    </table>
  </div>

  <?php if ($coupons !== []): ?>
    <p class="hint" style="margin-top:12px">
      Kód, ktorý už niekto použil, radšej len vypni — zmazaním prídeš
      o prehľad, koľkokrát sa uplatnil.
    </p>
  <?php endif; ?>
</div>

<div class="card" style="margin-top:16px">
  <h2>Nový kód</h2>
  <form method="post" class="row row-wrap" style="margin-top:14px;gap:12px;align-items:flex-end">
    <?= Csrf::field() ?>
    <input type="hidden" name="action" value="save">
    <input type="hidden" name="is_active" value="1">

    <label class="field" style="flex:1 1 150px"><span>Kód *</span>
      <input type="text" name="code" required placeholder="VITAJ10"
             style="text-transform:uppercase" pattern="[A-Za-z0-9\-]{3,40}"></label>

    <label class="field" style="flex:1 1 150px"><span>Druh</span>
      <select name="kind">
        <option value="percent">zľava v %</option>
        <option value="fixed">zľava v €</option>
        <option value="free_delivery">doručenie zdarma</option>
      </select>
    </label>

    <label class="field" style="flex:0 0 120px"><span>Hodnota</span>
      <input type="text" name="value" inputmode="decimal" value="10"></label>

    <label class="field" style="flex:0 0 130px"><span>Od objednávky €</span>
      <input type="text" name="min_order" inputmode="decimal" value="0,00"></label>

    <label class="field" style="flex:0 0 130px"><span>Počet použití</span>
      <input type="number" name="max_uses" min="1" placeholder="bez limitu"></label>

    <label class="field" style="flex:0 0 150px"><span>Platí do</span>
      <input type="date" name="ends_at"></label>

    <label class="field" style="flex:2 1 200px"><span>Popis (pre teba)</span>
      <input type="text" name="description" placeholder="Leták do schránok"></label>

    <button class="btn" type="submit">Vytvoriť kód</button>
  </form>
</div>
<?php layout_end(); ?>
