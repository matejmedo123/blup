<?php
declare(strict_types=1);

/**
 * Pomocníci pre šablónu verejnej stránky. Držia dokopy veci, ktoré by
 * inak zamorili HTML — odpočet, obrázky s náhradným rámčekom, SEO značky.
 */
final class Page
{
    /**
     * Rozklad odpočtu na dni/hodiny/minúty/sekundy. Server pošle prvé
     * hodnoty priamo v HTML, aby odpočet nebliknul; JavaScript ich
     * potom prepisuje každú sekundu.
     *
     * @return array{days:string,hours:string,mins:string,secs:string,over:bool}
     */
    public static function countdown(string $target): array
    {
        $ts   = strtotime($target);
        $diff = $ts === false ? 0 : max(0, $ts - Clock::timestamp());

        $d = intdiv($diff, 86400);
        $h = intdiv($diff % 86400, 3600);
        $m = intdiv($diff % 3600, 60);
        $s = $diff % 60;

        return [
            'days'  => (string) $d,
            'hours' => str_pad((string) $h, 2, '0', STR_PAD_LEFT),
            'mins'  => str_pad((string) $m, 2, '0', STR_PAD_LEFT),
            'secs'  => str_pad((string) $s, 2, '0', STR_PAD_LEFT),
            'over'  => $diff === 0,
        ];
    }

    /**
     * Obrázok z knižnice médií. Keď ešte nie je nahratý, na jeho mieste
     * ostane rámček s popisom — stránka tak drží rozloženie a obsluha
     * hneď vidí, čo treba doplniť.
     */
    public static function image(?int $mediaId, string $class, string $placeholder, string $alt = '', bool $lazy = true): string
    {
        $m = Media::find($mediaId);
        if ($m === null) {
            return '<div class="slot ' . Html::attr($class) . '">' . Html::e($placeholder) . '</div>';
        }
        $altText = $alt !== '' ? $alt : (string) $m['alt'];
        return '<img class="' . Html::attr($class) . '" src="' . Html::attr(self::asset((string) $m['path'])) . '"'
            . ' width="' . (int) $m['width'] . '" height="' . (int) $m['height'] . '"'
            . ' alt="' . Html::attr($altText) . '"'
            . ($lazy ? ' loading="lazy" decoding="async"' : '') . '>';
    }

    /** Adresa súboru s číslom verzie, aby prehliadač po zmene načítal nový. */
    public static function asset(string $relative): string
    {
        $relative = ltrim($relative, '/');
        $file = MAJALES_ROOT . '/' . $relative;
        $stamp = is_file($file) ? (string) filemtime($file) : Settings::get('content_version', '1');
        return $relative . '?v=' . substr(md5($stamp), 0, 8);
    }

    /** Text bežiaceho pásu — opakuje sa, aby slučka nemala prázdne miesto. */
    public static function marqueeText(string $text, int $repeat = 3): string
    {
        $text = trim($text);
        if ($text === '') {
            return '';
        }
        return implode(' ▪ ', array_fill(0, max(1, $repeat), $text)) . " ▪\u{00A0}";
    }

    /** Vložená mapa Google. Adresa ide cez urlencode, nie priamo do HTML. */
    public static function mapEmbedUrl(): string
    {
        $q = Settings::get('maps_embed_query', 'Agrokomplex, Nitra');
        return 'https://www.google.com/maps?q=' . urlencode($q) . '&output=embed';
    }

    /**
     * Štruktúrované dáta pre vyhľadávače — festival ako udalosť.
     * Vďaka nim môže Google ukázať dátum a miesto priamo vo výsledkoch.
     */
    public static function jsonLd(): string
    {
        $base  = Config::baseUrl();
        $start = strtotime(Settings::get('event_start', '')) ?: null;
        $end   = strtotime(Settings::get('event_end', '')) ?: null;

        $performers = [];
        foreach (array_merge(
            Artists::headliner() !== null ? [Artists::headliner()] : [],
            Artists::grid()
        ) as $a) {
            $performers[] = ['@type' => 'MusicGroup', 'name' => (string) $a['name']];
        }

        $data = [
            '@context'  => 'https://schema.org',
            '@type'     => 'MusicFestival',
            'name'      => Settings::get('site_title', 'Majáles Nitra'),
            'description' => Settings::get('meta_description', ''),
            'eventStatus' => 'https://schema.org/EventScheduled',
            'eventAttendanceMode' => 'https://schema.org/OfflineEventAttendanceMode',
            'location'  => [
                '@type'   => 'Place',
                'name'    => Settings::get('venue_name', 'Areál Agrokomplex'),
                'address' => [
                    '@type'           => 'PostalAddress',
                    'streetAddress'   => Settings::get('venue_address', ''),
                    'addressLocality' => 'Nitra',
                    'addressCountry'  => 'SK',
                ],
            ],
            'organizer' => [
                '@type' => 'Organization',
                'name'  => Settings::get('site_title', 'Majáles Nitra'),
                'email' => Settings::get('contact_email', ''),
                'url'   => $base,
            ],
        ];
        if ($base !== '') {
            $data['url'] = $base . '/';
        }
        if ($start !== null) {
            $data['startDate'] = date('c', $start);
        }
        if ($end !== null) {
            $data['endDate'] = date('c', $end);
        }
        if ($performers !== []) {
            $data['performer'] = $performers;
        }

        $offerUrl = Html::safeUrl(Settings::get('tickets_url', ''));
        if (Tickets::saleLive()) {
            $offers = [];
            foreach (Tickets::published() as $t) {
                $offer = [
                    '@type'         => 'Offer',
                    'name'          => (string) $t['title'],
                    'availability'  => 'https://schema.org/InStock',
                    'url'           => Tickets::buyUrl($t) ?: ($offerUrl ?: $base),
                    'priceCurrency' => 'EUR',
                ];
                if ($t['price_cents'] !== null && $t['price_cents'] !== '') {
                    $offer['price'] = number_format((int) $t['price_cents'] / 100, 2, '.', '');
                }
                $offers[] = $offer;
            }
            if ($offers !== []) {
                $data['offers'] = $offers;
            }
        }

        $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        // `</script>` vnútri JSON by predčasne ukončil blok.
        return str_replace('</', '<\/', (string) $json);
    }

    /**
     * Značka pre prehliadač, aby stránku nesťahoval znova, kým sa obsah
     * nezmenil. Verzia sa zvýši pri každej zmene v admine.
     */
    public static function sendCacheHeaders(): void
    {
        if (PHP_SAPI === 'cli' || headers_sent()) {
            return;
        }
        $etag = '"majales-' . Settings::get('content_version', '1') . '"';
        header('ETag: ' . $etag);
        header('Cache-Control: public, max-age=0, must-revalidate');

        $sent = trim((string) ($_SERVER['HTTP_IF_NONE_MATCH'] ?? ''));
        if ($sent !== '' && $sent === $etag) {
            http_response_code(304);
            exit;
        }
    }

    /** Bezpečnostné hlavičky. Stránka nenačítava cudzí kód okrem písiem a mapy. */
    public static function sendSecurityHeaders(): void
    {
        if (PHP_SAPI === 'cli' || headers_sent()) {
            return;
        }
        header('X-Content-Type-Options: nosniff');
        header('Referrer-Policy: strict-origin-when-cross-origin');
        header('X-Frame-Options: SAMEORIGIN');
        header('Permissions-Policy: geolocation=(), microphone=(), camera=()');
    }
}
