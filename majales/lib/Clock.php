<?php
declare(strict_types=1);

/** Jednotný zdroj času. Testy si ho vedia posunúť. */
final class Clock
{
    private static ?int $fixed = null;

    public static function freeze(?int $timestamp): void
    {
        self::$fixed = $timestamp;
    }

    public static function timestamp(): int
    {
        return self::$fixed ?? time();
    }

    /** Formát, v ktorom držíme dátumy v databáze (MySQL aj SQLite). */
    public static function now(): string
    {
        return date('Y-m-d H:i:s', self::timestamp());
    }

    public static function at(int $offsetSeconds): string
    {
        return date('Y-m-d H:i:s', self::timestamp() + $offsetSeconds);
    }
}
