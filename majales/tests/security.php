<?php
declare(strict_types=1);

/**
 * Kontroly, ktoré sa dajú overiť len cez skutočný HTTP server.
 * Spúšťa sa proti bežiacej vývojovej inštancii:
 *   php -S 127.0.0.1:8099 -t . &   php tests/security.php http://127.0.0.1:8099
 *
 * Pozor: zabudovaný server PHP nečíta .htaccess. Ochrany priečinkov
 * preto kontrolujeme staticky (že súbory existujú a sú správne),
 * nie cez odpoveď servera.
 */

$base = rtrim($argv[1] ?? 'http://127.0.0.1:8099', '/');
$root = dirname(__DIR__);

$passed = 0;
$failed = [];

function check(string $what, bool $ok): void
{
    global $passed, $failed;
    if ($ok) {
        $passed++;
        echo "  \033[32m✓\033[0m $what\n";
    } else {
        $failed[] = $what;
        echo "  \033[31m✗ $what\033[0m\n";
    }
}

/** @return array{status:int,headers:string,body:string} */
function get(string $url, array $opts = []): array
{
    $ctx = stream_context_create(['http' => array_merge([
        'method'        => 'GET',
        'ignore_errors' => true,
        'timeout'       => 10,
        'follow_location' => 0,
    ], $opts)]);
    $body = @file_get_contents($url, false, $ctx);
    $headers = implode("\n", $http_response_header ?? []);
    preg_match('#HTTP/\S+\s+(\d{3})#', $headers, $m);
    return ['status' => (int) ($m[1] ?? 0), 'headers' => $headers, 'body' => (string) $body];
}

echo "\n\033[1mOchrana priečinkov (.htaccess)\033[0m\n";
foreach (['lib', 'sql', 'storage', 'tests'] as $dir) {
    $file = $root . '/' . $dir . '/.htaccess';
    $text = is_file($file) ? (string) file_get_contents($file) : '';
    check("$dir/ je zakázaný pre prehliadač", str_contains($text, 'Require all denied'));
}
$up = (string) @file_get_contents($root . '/uploads/.htaccess');
check('uploads/ nespúšťa PHP', str_contains($up, 'engine off') && str_contains($up, 'RemoveHandler'));
$ht = (string) @file_get_contents($root . '/.htaccess');
check('config.php je nedostupný z webu', str_contains($ht, 'config\.php'));
check('databázový súbor je nedostupný z webu', str_contains($ht, 'sqlite'));
check('výpis priečinkov je vypnutý', str_contains($ht, 'Options -Indexes'));
check('web sa presmeruje na HTTPS', str_contains($ht, 'https://%{HTTP_HOST}'));

echo "\n\033[1mHlavičky odpovede\033[0m\n";
$r = get("$base/index.php");
check('stránka sa načíta (200)', $r['status'] === 200);
check('X-Content-Type-Options: nosniff', str_contains($r['headers'], 'nosniff'));
check('Referrer-Policy je nastavená', stripos($r['headers'], 'Referrer-Policy') !== false);
check('X-Frame-Options: SAMEORIGIN', str_contains($r['headers'], 'SAMEORIGIN'));
check('ETag pre cache prehliadača', stripos($r['headers'], 'ETag') !== false);

preg_match('#ETag:\s*(\S+)#i', $r['headers'], $em);
$etag = $em[1] ?? '';
$r304 = get("$base/index.php", ['header' => "If-None-Match: $etag\r\n"]);
check('nezmenená stránka vráti 304', $r304['status'] === 304);

echo "\n\033[1mPrístup do adminu\033[0m\n";
foreach (['dashboard.php', 'obsah.php', 'nastavenia.php', 'media.php', 'pouzivatelia.php',
          'audit.php', 'odberatelia.php', 'zoznam.php?typ=interpreti', 'polozka.php?typ=interpreti'] as $page) {
    $a = get("$base/admin/$page");
    $presmerovane = $a['status'] === 302 && str_contains($a['headers'], 'index.php');
    check("admin/$page bez prihlásenia nepustí ďalej", $presmerovane);
}

echo "\n\033[1mFormuláre bez platného kľúča (CSRF)\033[0m\n";
$post = get("$base/admin/index.php", [
    'method'  => 'POST',
    'header'  => "Content-Type: application/x-www-form-urlencoded\r\n",
    'content' => http_build_query(['username' => 'tester', 'password' => 'x', '_csrf' => 'podvrh']),
]);
check('prihlásenie s podvrhnutým kľúčom je odmietnuté (419)', $post['status'] === 419);

echo "\n\033[1mOdber noviniek\033[0m\n";
$sub = get("$base/api/prihlasit.php", ['method' => 'GET', 'header' => "Accept: application/json\r\n"]);
check('GET na odber je odmietnutý (405)', $sub['status'] === 405);

$zly = get("$base/api/prihlasit.php", [
    'method'  => 'POST',
    'header'  => "Content-Type: application/x-www-form-urlencoded\r\nAccept: application/json\r\n",
    'content' => http_build_query(['email' => 'toto-nie-je-email']),
]);
check('neplatný e-mail je odmietnutý (422)', $zly['status'] === 422);
$data = json_decode($zly['body'], true);
check('odpoveď je JSON s vysvetlením', is_array($data) && isset($data['error']));

$past = get("$base/api/prihlasit.php", [
    'method'  => 'POST',
    'header'  => "Content-Type: application/x-www-form-urlencoded\r\nAccept: application/json\r\n",
    'content' => http_build_query(['email' => 'robot@example.sk', 'website' => 'reklama']),
]);
$pd = json_decode($past['body'], true);
check('vyplnená pascička vyzerá ako úspech, ale nič nezapíše', ($pd['ok'] ?? false) === true);

echo "\n\033[1mVyhľadávače\033[0m\n";
$rob = get("$base/robots.php");
check('robots zakazuje admin', str_contains($rob['body'], 'Disallow: /admin/'));
$sm = get("$base/sitemap.php");
check('sitemap je platné XML', str_starts_with(trim($sm['body']), '<?xml') && str_contains($sm['body'], '<urlset'));

echo "\n\033[1mChybová stránka\033[0m\n";
$nf = get("$base/404.php");
check('404 vracia správny kód', $nf['status'] === 404);

echo "\n" . str_repeat('─', 60) . "\n";
if ($failed === []) {
    echo "\033[32mVšetkých $passed kontrol prešlo.\033[0m\n";
    exit(0);
}
echo "\033[31mPrešlo $passed, zlyhalo " . count($failed) . ":\033[0m\n";
foreach ($failed as $f) {
    echo "  • $f\n";
}
exit(1);
