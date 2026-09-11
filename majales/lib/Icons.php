<?php
declare(strict_types=1);

/** Ikony sociálnych sietí ako vložené SVG — bez externej knižnice. */
final class Icons
{
    private const PATHS = [
        'facebook'  => '<path d="M22 12a10 10 0 1 0-11.6 9.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.3c-1.2 0-1.6.8-1.6 1.6V12h2.8l-.4 2.9h-2.4v7A10 10 0 0 0 22 12Z"/>',
        'spotify'   => '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.3 14.5a.7.7 0 0 1-1 .2c-2.6-1.6-5.9-2-9.8-1.1a.7.7 0 0 1-.3-1.4c4.2-1 7.9-.5 10.8 1.3.3.2.4.7.3 1Zm1.2-2.7a.9.9 0 0 1-1.2.3c-3-1.8-7.5-2.4-11-1.3a.9.9 0 0 1-.5-1.7c4-1.2 9-.6 12.4 1.5.4.2.5.8.3 1.2Zm.1-2.9c-3.5-2.1-9.4-2.3-12.8-1.3a1 1 0 0 1-.6-2c3.9-1.2 10.4-1 14.5 1.4a1 1 0 0 1-1.1 1.9Z"/>',
        'youtube'   => '<path d="M23 7.2s-.2-1.6-.9-2.3c-.9-.9-1.9-.9-2.3-1C16.6 3.6 12 3.6 12 3.6s-4.6 0-7.8.3c-.4.1-1.4.1-2.3 1-.7.7-.9 2.3-.9 2.3S.8 9.1.8 11v1.8c0 1.9.2 3.8.2 3.8s.2 1.6.9 2.3c.9.9 2 .9 2.5 1 1.8.2 7.6.3 7.6.3s4.6 0 7.8-.4c.4-.1 1.4-.1 2.3-1 .7-.7.9-2.3.9-2.3s.2-1.9.2-3.8V11c0-1.9-.2-3.8-.2-3.8ZM9.7 15V8.4l6.1 3.3-6.1 3.3Z"/>',
        'tiktok'    => '<path d="M16.6 5.82A4.28 4.28 0 0 1 15.54 3h-3.09v12.4a2.59 2.59 0 1 1-2.59-2.59c.27 0 .53.04.77.12V9.77a5.76 5.76 0 0 0-.77-.05 5.66 5.66 0 1 0 5.66 5.66V9.01a7.35 7.35 0 0 0 4.3 1.38V7.3a4.28 4.28 0 0 1-3.22-1.48Z"/>',
    ];

    private const LABELS = [
        'facebook'  => 'Facebook',
        'instagram' => 'Instagram',
        'spotify'   => 'Spotify',
        'youtube'   => 'YouTube',
        'tiktok'    => 'TikTok',
    ];

    public static function label(string $name): string
    {
        return self::LABELS[$name] ?? ucfirst($name);
    }

    public static function exists(string $name): bool
    {
        return $name === 'instagram' || isset(self::PATHS[$name]);
    }

    /** Vykreslí ikonu. Značka `aria-hidden` — popis nesie odkaz okolo nej. */
    public static function svg(string $name, int $size = 26, string $color = '#FFF200'): string
    {
        $s = (string) $size;
        $c = Html::attr($color);

        // Instagram je obrys, nie plocha — kreslí sa ťahom.
        if ($name === 'instagram') {
            return '<svg width="' . $s . '" height="' . $s . '" viewBox="0 0 24 24" fill="none" stroke="' . $c
                . '" stroke-width="2" aria-hidden="true" focusable="false">'
                . '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/>'
                . '<circle cx="17.2" cy="6.8" r="1.2" fill="' . $c . '" stroke="none"/></svg>';
        }
        if (!isset(self::PATHS[$name])) {
            return '';
        }
        return '<svg width="' . $s . '" height="' . $s . '" viewBox="0 0 24 24" fill="' . $c
            . '" aria-hidden="true" focusable="false">' . self::PATHS[$name] . '</svg>';
    }

    /**
     * Riadok odkazov na siete.
     *
     * @param list<array{0:string,1:string}> $links dvojice [sieť, adresa]
     */
    public static function row(array $links, int $size = 26, string $color = '#FFF200'): string
    {
        $out = '';
        foreach ($links as [$net, $url]) {
            if (!self::exists($net)) {
                continue;
            }
            $out .= '<a href="' . Html::attr($url) . '" target="_blank" rel="noopener noreferrer">'
                . '<span class="vh">' . Html::e(self::label($net)) . '</span>'
                . self::svg($net, $size, $color) . '</a>';
        }
        return $out;
    }
}
