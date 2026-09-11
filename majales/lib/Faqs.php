<?php
declare(strict_types=1);

/** Časté otázky v rozbaľovacom zozname. */
final class Faqs extends Repo
{
    public static function table(): string
    {
        return 'faqs';
    }

    public static function fillable(): array
    {
        return ['question', 'answer'];
    }
}
