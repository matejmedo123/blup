<?php
declare(strict_types=1);

/**
 * Testy backendu. Spúšťa sa `php tests/run.php` (alebo `npm run test:php`
 * v koreni repozitára).
 */

require __DIR__ . '/bootstrap.php';

freshInstall();

// ---------------------------------------------------------------- Inštalácia

T::group('Inštalácia a počiatočný obsah');
T::ok(Installer::isInstalled(), 'web je nainštalovaný');
T::same(11, Artists::count(), 'nahralo sa 11 interpretov');
T::same('VENGABOYS', (string) (Artists::headliner()['name'] ?? ''), 'headliner je Vengaboys');
T::same(10, count(Artists::grid()), 'v mriežke je zvyšných 10');
T::same(3, Tickets::count(), 'tri typy vstupeniek');
T::same(4, Faqs::count(), 'štyri časté otázky');
T::same(4, Zones::count(), 'štyri zóny');
T::same(4, Partners::count(), 'štyria partneri');
T::ok(Blocks::get('intro_heading') !== '', 'texty stránky sú naplnené');

$znova = Installer::seed();
T::same(0, array_sum($znova), 'opakované naplnenie nič nezduplikuje');

T::throws(
    static fn () => Installer::createFirstAdmin('iny', 'HesloHesloHeslo'),
    'druhý „prvý správca" sa nevytvorí',
    'už existuje'
);

// ------------------------------------------------------------------ Migrácie

T::group('Migrácie');
$sql = "-- komentár s bodkočiarkou ; vnútri\nCREATE TABLE a (x INT);\n\nINSERT INTO a VALUES (1);";
T::same(2, count(Migrations::splitStatements($sql)), 'komentár nerozbije delenie príkazov');
T::same([], Migrations::run(), 'druhé spustenie migrácií už nič nerobí');

// --------------------------------------------------------------- Prihlásenie

T::group('Prihlásenie do adminu');
T::ok(Auth::attempt('tester', 'TestovacieHeslo123') !== null, 'správne heslo prejde');
T::ok(Auth::attempt('tester', 'TestovacieHeslo124') === null, 'zlé heslo neprejde');
T::ok(Auth::attempt('neexistuje', 'TestovacieHeslo123') === null, 'neexistujúce meno neprejde');

$hash = (string) Db::value('SELECT password_hash FROM users WHERE username = ?', ['tester']);
T::ok(!str_contains($hash, 'TestovacieHeslo123'), 'heslo nie je uložené v čitateľnej podobe');
T::ok(password_verify('TestovacieHeslo123', $hash), 'heslo je hashované overiteľne');

$vypnuty = Auth::createUser('vypnuty', 'DlheHeslo12345', Auth::ROLE_EDITOR);
Db::update('users', $vypnuty, ['active' => 0]);
T::ok(Auth::attempt('vypnuty', 'DlheHeslo12345') === null, 'vypnutý používateľ sa neprihlási');

// ----------------------------------------------------------------- Vstupenky

T::group('Vstupenky a ceny');
$listok = Tickets::published()[0];
Settings::set('sale_live', '0');
T::same('ČOSKORO', Tickets::priceLabel($listok), 'pred spustením predaja je nápis ČOSKORO');

Tickets::save((int) $listok['id'], ['price_cents' => 2490]);
$listok = Tickets::find((int) $listok['id']);
T::same('ČOSKORO', Tickets::priceLabel($listok), 'cena sa neukáže, kým predaj nebeží');
T::same('', Tickets::buyUrl($listok), 'tlačidlo na kúpu sa pred spustením nezobrazí');

Settings::set('sale_live', '1');
T::same("24,90\u{00A0}€", Tickets::priceLabel($listok), 'po spustení sa ukáže cena');

$bezCeny = Tickets::published()[2];
T::same('V PREDAJI', Tickets::priceLabel($bezCeny), 'bez zadanej ceny je nápis V PREDAJI');

Settings::set('tickets_url', 'https://predaj.sk/majales');
T::same('https://predaj.sk/majales', Tickets::buyUrl($listok), 'použije sa spoločný odkaz z nastavení');
Tickets::save((int) $listok['id'], ['buy_url' => 'https://vlastny.sk/listok']);
T::same('https://vlastny.sk/listok', Tickets::buyUrl(Tickets::find((int) $listok['id'])), 'vlastný odkaz má prednosť');

T::same(2490, (int) Tickets::find((int) $listok['id'])['price_cents'], 'cena je uložená v celých centoch');
T::same('24,90', Money::input(2490), 'cena sa do formulára vráti v tvare 24,90');
T::same("0,05\u{00A0}€", Money::format(5), 'päť centov sa zobrazí správne');

// ------------------------------------------------------------------- Poradie

T::group('Poradie a zobrazovanie');
$ids = array_map(static fn (array $r): int => (int) $r['id'], Faqs::listAll());
Faqs::move($ids[0], 'down');
$po = array_map(static fn (array $r): int => (int) $r['id'], Faqs::listAll());
T::same([$ids[1], $ids[0], $ids[2], $ids[3]], $po, 'posun nadol vymení prvé dve položky');

Faqs::move($ids[0], 'up');
T::same($ids, array_map(static fn (array $r): int => (int) $r['id'], Faqs::listAll()), 'posun nahor to vráti späť');

Faqs::move($ids[0], 'up');
T::same($ids, array_map(static fn (array $r): int => (int) $r['id'], Faqs::listAll()), 'prvú položku sa nedá posunúť vyššie');

$posledna = end($ids);
Faqs::move($posledna, 'down');
T::same($ids, array_map(static fn (array $r): int => (int) $r['id'], Faqs::listAll()), 'poslednú sa nedá posunúť nižšie');

Faqs::setActive($ids[0], false);
T::same(3, count(Faqs::published()), 'skrytá otázka nie je na webe');
T::same(4, count(Faqs::listAll()), 'v admine ju stále vidno');
Faqs::setActive($ids[0], true);

// ----------------------------------------------------------------- Headliner

T::group('Headliner');
$novy = (int) Artists::grid()[0]['id'];
Artists::setHeadliner($novy);
T::same($novy, (int) Artists::headliner()['id'], 'nový headliner je nastavený');
T::same(1, (int) Db::value('SELECT COUNT(*) FROM artists WHERE is_headliner = 1'), 'headliner je vždy len jeden');

// -------------------------------------------------------------------- Adresy

T::group('Adresy interpretov');
$id = Artists::create(['name' => 'Heľenine oči', 'tag' => 'ROCK']);
T::same('helenine-oci-2', (string) Artists::find($id)['slug'], 'zhodná adresa dostane číslo');
T::same('billy-barman', Validate::slug('Billy Barman'), 'z názvu vznikne adresa bez diakritiky');
T::same('zlta-ponorka', Validate::slug('Žltá  ponorka!'), 'diakritika a interpunkcia sa odstránia');
T::same('polozka', Validate::slug('!!!'), 'z nepoužiteľného názvu vznikne náhradná adresa');
Artists::remove($id);

// ------------------------------------------------------ Ochrana pred vstupom

T::group('Ochrana pred nebezpečným vstupom');
T::same('', Html::safeUrl('javascript:alert(1)'), 'javascript: odkaz je zahodený');
T::same('', Html::safeUrl('data:text/html,<script>alert(1)</script>'), 'data: odkaz je zahodený');
T::same('', Html::safeUrl('  JavaScript:alert(1)'), 'javascript: s medzerami a veľkými písmenami tiež');
T::same('https://majales.sk', Html::safeUrl('https://majales.sk'), 'https odkaz prejde');
T::same('mailto:a@b.sk', Html::safeUrl('mailto:a@b.sk'), 'mailto prejde');
T::same('#lineup', Html::safeUrl('#lineup'), 'kotva na stránke prejde');

T::same(
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    Html::e('<script>alert(1)</script>'),
    'značky sa do stránky nedostanú'
);
T::same('&quot;&amp;&#039;', Html::e('"&\''), 'úvodzovky a ampersand sú ošetrené');

$v = new Validate(['a' => "text\x00s\x07riadiacimi"]);
T::same('textsriadiacimi', $v->text('a', 'Text'), 'riadiace znaky sa odstránia');

$v = new Validate(['url' => 'javascript:alert(1)']);
$v->url('url', 'Odkaz');
T::ok(!$v->ok(), 'kontrola formulára odmietne javascript: odkaz');

// Meno tabuľky nikdy nepochádza zo vstupu, ale nech je to overené.
T::throws(
    static fn () => Db::insert('users; DROP TABLE users', ['x' => 1]),
    'podozrivý názov tabuľky je odmietnutý',
    'Neplatný názov'
);

$zaludny = "Kapela'); DROP TABLE artists; --";
$idz = Artists::create(['name' => $zaludny, 'tag' => 'TEST']);
T::same($zaludny, (string) Artists::find($idz)['name'], 'SQL v texte sa uloží ako obyčajný text');
T::ok(Db::value('SELECT COUNT(*) FROM artists') > 0, 'tabuľka interpretov stále existuje');
Artists::remove($idz);

// ------------------------------------------------------------------ Validácia

T::group('Kontrola formulárov');
$v = new Validate(['e' => 'NIEKTO@Example.SK']);
T::same('niekto@example.sk', $v->email('e', 'E-mail'), 'e-mail sa prevedie na malé písmená');

$v = new Validate(['e' => 'toto nie je email']);
$v->email('e', 'E-mail');
T::ok(!$v->ok(), 'nezmyselný e-mail je odmietnutý');
T::ok(str_contains($v->firstError(), 'meno@domena.sk'), 'hláška ukáže správny tvar');

$v = new Validate(['c' => '24,90']);
T::same(2490, $v->priceCents('c', 'Cena'), 'cena s čiarkou sa prevedie na centy');
$v = new Validate(['c' => '24.9']);
T::same(2490, $v->priceCents('c', 'Cena'), 'cena s bodkou tiež');
$v = new Validate(['c' => '1 234,56']);
T::same(123456, $v->priceCents('c', 'Cena'), 'medzera v tisícoch neprekáža');
$v = new Validate(['c' => '']);
T::same(null, $v->priceCents('c', 'Cena'), 'prázdna cena je „neurčená"');
$v = new Validate(['c' => 'zadarmo']);
$v->priceCents('c', 'Cena');
T::ok(!$v->ok(), 'text namiesto ceny je odmietnutý');

$v = new Validate(['t' => str_repeat('a', 300)]);
$v->text('t', 'Text', false, 255);
T::ok(!$v->ok(), 'pridlhý text je odmietnutý');

$v = new Validate([]);
$v->text('chyba', 'Povinné pole', true);
T::ok(!$v->ok(), 'prázdne povinné pole je odmietnuté');
T::ok(str_contains($v->firstError(), 'Povinné pole'), 'hláška menuje konkrétne pole');

// ------------------------------------------------------------------- Odpočet

T::group('Odpočet do festivalu');
Clock::freeze(strtotime('2027-05-06 12:00:00'));
$cd = Page::countdown('2027-05-07 14:00:00');
T::same('1', $cd['days'], 'zostáva jeden deň');
T::same('02', $cd['hours'], 'a dve hodiny, doplnené nulou');
T::same('00', $cd['mins'], 'minúty sú nula');
T::ok(!$cd['over'], 'odpočet ešte beží');

Clock::freeze(strtotime('2027-05-08 12:00:00'));
$po = Page::countdown('2027-05-07 14:00:00');
T::ok($po['over'], 'po termíne je odpočet ukončený');
T::same('0', $po['days'], 'a nejde do mínusu');
Clock::freeze(null);

// --------------------------------------------------------------- Newsletter

T::group('Odber noviniek');
T::same('created', Subscribers::subscribe('Fanusik@Example.SK'), 'nový odberateľ sa zapíše');
T::same(1, Subscribers::count(Subscribers::STATUS_ACTIVE), 'je v databáze raz');
T::same('already', Subscribers::subscribe('fanusik@example.sk'), 'rovnaký e-mail sa nezapíše druhýkrát');
T::same(1, Subscribers::count(), 'stále je len jeden záznam');

$token = (string) Db::value('SELECT token FROM subscribers WHERE email = ?', ['fanusik@example.sk']);
T::ok(strlen($token) >= 32, 'odhlasovací kľúč je dosť dlhý na to, aby sa nedal uhádnuť');
T::ok(Subscribers::unsubscribeByToken($token), 'odhlásenie cez kľúč funguje');
T::same(0, Subscribers::count(Subscribers::STATUS_ACTIVE), 'už nie je medzi aktívnymi');
T::ok(!Subscribers::unsubscribeByToken('vymysleny-kluc'), 'vymyslený kľúč nič neurobí');
T::same('resubscribed', Subscribers::subscribe('fanusik@example.sk'), 'odhlásený sa môže vrátiť');

$ip = (string) Db::value('SELECT ip_hash FROM subscribers WHERE email = ?', ['fanusik@example.sk']);
T::ok($ip !== '' && !str_contains($ip, '.'), 'adresa návštevníka je uložená len ako odtlačok');

Subscribers::subscribe('druhy@example.sk');
$csv = Subscribers::toCsv(Subscribers::STATUS_ACTIVE);
T::ok(str_starts_with($csv, "\xEF\xBB\xBF"), 'CSV má značku, aby ho Excel čítal správne');
T::ok(str_contains($csv, 'fanusik@example.sk') && str_contains($csv, 'druhy@example.sk'), 'CSV obsahuje oba e-maily');

// -------------------------------------------------------------- Brzda pokusov

T::group('Brzda opakovaných pokusov');
for ($i = 1; $i <= 3; $i++) {
    T::ok(RateLimit::attempt('test', '1.2.3.4', 3, 60), "pokus $i z 3 prejde");
}
T::ok(!RateLimit::attempt('test', '1.2.3.4', 3, 60), 'štvrtý pokus je zablokovaný');
T::ok(RateLimit::retryAfter('test', '1.2.3.4') > 0, 'vie povedať, o koľko sekúnd to skúsiť znova');
T::ok(RateLimit::attempt('test', '5.6.7.8', 3, 60), 'iná adresa nie je dotknutá');
RateLimit::clear('test', '1.2.3.4');
T::ok(RateLimit::attempt('test', '1.2.3.4', 3, 60), 'po vynulovaní ide znova');

Clock::freeze(time() + 120);
T::ok(RateLimit::attempt('test', '5.6.7.8', 3, 60), 'po uplynutí okna sa počítadlo vynuluje');
Clock::freeze(null);

// -------------------------------------------------------------------- Fotky

T::group('Nahrávanie fotiek');
$mid = Media::store(fakeUpload('Moja Fotka.JPG', 1600, 1000), 'Popis fotky');
$m   = Media::find($mid);
T::same('image/webp', (string) $m['mime'], 'fotka sa prevedie na WEBP');
T::same(1200, (int) $m['width'], 'zmenší sa na povolenú šírku');
T::same(750, (int) $m['height'], 'pomer strán ostáva zachovaný');
T::ok(str_contains((string) $m['path'], 'moja-fotka'), 'názov súboru je bezpečný a čitateľný');
T::ok(is_file(MAJALES_ROOT . '/' . $m['path']), 'súbor naozaj vznikol');
T::ok(is_file(MAJALES_ROOT . '/' . $m['thumb_path']), 'vznikol aj náhľad');
T::same('Popis fotky', (string) $m['alt'], 'popis pre čítačky sa uložil');

$maly = Media::store(fakeUpload('maly.png', 300, 200, 'png'), '');
T::same(300, (int) Media::find($maly)['width'], 'malý obrázok sa nezväčšuje');

T::throws(
    static fn () => Media::store([
        'name' => 'skript.php', 'type' => 'application/x-php',
        'tmp_name' => (static function (): string {
            $f = tempnam(sys_get_temp_dir(), 'maj');
            file_put_contents($f, '<?php echo "zle"; ?>');
            return $f;
        })(),
        'error' => UPLOAD_ERR_OK, 'size' => 20,
    ]),
    'PHP súbor sa nedá nahrať ako fotka',
    'obrázok'
);

T::throws(
    static fn () => Media::store(['name' => 'x.jpg', 'tmp_name' => '', 'error' => UPLOAD_ERR_NO_FILE, 'size' => 0]),
    'prázdny výber ohlási zrozumiteľnú chybu',
    'žiadny súbor'
);

$cesty = [MAJALES_ROOT . '/' . $m['path'], MAJALES_ROOT . '/' . $m['thumb_path']];
Media::remove($mid);
T::ok(Media::find($mid) === null, 'zmazaná fotka zmizla z databázy');
T::ok(!is_file($cesty[0]) && !is_file($cesty[1]), 'aj súbory z disku');

$zonaId = (int) Zones::published()[0]['id'];
Zones::save($zonaId, ['media_id' => $maly]);
T::same($maly, (int) Zones::find($zonaId)['media_id'], 'fotka sa dá priradiť ku zóne');
Media::remove($maly);
T::same(null, Zones::find($zonaId)['media_id'], 'po zmazaní fotky ostane zóna bez nej, nie rozbitá');

// ---------------------------------------------------------- Výstup do stránky

T::group('Vykreslenie stránky');
$html = Html::paragraphs("Prvý odsek.\n\nDruhý odsek.");
T::same('<p>Prvý odsek.</p><p>Druhý odsek.</p>', $html, 'prázdny riadok začne nový odsek');
T::ok(str_contains(Html::paragraphs("A\nB"), '<br'), 'jednoduchý zlom riadku ostane zlomom');
T::same('', Html::paragraphs('   '), 'z prázdneho textu nevznikne prázdny odsek');
T::ok(str_contains(Html::paragraphs('<b>tučné</b>'), '&lt;b&gt;'), 'značky v texte sa neinterpretujú');

T::same(['a', 'b'], Html::lines("a\n\n b \n"), 'riadky sa orežú a prázdne vypadnú');

$mq = Page::marqueeText('MAJÁLES', 2);
T::same(2, substr_count($mq, 'MAJÁLES'), 'text bežiaceho pásu sa zopakuje');
T::same('', Page::marqueeText('  '), 'prázdny pás nič nevypíše');

$ld = json_decode(html_entity_decode(str_replace('<\/', '</', Page::jsonLd())), true);
T::same('MusicFestival', $ld['@type'] ?? '', 'štruktúrované dáta hovoria, že ide o festival');
T::ok(isset($ld['startDate']), 'obsahujú dátum začiatku');
T::ok(count($ld['performer'] ?? []) === 11, 'a zoznam všetkých interpretov');
T::ok(isset($ld['offers']), 'pri spustenom predaji obsahujú aj vstupenky');

$obr = Page::image(null, 'trieda', 'Foto: test');
T::ok(str_contains($obr, 'slot') && str_contains($obr, 'Foto: test'), 'bez fotky ostane rámček s popisom');

$mapa = Page::mapEmbedUrl();
T::ok(str_contains($mapa, 'output=embed') && !str_contains($mapa, ' '), 'adresa mapy je správne zakódovaná');

// --------------------------------------------------------------- Nastavenia

T::group('Nastavenia a texty');
Settings::set('test_kluc', 'hodnota');
T::same('hodnota', Settings::get('test_kluc'), 'nastavenie sa uloží a načíta');
T::same('náhrada', Settings::get('neexistuje', 'náhrada'), 'chýbajúce nastavenie vráti náhradu');
T::ok(Settings::bool('show_countdown', false), 'prepínač sa číta ako áno/nie');
Settings::set('test_prepinac', '0');
T::ok(!Settings::bool('test_prepinac', true), 'vypnutý prepínač prebije predvolenú hodnotu');

$verzia = Settings::int('content_version');
Blocks::setMany(['intro_heading' => 'NOVÝ NADPIS']);
T::same('NOVÝ NADPIS', Blocks::get('intro_heading'), 'text sa uložil');
T::ok(Settings::int('content_version') > $verzia, 'verzia obsahu sa zvýšila (prehliadač načíta nové)');

$verzia2 = Settings::int('content_version');
Artists::create(['name' => 'NOVÁ KAPELA']);
T::ok(Settings::int('content_version') > $verzia2, 'zvýši sa aj pri zmene zoznamu');

// ------------------------------------------------------------- Denník zmien

T::group('Denník zmien');
$pred = AuditLog::count();
AuditLog::write('test', 'entita', 42, ['kluc' => 'hodnota']);
T::same($pred + 1, AuditLog::count(), 'zápis do denníka funguje');
$zaznam = AuditLog::recent(1)[0];
T::same('test', (string) $zaznam['action'], 'akcia je zapísaná');
T::ok(str_contains((string) $zaznam['detail'], 'hodnota'), 'podrobnosti sú uložené');

Db::run('UPDATE audit_log SET created_at = ? WHERE id = ?', [date('Y-m-d H:i:s', time() - 400 * 86400), (int) $zaznam['id']]);
T::same(1, AuditLog::pruneOlderThanDays(365), 'staré záznamy sa dajú orezať');

exit(T::summary());
