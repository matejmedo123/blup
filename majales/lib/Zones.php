<?php
declare(strict_types=1);

/** Karty v sekcii „Viac než koncerty". */
final class Zones extends Repo
{
    public static function table(): string
    {
        return 'zones';
    }

    public static function fillable(): array
    {
        return ['title', 'description', 'media_id'];
    }
}
