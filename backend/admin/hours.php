<?php
declare(strict_types=1);
require __DIR__ . '/../api/_bootstrap.php';
require __DIR__ . '/_layout.php';

/**
 * Otváracie hodiny a mimoriadne zatvorenia.
 *
 * To, čo je tu nastavené, systém naozaj vynucuje — mimo hodín sa
 * objednávka neodošle a zákazník dostane hlášku, kedy otvárame.
 */

$user = Auth::requireRole(Auth::ROLE_ADMIN);

/** Kontrola „HH:MM“ — do databázy nepustíme nezmysel. */
function valid_time(string $t): bool
{
    return preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', $t) === 1;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    Csrf::require();
    $action = (string) ($_POST['action'] ?? '');

    if ($action === 'save_hours') {
        $days   = (array) ($_POST['day'] ?? []);
        $errors = [];

        foreach ($days as $weekday => $row) {
            $weekday = (int) $weekday;
            if ($weekday < 1 || $weekday > 7) {
                continue;
            }
            $open  = trim((string) ($row['open'] ?? ''));
            $close = trim((string) ($row['close'] ?? ''));
            $isOpen = isset($row['is_open']) ? 1 : 0;

            if ($isOpen === 1 && (!valid_time($open) || !valid_time($close))) {
                $errors[] = OpeningHours::DAY_NAMES[$weekday] . ' — čas musí byť v tvare 11:00.';
                continue;
            }

            $data = [
                'is_open'           => $isOpen,
                'open_time'         => valid_time($open) ? $open : '11:00',
                'close_time'        => valid_time($close) ? $close : '21:00',
                'last_order_offset' => max(0, min(180, (int) ($row['last_order'] ?? 0))),
            ];

            if (Db::value('SELECT 1 FROM opening_hours WHERE weekday = ?', [$weekday])) {
                Db::update('opening_hours', $data, 'weekday = :weekday', ['weekday' => $weekday]);
            } else {
                Db::insert('opening_hours', $data + ['weekday' => $weekday]);
            }
        }

        if ($errors !== []) {
            flash_redirect('hours.php', 'error', implode(' ', $errors));
        }
        AuditLog::record($user, 'update', 'opening_hours', null, 'Otváracie hodiny upravené');
        flash_redirect('hours.php', 'ok', 'Otváracie hodiny sú uložené.');
    }

    if ($action === 'add_closure') {
        $from   = trim((string) ($_POST['starts_at'] ?? ''));
        $to     = trim((string) ($_POST['ends_at'] ?? ''));
        $reason = Validate::clean($_POST['reason'] ?? '', 190);

        $fromTs = strtotime($from);
        $toTs   = strtotime($to);
        if ($fromTs === false || $toTs === false || $toTs <= $fromTs) {
            flash_redirect('hours.php', 'error', 'Zadaj platný začiatok aj konec — konec musí byť neskôr.');
        }

        Db::insert('closures', [
            'starts_at'  => date('Y-m-d H:i:s', $fromTs),
            'ends_at'    => date('Y-m-d H:i:s', $toTs),
            'reason'     => $reason ?: null,
            'created_at' => date('Y-m-d H:i:s'),
        ]);
        AuditLog::record($user, 'create', 'closure', null, "Zatvorené $from – $to");
        flash_redirect('hours.php', 'ok', 'Zatvorenie je zapísané.');
    }

    if ($action === 'delete_closure') {
        Db::run('DELETE FROM closures WHERE id = ?', [(int) ($_POST['id'] ?? 0)]);
        AuditLog::record($user, 'delete', 'closure', (string) ($_POST['id'] ?? ''), 'Zatvorenie zrušené');
        flash_redirect('hours.php', 'ok', 'Zatvorenie bolo zrušené.');
    }
}

$hours    = OpeningHours::all();
$status   = OpeningHours::status();
$closures = Db::tableExists('closures')
    ? Db::all('SELECT * FROM closures WHERE ends_at > ? ORDER BY starts_at', [date('Y-m-d H:i:s')])
    : [];

layout_start('Otváracie hodiny', 'settings', $user);
flash_render();
?>
<div class="page-head">
  <div><p class="eyebrow">Prevádzka</p><h1>Otváracie hodiny</h1></div>
  <a class="btn btn-ghost" href="settings.php">Späť na nastavenia</a>
</div>

<div class="alert <?= $status['open'] ? 'alert-ok' : 'alert-info' ?>">
  <strong>Práve teraz:</strong>
  <?= $status['open'] ? 'prijímame objednávky.' : e($status['reason']) ?>
</div>

<div class="card">
  <h2>Bežný týždeň</h2>
  <p class="hint" style="margin-top:6px">
    <strong>Posledná objednávka</strong> je koľko minút pred zatvorením prestaneme
    brať objednávky, aby kuchyňa stihla dovariť. Nechaj <code>0</code>, ak berieš
    až do zatvorenia.
  </p>

  <form method="post" style="margin-top:16px">
    <?= Csrf::field() ?>
    <input type="hidden" name="action" value="save_hours">

    <div class="table-wrap">
      <table class="data hours-table">
        <thead>
          <tr>
            <th>Deň</th><th>Otvorené</th><th>Od</th><th>Do</th>
            <th class="hide-sm">Posledná objednávka</th>
          </tr>
        </thead>
        <tbody>
        <?php foreach ($hours as $d): $w = (int) $d['weekday']; ?>
          <tr>
            <td><strong><?= e($d['name']) ?></strong></td>
            <td>
              <label class="check" style="margin:0">
                <input type="checkbox" name="day[<?= $w ?>][is_open]" <?= $d['isOpen'] ? 'checked' : '' ?>>
                <span class="hide-sm">áno</span>
              </label>
            </td>
            <td><input type="time" name="day[<?= $w ?>][open]" value="<?= e($d['openTime']) ?>"></td>
            <td><input type="time" name="day[<?= $w ?>][close]" value="<?= e($d['closeTime']) ?>"></td>
            <td class="hide-sm">
              <input type="number" name="day[<?= $w ?>][last_order]" min="0" max="180"
                     value="<?= (int) $d['lastOrder'] ?>" style="width:90px"> min
            </td>
          </tr>
        <?php endforeach; ?>
        </tbody>
      </table>
    </div>

    <button class="btn btn-lg btn-block" type="submit" style="margin-top:16px">Uložiť hodiny</button>
  </form>
</div>

<div class="card" style="margin-top:16px">
  <h2>Mimoriadne zatvorenie</h2>
  <p class="hint" style="margin-top:6px">
    Dovolenka, sanitárny deň, pokazená fritéza. Počas tohto obdobia sa objednávky
    neprijímajú a zákazník uvidí dôvod aj to, odkedy sme opäť otvorení.
  </p>

  <?php if ($closures !== []): ?>
    <div class="table-wrap" style="margin-top:14px">
      <table class="data">
        <thead><tr><th>Od</th><th>Do</th><th>Dôvod</th><th></th></tr></thead>
        <tbody>
        <?php foreach ($closures as $c): ?>
          <tr>
            <td><?= e(date('j.n.Y H:i', strtotime((string) $c['starts_at']))) ?></td>
            <td><?= e(date('j.n.Y H:i', strtotime((string) $c['ends_at']))) ?></td>
            <td><?= e((string) ($c['reason'] ?? '—')) ?></td>
            <td class="num">
              <form method="post" style="margin:0">
                <?= Csrf::field() ?>
                <input type="hidden" name="action" value="delete_closure">
                <input type="hidden" name="id" value="<?= (int) $c['id'] ?>">
                <button class="btn btn-sm btn-danger" type="submit">Zrušiť</button>
              </form>
            </td>
          </tr>
        <?php endforeach; ?>
        </tbody>
      </table>
    </div>
  <?php else: ?>
    <p class="hint" style="margin-top:12px">Žiadne naplánované zatvorenie.</p>
  <?php endif; ?>

  <form method="post" class="row row-wrap" style="margin-top:16px;gap:12px;align-items:flex-end">
    <?= Csrf::field() ?>
    <input type="hidden" name="action" value="add_closure">
    <label class="field" style="flex:1 1 180px"><span>Od</span>
      <input type="datetime-local" name="starts_at" required></label>
    <label class="field" style="flex:1 1 180px"><span>Do</span>
      <input type="datetime-local" name="ends_at" required></label>
    <label class="field" style="flex:2 1 220px"><span>Dôvod (zákazník ho uvidí)</span>
      <input type="text" name="reason" placeholder="Dovolenka, vrátime sa 15. 8."></label>
    <button class="btn" type="submit">Pridať</button>
  </form>
</div>
<?php layout_end(); ?>
