<?php
declare(strict_types=1);

/**
 * Nahrávanie fotiek položiek menu z počítača.
 *
 * Nahranému súboru sa nedá veriť — prípona ani hlavička nič nedokazujú.
 * Preto obrázok načítame cez GD a uložíme nanovo: čo prejde, je naozaj
 * obrázok, a pri prekreslení sa stratí všetko, čo v ňom bolo schované
 * (EXIF, pripojené dáta, kúsky kódu). Zároveň sa zmenší na rozumnú
 * veľkosť, nech sa web nenačítava z desaťmegového telefónneho záberu.
 */
final class ImageUpload
{
    /** Väčší súbor ani neotvárame — na fotku jedla to bohato stačí. */
    private const MAX_BYTES = 8 * 1024 * 1024;

    /** Na webe sa fotka zobrazuje v karte, väčšie rozlíšenie netreba. */
    private const MAX_W = 1200;
    private const MAX_H = 1600;

    private const TYPES = [
        IMAGETYPE_JPEG => 'jpg',
        IMAGETYPE_PNG  => 'png',
        IMAGETYPE_WEBP => 'webp',
    ];

    /** Kam sa smie nahrávať. Voľný priečinok by bol diera. */
    private const FOLDERS = ['products', 'editorial'];

    /** Priečinok s fotkami vo webovom koreni (vedľa `admin/` a `api/`). */
    public static function dir(string $folder = 'products'): string
    {
        $folder = in_array($folder, self::FOLDERS, true) ? $folder : 'products';
        return dirname(__DIR__, 2) . '/images/' . $folder;
    }

    /**
     * Uloží nahranú fotku a vráti cestu, ktorá patrí do databázy.
     *
     * @param array{name?:string,type?:string,tmp_name?:string,error?:int,size?:int} $file
     * @return array{ok:bool,path:?string,error:?string}
     */
    public static function store(array $file, string $slug, string $folder = 'products'): array
    {
        $err = (int) ($file['error'] ?? UPLOAD_ERR_NO_FILE);
        if ($err === UPLOAD_ERR_NO_FILE) {
            return self::fail('Nevybral si žiadny súbor.');
        }
        if ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE) {
            return self::fail('Fotka je príliš veľká. Skús menšiu alebo ju zmenši.');
        }
        if ($err !== UPLOAD_ERR_OK) {
            return self::fail('Nahrávanie sa nepodarilo (kód ' . $err . ').');
        }

        $tmp = (string) ($file['tmp_name'] ?? '');
        if ($tmp === '' || !is_uploaded_file($tmp)) {
            return self::fail('Súbor sa nedoručil celý. Skús to znova.');
        }
        if ((int) ($file['size'] ?? 0) > self::MAX_BYTES) {
            return self::fail('Fotka má viac než 8 MB. Skús menšiu.');
        }

        $info = @getimagesize($tmp);
        if ($info === false || !isset(self::TYPES[$info[2]])) {
            return self::fail('Toto nie je obrázok. Podporujeme JPG, PNG a WebP.');
        }

        $dir = self::dir($folder);
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            return self::fail('Priečinok images/' . basename($dir) . ' sa nedá vytvoriť.');
        }
        if (!is_writable($dir)) {
            return self::fail('Do priečinka images/' . basename($dir) . ' sa nedá zapisovať — skontroluj práva.');
        }

        $base = preg_replace('/[^a-z0-9-]+/', '-', mb_strtolower($slug !== '' ? $slug : 'fotka')) ?: 'fotka';
        $base = trim($base, '-') ?: 'fotka';

        $saved = self::reencode($tmp, $info[2], $dir, $base);
        if ($saved === null) {
            return self::fail('Obrázok sa nepodarilo spracovať. Skús iný súbor.');
        }

        self::protectDir($dir);
        return ['ok' => true, 'path' => '/images/' . basename($dir) . '/' . $saved, 'error' => null];
    }

    /**
     * Zmaže starú fotku, ale len ak je naša a nepoužíva ju iná položka.
     * Cudziu cestu (napr. ručne zadanú) nechávame na pokoji.
     */
    public static function discard(?string $path, int $keepProductId = 0): void
    {
        $path = trim((string) $path);
        $name = basename($path);
        if ($name === '' || str_contains($name, '..')) {
            return;
        }

        $folder = null;
        foreach (self::FOLDERS as $f) {
            if (str_starts_with($path, '/images/' . $f . '/')) {
                $folder = $f;
            }
        }
        if ($folder === null) {
            return; // cudziu cestu (napr. ručne zadanú) nechávame na pokoji
        }

        // Mažeme len to, čo sme sami nahrali — poznáme to podľa náhodnej
        // prípony v názve. Fotky, ktoré prišli v balíku, ostávajú: keby
        // sa niekto vrátil k pôvodnej ceste, súbor tam ešte je.
        if (preg_match('/-[0-9a-f]{6}\.(webp|jpg)$/', $name) !== 1) {
            return;
        }

        // Fotku nikdy nemažeme, kým na ňu ešte niečo ukazuje.
        $used = (int) Db::value(
            'SELECT COUNT(*) FROM products WHERE image = ? AND id <> ?',
            [$path, $keepProductId]
        );
        $used += (int) Db::value('SELECT COUNT(*) FROM settings WHERE value = ?', [$path]);
        if ($used > 0) {
            return;
        }
        @unlink(self::dir($folder) . '/' . $name);
    }

    /** Načíta obrázok, zmenší ho a uloží ako WebP (alebo JPEG, keď WebP nie je). */
    private static function reencode(string $tmp, int $type, string $dir, string $base): ?string
    {
        $src = match ($type) {
            IMAGETYPE_JPEG => @imagecreatefromjpeg($tmp),
            IMAGETYPE_PNG  => @imagecreatefrompng($tmp),
            IMAGETYPE_WEBP => function_exists('imagecreatefromwebp') ? @imagecreatefromwebp($tmp) : false,
            default        => false,
        };
        if (!$src instanceof GdImage) {
            return null;
        }

        [$w, $h] = [imagesx($src), imagesy($src)];
        $scale = min(1.0, self::MAX_W / max(1, $w), self::MAX_H / max(1, $h));
        if ($scale < 1.0) {
            $resized = imagescale($src, (int) round($w * $scale), (int) round($h * $scale));
            if ($resized instanceof GdImage) {
                imagedestroy($src);
                $src = $resized;
            }
        }

        $webp = function_exists('imagewebp');
        $ext  = $webp ? 'webp' : 'jpg';
        $name = $base . '-' . bin2hex(random_bytes(3)) . '.' . $ext;
        $dest = $dir . '/' . $name;

        // Priehľadnosť by po prevode na JPEG zčernela, tak ju podložíme.
        if (!$webp) {
            $flat = imagecreatetruecolor(imagesx($src), imagesy($src));
            imagefill($flat, 0, 0, imagecolorallocate($flat, 255, 255, 255));
            imagecopy($flat, $src, 0, 0, 0, 0, imagesx($src), imagesy($src));
            imagedestroy($src);
            $src = $flat;
        }

        $ok = $webp ? @imagewebp($src, $dest, 82) : @imagejpeg($src, $dest, 86);
        imagedestroy($src);

        if (!$ok || !is_file($dest)) {
            return null;
        }
        @chmod($dest, 0644);
        return $name;
    }

    /**
     * Do priečinka s fotkami nikdy nemá čo spúšťať skript. Keby sa tam
     * predsa len niečo dostalo, server to nesmie vykonať.
     */
    private static function protectDir(string $dir): void
    {
        $file = $dir . '/.htaccess';
        if (is_file($file)) {
            return;
        }
        @file_put_contents($file, "# Sem patria len obrázky — nič sa tu nespúšťa.\nphp_flag engine off\n"
            . "<FilesMatch \"\\.(php|phtml|phar|cgi|pl)$\">\n  Require all denied\n</FilesMatch>\n");
    }

    /** @return array{ok:bool,path:?string,error:?string} */
    private static function fail(string $message): array
    {
        return ['ok' => false, 'path' => null, 'error' => $message];
    }
}
