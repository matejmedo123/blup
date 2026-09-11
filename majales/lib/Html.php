<?php
declare(strict_types=1);

/**
 * Výstup do HTML. Všetko, čo ide z databázy na stránku, prechádza
 * cez `e()` — obsah píše obsluha v admine a nikdy sa nevkladá surový.
 */
final class Html
{
    public static function e(?string $value): string
    {
        return htmlspecialchars($value ?? '', ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    public static function attr(?string $value): string
    {
        return self::e($value);
    }

    /**
     * Viacriadkový text z adminu na odseky. Prázdny riadok začína nový
     * odsek, jednoduchý zlom riadku ostáva zlomom.
     */
    public static function paragraphs(?string $text, string $class = ''): string
    {
        $text = trim((string) $text);
        if ($text === '') {
            return '';
        }
        $cls = $class !== '' ? ' class="' . self::attr($class) . '"' : '';
        $out = '';
        foreach (preg_split('/\R{2,}/', $text) ?: [] as $para) {
            $para = trim($para);
            if ($para === '') {
                continue;
            }
            $out .= '<p' . $cls . '>' . nl2br(self::e($para)) . '</p>';
        }
        return $out;
    }

    /** @return list<string> riadky textu bez prázdnych */
    public static function lines(?string $text): array
    {
        $out = [];
        foreach (preg_split('/\R/', (string) $text) ?: [] as $line) {
            $line = trim($line);
            if ($line !== '') {
                $out[] = $line;
            }
        }
        return $out;
    }

    /**
     * Odkaz od obsluhy. Pustí len http(s) a mailto — nikdy `javascript:`.
     */
    public static function safeUrl(?string $url): string
    {
        $url = trim((string) $url);
        if ($url === '') {
            return '';
        }
        if (str_starts_with($url, '/') || str_starts_with($url, '#')) {
            return $url;
        }
        $scheme = strtolower((string) parse_url($url, PHP_URL_SCHEME));
        return in_array($scheme, ['http', 'https', 'mailto'], true) ? $url : '';
    }
}
