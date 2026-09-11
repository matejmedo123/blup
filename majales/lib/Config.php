<?php
declare(strict_types=1);

/**
 * Konfigurácia zo súboru config.php. Na rozdiel od nastavení v databáze
 * sa mení len pri nasadení — heslá, pripojenie, prenos pošty.
 */
final class Config
{
    /** @var array<string,mixed> */
    private static array $data = [];

    /** @param array<string,mixed> $data */
    public static function load(array $data): void
    {
        self::$data = $data;
    }

    /** Cesta s bodkou, napr. `mail.smtp.host`. */
    public static function get(string $path, mixed $default = null): mixed
    {
        $node = self::$data;
        foreach (explode('.', $path) as $key) {
            if (!is_array($node) || !array_key_exists($key, $node)) {
                return $default;
            }
            $node = $node[$key];
        }
        return $node;
    }

    public static function baseUrl(): string
    {
        $url = (string) self::get('app.base_url', '');
        return rtrim($url, '/');
    }
}
