<?php
declare(strict_types=1);

/**
 * robots.txt sa generuje, lebo pred spustením webu sa dá v nastaveniach
 * indexovanie vypnúť — aby sa rozrobená stránka nedostala do Google.
 */

require __DIR__ . '/lib/bootstrap.php';

header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: public, max-age=3600');

$base  = Config::baseUrl();
$index = Settings::bool('robots_index', true);

echo "User-agent: *\n";

if ($index) {
    echo "Disallow: /admin/\n";
    echo "Disallow: /api/\n";
    echo "Disallow: /install.php\n";
} else {
    // Web ešte nie je spustený — nech ho vyhľadávače zatiaľ obídu.
    echo "Disallow: /\n";
}

if ($base !== '' && $index) {
    echo "\nSitemap: {$base}/sitemap.xml\n";
}
