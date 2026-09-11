<?php
declare(strict_types=1);

/** Mapa stránok pre vyhľadávače. Web je jednostránkový, s kotvami. */

require __DIR__ . '/lib/bootstrap.php';

header('Content-Type: application/xml; charset=utf-8');
header('Cache-Control: public, max-age=3600');

$base = Config::baseUrl();
if ($base === '') {
    http_response_code(503);
    exit('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
}

// Dátum poslednej zmeny berieme z obsahu — sitemapa tak nelže.
$last = Db::value(
    'SELECT MAX(t) FROM (
        SELECT MAX(updated_at) AS t FROM artists
        UNION ALL SELECT MAX(updated_at) FROM tickets
        UNION ALL SELECT MAX(updated_at) FROM faqs
        UNION ALL SELECT MAX(updated_at) FROM zones
        UNION ALL SELECT MAX(updated_at) FROM partners
        UNION ALL SELECT MAX(updated_at) FROM blocks
        UNION ALL SELECT MAX(updated_at) FROM settings
     ) x'
);
$lastmod = is_string($last) && $last !== '' ? date('Y-m-d', strtotime($last) ?: Clock::timestamp()) : date('Y-m-d');

echo '<?xml version="1.0" encoding="UTF-8"?>' . "\n";
echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' . "\n";
echo "  <url>\n";
echo '    <loc>' . Html::e($base) . "/</loc>\n";
echo '    <lastmod>' . Html::e($lastmod) . "</lastmod>\n";
echo "    <changefreq>weekly</changefreq>\n";
echo "    <priority>1.0</priority>\n";
echo "  </url>\n";
echo '</urlset>' . "\n";
