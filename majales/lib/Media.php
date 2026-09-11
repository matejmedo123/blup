<?php
declare(strict_types=1);

/**
 * Nahrávanie fotiek. Obrázok sa nikdy neuloží tak, ako prišiel:
 * prekreslí sa cez GD, čím sa z neho zároveň odstráni všetko, čo
 * nie je obrazový obsah (vložený kód, EXIF s polohou).
 */
final class Media
{
    private const TYPES = [
        IMAGETYPE_JPEG => 'image/jpeg',
        IMAGETYPE_PNG  => 'image/png',
        IMAGETYPE_WEBP => 'image/webp',
        IMAGETYPE_GIF  => 'image/gif',
    ];

    public static function dir(): string
    {
        return MAJALES_ROOT . '/uploads';
    }

    /** @return list<array<string,mixed>> */
    public static function listAll(int $limit = 500): array
    {
        return Db::all('SELECT * FROM media ORDER BY id DESC LIMIT ' . max(1, min(2000, $limit)));
    }

    /** @var array<int,array<string,mixed>|null> */
    private static array $cache = [];

    /**
     * Jeden obrázok. Stránka sa na ten istý pýta viackrát (karta, lightbox,
     * OG značka), preto si ho v rámci požiadavky pamätáme.
     *
     * @return array<string,mixed>|null
     */
    public static function find(?int $id): ?array
    {
        if ($id === null || $id <= 0) {
            return null;
        }
        if (!array_key_exists($id, self::$cache)) {
            self::$cache[$id] = Db::one('SELECT * FROM media WHERE id = ?', [$id]);
        }
        return self::$cache[$id];
    }

    public static function forget(): void
    {
        self::$cache = [];
    }

    /** Adresa obrázka pre stránku, alebo prázdny reťazec. */
    public static function url(?int $id): string
    {
        $m = self::find($id);
        return $m === null ? '' : (string) $m['path'];
    }

    /** Menší náhľad do admin zoznamov. */
    public static function thumbUrl(?int $id): string
    {
        $m = self::find($id);
        if ($m === null) {
            return '';
        }
        return (string) ($m['thumb_path'] ?: $m['path']);
    }

    /**
     * Spracuje jeden súbor z `$_FILES` a vráti id nového záznamu.
     *
     * @param array<string,mixed> $file položka z $_FILES
     * @throws RuntimeException so slovenskou hláškou pre obsluhu
     */
    public static function store(array $file, string $alt = ''): int
    {
        $err = (int) ($file['error'] ?? UPLOAD_ERR_NO_FILE);
        if ($err === UPLOAD_ERR_NO_FILE) {
            throw new RuntimeException('Nevybral si žiadny súbor.');
        }
        if ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE) {
            throw new RuntimeException('Súbor je príliš veľký pre nastavenia hostingu.');
        }
        if ($err !== UPLOAD_ERR_OK) {
            throw new RuntimeException('Súbor sa nepodarilo nahrať (kód ' . $err . ').');
        }

        $tmp = (string) $file['tmp_name'];
        if (PHP_SAPI !== 'cli' && !is_uploaded_file($tmp)) {
            throw new RuntimeException('Neplatné nahrávanie súboru.');
        }

        $maxBytes = (int) Config::get('uploads.max_bytes', 12 * 1024 * 1024);
        $size     = (int) filesize($tmp);
        if ($size > $maxBytes) {
            throw new RuntimeException('Fotka má viac ako ' . round($maxBytes / 1048576) . ' MB. Zmenši ju a skús znova.');
        }

        $info = @getimagesize($tmp);
        if ($info === false || !isset(self::TYPES[$info[2]])) {
            throw new RuntimeException('Nahraj obrázok vo formáte JPG, PNG, WEBP alebo GIF.');
        }
        [$srcW, $srcH, $type] = $info;
        if ($srcW < 1 || $srcH < 1 || $srcW * $srcH > 60_000_000) {
            throw new RuntimeException('Rozmery obrázka sú mimo rozsahu.');
        }

        $img = self::load($tmp, (int) $type);
        if ($img === null) {
            throw new RuntimeException('Obrázok sa nepodarilo načítať.');
        }

        try {
            $maxW   = (int) Config::get('uploads.max_width', 2000);
            $maxH   = (int) Config::get('uploads.max_height', 2000);
            $thumbW = (int) Config::get('uploads.thumb_width', 480);
            $q      = (int) Config::get('uploads.webp_quality', 82);

            if (!is_dir(self::dir())) {
                mkdir(self::dir(), 0775, true);
            }

            $base  = self::baseName((string) ($file['name'] ?? 'foto'));
            $stamp = date('Ymd-His', Clock::timestamp());
            $name  = $stamp . '-' . $base . '-' . bin2hex(random_bytes(3));

            $full  = self::fit($img, $maxW, $maxH);
            $thumb = self::fit($img, $thumbW, $thumbW * 3);

            $fullPath  = self::dir() . '/' . $name . '.webp';
            $thumbPath = self::dir() . '/' . $name . '-nahlad.webp';
            imagewebp($full, $fullPath, $q);
            imagewebp($thumb, $thumbPath, 76);

            $outW = imagesx($full);
            $outH = imagesy($full);
            imagedestroy($full);
            imagedestroy($thumb);
            @chmod($fullPath, 0644);
            @chmod($thumbPath, 0644);

            $newId = Db::insert('media', [
                'path'          => 'uploads/' . $name . '.webp',
                'thumb_path'    => 'uploads/' . $name . '-nahlad.webp',
                'original_name' => mb_substr((string) ($file['name'] ?? ''), 0, 255),
                'mime'          => 'image/webp',
                'width'         => $outW,
                'height'        => $outH,
                'size_bytes'    => (int) filesize($fullPath),
                'alt'           => mb_substr($alt, 0, 255),
                'created_at'    => Clock::now(),
            ]);
            Settings::bumpContentVersion();
            return $newId;
        } finally {
            imagedestroy($img);
        }
    }

    public static function setAlt(int $id, string $alt): void
    {
        Db::update('media', $id, ['alt' => mb_substr($alt, 0, 255)]);
        unset(self::$cache[$id]);
        Settings::bumpContentVersion();
    }

    /**
     * Zmaže obrázok aj súbory na disku. Miesta, kde bol použitý,
     * ostanú — cudzí kľúč tam nastaví prázdnu hodnotu a v admine
     * sa ukáže prázdny rámček.
     */
    public static function remove(int $id): void
    {
        $m = self::find($id);
        if ($m === null) {
            return;
        }
        Db::delete('media', $id);
        unset(self::$cache[$id]);
        foreach ([$m['path'], $m['thumb_path']] as $rel) {
            if (!is_string($rel) || $rel === '') {
                continue;
            }
            $path = MAJALES_ROOT . '/' . $rel;
            if (is_file($path) && str_starts_with(realpath($path) ?: '', realpath(self::dir()) ?: 'x')) {
                @unlink($path);
            }
        }
        Settings::bumpContentVersion();
    }

    /** @return int koľko obrázkov nie je nikde použitých */
    public static function unusedCount(): int
    {
        return (int) Db::value(
            'SELECT COUNT(*) FROM media m
              WHERE NOT EXISTS (SELECT 1 FROM artists  a WHERE a.media_id = m.id)
                AND NOT EXISTS (SELECT 1 FROM zones    z WHERE z.media_id = m.id)
                AND NOT EXISTS (SELECT 1 FROM gallery  g WHERE g.media_id = m.id)
                AND NOT EXISTS (SELECT 1 FROM partners p WHERE p.media_id = m.id)'
        );
    }

    private static function load(string $path, int $type): ?GdImage
    {
        $img = match ($type) {
            IMAGETYPE_JPEG => @imagecreatefromjpeg($path),
            IMAGETYPE_PNG  => @imagecreatefrompng($path),
            IMAGETYPE_WEBP => @imagecreatefromwebp($path),
            IMAGETYPE_GIF  => @imagecreatefromgif($path),
            default        => false,
        };
        if (!$img instanceof GdImage) {
            return null;
        }
        // Fotky z telefónu bývajú otočené len značkou v EXIF.
        if ($type === IMAGETYPE_JPEG && function_exists('exif_read_data')) {
            $exif = @exif_read_data($path);
            $rot  = match ((int) ($exif['Orientation'] ?? 1)) {
                3       => 180,
                6       => -90,
                8       => 90,
                default => 0,
            };
            if ($rot !== 0) {
                $rotated = imagerotate($img, $rot, 0);
                if ($rotated instanceof GdImage) {
                    imagedestroy($img);
                    $img = $rotated;
                }
            }
        }
        return $img;
    }

    /** Zmenší obrázok do zadaného rámca, nikdy ho nezväčšuje. */
    private static function fit(GdImage $src, int $maxW, int $maxH): GdImage
    {
        $w = imagesx($src);
        $h = imagesy($src);
        $scale = min(1.0, $maxW / $w, $maxH / $h);
        $tw = max(1, (int) round($w * $scale));
        $th = max(1, (int) round($h * $scale));

        $dst = imagecreatetruecolor($tw, $th);
        imagealphablending($dst, false);
        imagesavealpha($dst, true);
        imagefill($dst, 0, 0, (int) imagecolorallocatealpha($dst, 0, 0, 0, 127));
        imagecopyresampled($dst, $src, 0, 0, 0, 0, $tw, $th, $w, $h);
        return $dst;
    }

    private static function baseName(string $original): string
    {
        $name = pathinfo($original, PATHINFO_FILENAME);
        $slug = Validate::slug($name !== '' ? $name : 'foto');
        return mb_substr($slug, 0, 60);
    }
}
