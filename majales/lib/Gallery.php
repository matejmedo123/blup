<?php
declare(strict_types=1);

/** Fotogaléria nad sekciou zón. Fotky sa dajú otvoriť na celú obrazovku. */
final class Gallery extends Repo
{
    public static function table(): string
    {
        return 'gallery';
    }

    public static function fillable(): array
    {
        return ['media_id', 'caption'];
    }

    /**
     * Na webe ukazujeme len položky, ktoré naozaj majú fotku — prázdny
     * rámček by v rozsypanej mriežke pôsobil ako chyba.
     *
     * @return list<array<string,mixed>>
     */
    public static function withPhotos(): array
    {
        return Db::all(
            'SELECT g.*, m.path, m.alt, m.width, m.height
               FROM gallery g JOIN media m ON m.id = g.media_id
              WHERE g.active = 1
              ORDER BY g.sort_order, g.id'
        );
    }
}
