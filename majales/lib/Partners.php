<?php
declare(strict_types=1);

/** Logá partnerov v spodnej časti stránky. */
final class Partners extends Repo
{
    public static function table(): string
    {
        return 'partners';
    }

    public static function fillable(): array
    {
        return ['name', 'url', 'media_id'];
    }
}
