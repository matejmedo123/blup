<?php
declare(strict_types=1);

/**
 * Doplní vývojovej inštancii zástupné fotky, aby sa dali skúšať časti
 * stránky, ktoré sa bez obrázkov nezobrazujú (galéria, logá partnerov).
 */

require __DIR__ . '/../lib/bootstrap.php';

if (Db::driver() !== 'sqlite') {
    exit("Odmietam: toto je určené len pre vývojovú SQLite inštanciu.\n");
}

/** Vyrobí farebný obrázok s popisom, nech sa dá na stránke rozoznať. */
function vyrobFotku(string $popis, int $w, int $h, array $rgb): array
{
    $im = imagecreatetruecolor($w, $h);
    imagefilledrectangle($im, 0, 0, $w, $h, (int) imagecolorallocate($im, ...$rgb));
    for ($i = 0; $i < 18; $i++) {
        imagefilledellipse(
            $im,
            random_int(0, $w),
            random_int(0, $h),
            random_int(60, (int) ($w / 2)),
            random_int(60, (int) ($h / 2)),
            (int) imagecolorallocate($im, random_int(60, 255), random_int(150, 255), random_int(0, 90))
        );
    }
    imagestring($im, 5, 24, 24, $popis, (int) imagecolorallocate($im, 255, 255, 255));

    $tmp = tempnam(sys_get_temp_dir(), 'majfoto');
    imagejpeg($im, $tmp, 86);
    imagedestroy($im);

    return ['name' => Validate::slug($popis) . '.jpg', 'type' => 'image/jpeg',
            'tmp_name' => $tmp, 'error' => UPLOAD_ERR_OK, 'size' => (int) filesize($tmp)];
}

$pridane = 0;

foreach (Gallery::listAll() as $i => $row) {
    if ($row['media_id'] !== null) {
        continue;
    }
    $id = Media::store(vyrobFotku('GALERIA ' . ($i + 1), 1600, 1100, [20 + $i * 30, 110, 180]), (string) $row['caption']);
    Gallery::save((int) $row['id'], ['media_id' => $id]);
    $pridane++;
}

foreach (Zones::listAll() as $i => $row) {
    if ($row['media_id'] !== null) {
        continue;
    }
    $id = Media::store(vyrobFotku('ZONA ' . ($i + 1), 1200, 800, [30, 120 + $i * 20, 190]), (string) $row['title']);
    Zones::save((int) $row['id'], ['media_id' => $id]);
    $pridane++;
}

foreach (Partners::listAll() as $i => $row) {
    if ($row['media_id'] !== null) {
        continue;
    }
    $id = Media::store(vyrobFotku('PARTNER ' . ($i + 1), 800, 400, [240, 240, 240]), (string) $row['name']);
    Partners::save((int) $row['id'], ['media_id' => $id]);
    $pridane++;
}

foreach (Artists::listAll() as $i => $row) {
    if ($row['media_id'] !== null) {
        continue;
    }
    $vyska = (int) $row['is_headliner'] === 1 ? 900 : 1400;
    $id = Media::store(vyrobFotku((string) $row['name'], 1200, $vyska, [15, 80 + ($i % 5) * 22, 150]), (string) $row['name']);
    Artists::save((int) $row['id'], ['media_id' => $id]);
    $pridane++;
}

echo "Doplnených zástupných fotiek: $pridane\n";
