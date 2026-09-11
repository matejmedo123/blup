<?php
declare(strict_types=1);

/**
 * Verejná stránka Majáles Nitra. Celý obsah sa načíta z databázy, takže
 * čokoľvek obsluha zmení v admine, je hneď na webe — bez nasadzovania.
 */

require __DIR__ . '/lib/bootstrap.php';

Page::sendSecurityHeaders();
Page::sendCacheHeaders();

$s  = static fn (string $k, string $d = ''): string => Settings::get($k, $d);
$b  = static fn (string $k, string $d = ''): string => Blocks::get($k, $d);
$e  = static fn (?string $v): string => Html::e($v);

$headliner   = Artists::headliner();
$artists     = Artists::grid();
$tickets     = Tickets::published();
$faqs        = Faqs::published();
$zones       = Zones::published();
$photos      = Gallery::withPhotos();
$partners    = Partners::published();
$countdownOn = Settings::bool('show_countdown', true);
$cd          = Page::countdown($s('countdown_target', '2027-05-07 14:00:00'));
$logo        = Page::asset('assets/img/logo.png');
$title       = $s('site_title', 'Majáles Nitra');
$baseUrl     = Config::baseUrl();

$socials = [];
foreach (['facebook', 'instagram', 'tiktok', 'spotify', 'youtube'] as $net) {
    $url = Html::safeUrl($s('social_' . $net));
    if ($url !== '') {
        $socials[] = [$net, $url];
    }
}

// Obrázok do náhľadu pri zdieľaní: buď vlastný, alebo prvá fotka galérie.
$ogImage = Html::safeUrl($s('og_image'));
if ($ogImage === '' && $photos !== []) {
    $ogImage = $baseUrl . '/' . (string) $photos[0]['path'];
} elseif ($ogImage === '') {
    $ogImage = $baseUrl . '/assets/img/logo.png';
}
?>
<!doctype html>
<html lang="sk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= $e($title) ?> — <?= $e($s('site_tagline')) ?></title>
<meta name="description" content="<?= $e($s('meta_description')) ?>">
<meta name="theme-color" content="#0A4E85">
<?php if ($baseUrl !== ''): ?>
<link rel="canonical" href="<?= $e($baseUrl) ?>/">
<?php endif; ?>

<meta property="og:type" content="website">
<meta property="og:locale" content="sk_SK">
<meta property="og:site_name" content="<?= $e($title) ?>">
<meta property="og:title" content="<?= $e($title) ?> — <?= $e($s('site_tagline')) ?>">
<meta property="og:description" content="<?= $e($s('meta_description')) ?>">
<?php if ($ogImage !== ''): ?>
<meta property="og:image" content="<?= $e($ogImage) ?>">
<meta name="twitter:card" content="summary_large_image">
<?php endif; ?>

<link rel="icon" href="<?= $e(Page::asset('assets/img/favicon.png')) ?>" type="image/png">
<link rel="apple-touch-icon" href="<?= $e(Page::asset('assets/img/apple-touch-icon.png')) ?>">

<link rel="preload" href="assets/fonts/anton-latin-ext.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="assets/fonts/inter-latin-ext.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="<?= $e(Page::asset('assets/css/fonts.css')) ?>">
<link rel="stylesheet" href="<?= $e(Page::asset('assets/css/site.css')) ?>">

<script type="application/ld+json"><?= Page::jsonLd() ?></script>
<?php
// Miesto na meracie kódy (Google Analytics, Meta Pixel). Vkladá ho
// správca v nastaveniach a je to jediné miesto, kde sa výstup nefiltruje.
$head = trim($s('analytics_head'));
if ($head !== '') {
    echo $head . "\n";
}
?>
</head>
<body>
<script>
// Triedu pridávame ešte pred obsahom, aby sekcie nezablikali predtým,
// než ich prevezme site.js. Poistka: keby sa skript nenačítal, obsah
// sa po dvoch sekundách odomkne, nech stránka neostane prázdna.
(function(){var r=document.documentElement,b=document.body;r.classList.add('js');b.classList.add('js');
setTimeout(function(){if(!window.__majalesReady){r.classList.remove('js');b.classList.remove('js');}},2000);})();
</script>

<a class="skip-link" href="#obsah">Preskočiť na obsah</a>
<div class="progress" id="progress" role="presentation"></div>

<nav class="nav" aria-label="Hlavné menu">
  <a class="nav__logo" href="#top" aria-label="<?= $e($title) ?> — domov">
    <img src="<?= $e($logo) ?>" alt="<?= $e($title) ?>" width="1400" height="682" fetchpriority="high">
  </a>

  <div class="nav__links">
    <a class="pill" href="#top">DOMOV</a>
    <a class="pill" href="#lineup">LINE-UP</a>
    <a class="pill" href="#partneri">PARTNERI</a>
    <a class="pill pill--accent" href="#vstupenky"><?= $e($b('nav_cta', 'VSTUPENKY')) ?></a>
  </div>

  <div class="nav__mobile">
    <a class="pill pill--accent" href="#vstupenky"><?= $e($b('nav_cta', 'VSTUPENKY')) ?></a>
    <button type="button" class="burger" id="burger" aria-expanded="false" aria-controls="menu">
      <span aria-hidden="true">☰</span><span class="vh">Otvoriť menu</span>
    </button>
  </div>
</nav>

<div class="menu" id="menu" hidden>
  <a href="#top">DOMOV</a>
  <a href="#lineup">LINE-UP</a>
  <a href="#partneri">PARTNERI</a>
  <a class="menu__cta" href="#vstupenky">KÚPIŤ VSTUPENKY</a>
</div>

<header class="hero" id="top">
<?php
$heroVideo  = trim($s('hero_video'));
$heroPoster = Media::url(Settings::int('hero_poster_media_id') ?: null);
?>
<?php if ($heroPoster !== ''): ?>
  <?php /* Na telefóne a v režime šetrenia dát ostane na mieste videa fotka. */ ?>
  <img class="hero__media" src="<?= $e(Page::asset($heroPoster)) ?>" alt="" fetchpriority="high">
<?php endif; ?>
<?php if ($heroVideo !== ''): ?>
  <?php /* Video sa načíta až zo skriptu — na mobilnom internete alebo
           v režime šetrenia dát by sedemnásť megabajtov bolo bezohľadné.
           Bez neho ostane v hlavičke náhľadový obrázok alebo modrý podklad. */ ?>
  <video class="hero__media" id="hero-video" muted loop playsinline preload="none"
         data-src="<?= $e($heroVideo) ?>"
         <?= $heroPoster !== '' ? 'poster="' . $e($heroPoster) . '"' : '' ?>
         aria-hidden="true" tabindex="-1"></video>
<?php endif; ?>
  <div class="hero__scrim"></div>

  <img class="leaf leaf--2" src="<?= $e(Page::asset('assets/img/leaf-2.webp')) ?>" alt="" width="215" height="354">
  <img class="leaf leaf--1" src="<?= $e(Page::asset('assets/img/leaf-1.webp')) ?>" alt="" width="215" height="354">
  <img class="leaf leaf--3" src="<?= $e(Page::asset('assets/img/leaf-3.webp')) ?>" alt="" width="215" height="354">

  <div class="hero__content">
    <div class="hero__left">
      <p class="badge"><?= $e($b('hero_badge')) ?></p>

      <div class="hero__cta">
        <a class="btn btn--sun" href="#vstupenky"><?= $e($b('hero_cta_primary', 'KÚPIŤ VSTUPENKY')) ?></a>
        <a class="btn btn--ghost" href="#lineup"><?= $e($b('hero_cta_secondary', 'POZRI LINEUP')) ?></a>
      </div>

<?php if ($countdownOn && !$cd['over']): ?>
      <ul class="countdown" id="countdown"
          data-target="<?= $e(date('c', (int) (strtotime($s('countdown_target', '2027-05-07 14:00:00')) ?: 0))) ?>">
        <li><b data-cd="days"><?= $e($cd['days']) ?></b><span>DNÍ</span></li>
        <li><b data-cd="hours"><?= $e($cd['hours']) ?></b><span>HODÍN</span></li>
        <li><b data-cd="mins"><?= $e($cd['mins']) ?></b><span>MINÚT</span></li>
        <li><b data-cd="secs"><?= $e($cd['secs']) ?></b><span>SEKÚND</span></li>
      </ul>
<?php endif; ?>
    </div>

    <h1 class="hero__date"><?= $e($b('hero_date_line1')) ?><br><?= $e($b('hero_date_line2')) ?></h1>
  </div>

  <div class="hero__strip">
    <span><?= $e(mb_strtoupper($s('venue_name'))) ?></span>
    <span class="hero__arrow" aria-hidden="true">↓</span>
    <span><?= $e(mb_strtoupper($s('venue_city'))) ?></span>
  </div>
</header>

<main id="obsah">

<div class="marquee marquee--date" aria-hidden="true">
  <div class="marquee__track">
    <span><?= $e(Page::marqueeText($b('marquee_date'))) ?></span>
    <span><?= $e(Page::marqueeText($b('marquee_date'))) ?></span>
  </div>
</div>
<div class="marquee marquee--brand marquee--tight" aria-hidden="true">
  <div class="marquee__track">
    <span><?= $e(Page::marqueeText($b('marquee_brand'), 2)) ?></span>
    <span><?= $e(Page::marqueeText($b('marquee_brand'), 2)) ?></span>
  </div>
</div>

<section class="prose reveal" aria-labelledby="uvod-nadpis">
  <h2 class="prose__heading" id="uvod-nadpis"><?= $e($b('intro_heading')) ?></h2>
  <?= Html::paragraphs($b('intro_body')) ?>
<?php if (trim($b('intro_signature')) !== ''): ?>
  <p class="prose__sign"><?= $e($b('intro_signature')) ?></p>
<?php endif; ?>
</section>

<?php if ($photos !== []): ?>
<section class="gallery reveal" aria-label="Fotogaléria">
<?php foreach ($photos as $p): ?>
  <button type="button" class="gallery__item"
          data-photo="<?= $e((string) $p['path']) ?>"
          data-caption="<?= $e((string) $p['caption']) ?>">
    <img src="<?= $e(Page::asset((string) $p['path'])) ?>"
         width="<?= (int) $p['width'] ?>" height="<?= (int) $p['height'] ?>"
         alt="<?= $e(((string) $p['alt']) !== '' ? (string) $p['alt'] : (string) $p['caption']) ?>"
         loading="lazy" decoding="async">
    <span class="vh">Otvoriť fotku na celú obrazovku</span>
  </button>
<?php endforeach; ?>
</section>
<?php endif; ?>

<?php if ($zones !== []): ?>
<section class="section reveal" aria-labelledby="zony-nadpis">
  <h2 class="heading" id="zony-nadpis"><?= $e($b('zones_heading')) ?></h2>
  <p class="subheading"><?= $e($b('zones_subheading')) ?></p>
  <div class="cards">
<?php foreach ($zones as $z): ?>
    <article class="card">
      <?= Page::image($z['media_id'] === null ? null : (int) $z['media_id'], 'card__img', 'Foto: ' . (string) $z['title'], (string) $z['title']) ?>
      <div class="card__body">
        <h3 class="card__title"><?= $e((string) $z['title']) ?></h3>
        <p class="card__text"><?= $e((string) $z['description']) ?></p>
      </div>
    </article>
<?php endforeach; ?>
  </div>
</section>
<?php endif; ?>

<div class="marquee marquee--lineup marquee--anchor" id="lineup" aria-hidden="true">
  <div class="marquee__track">
    <span><?= $e(Page::marqueeText($b('marquee_lineup'))) ?></span>
    <span><?= $e(Page::marqueeText($b('marquee_lineup'))) ?></span>
  </div>
</div>
<h2 class="vh">Lineup</h2>

<section class="section section--wide" aria-label="Interpreti">
<?php if ($headliner !== null): ?>
  <div class="headliner reveal">
    <?= Page::image(
        $headliner['media_id'] === null ? null : (int) $headliner['media_id'],
        'headliner__img',
        'Foto: ' . (string) $headliner['name'],
        (string) $headliner['name'],
        false
    ) ?>
    <div class="headliner__scrim"></div>
    <div class="headliner__body">
<?php if (trim((string) $headliner['badge']) !== ''): ?>
      <p class="badge"><?= $e((string) $headliner['badge']) ?></p>
<?php endif; ?>
      <h3 class="headliner__name"><?= $e((string) $headliner['name']) ?></h3>
    </div>
<?php $hs = Artists::socials($headliner); if ($hs !== []): ?>
    <div class="headliner__social"><?= Icons::row($hs) ?></div>
<?php endif; ?>
  </div>
<?php endif; ?>

<?php if ($artists !== []): ?>
  <div class="artists">
<?php foreach ($artists as $a): ?>
    <button type="button" class="artist reveal"
            data-artist="<?= $e((string) $a['slug']) ?>"
            aria-haspopup="dialog">
      <?= Page::image($a['media_id'] === null ? null : (int) $a['media_id'], 'artist__img', 'Foto: ' . (string) $a['name'], (string) $a['name']) ?>
      <span class="artist__foot">
        <span>
          <span class="artist__name"><?= $e((string) $a['name']) ?></span>
          <span class="artist__tag"><?= $e((string) $a['tag']) ?></span>
        </span>
<?php $as = Artists::socials($a); if ($as !== []): ?>
        <span class="artist__social" aria-hidden="true"><?= Icons::row($as, 20) ?></span>
<?php endif; ?>
      </span>
    </button>
<?php endforeach; ?>
  </div>
<?php endif; ?>

<?php if (trim($b('lineup_more')) !== ''): ?>
  <p class="lineup__more"><?= $e($b('lineup_more')) ?></p>
<?php endif; ?>
<?php $spotify = Html::safeUrl($s('spotify_url')); if ($spotify !== ''): ?>
  <div class="lineup__spotify">
    <a class="btn btn--outline" href="<?= $e($spotify) ?>" target="_blank" rel="noopener noreferrer">
      <?= Icons::svg('spotify', 24, 'currentColor') ?><?= $e($b('lineup_spotify_label')) ?>
    </a>
  </div>
<?php endif; ?>
</section>

<div class="marquee marquee--tickets marquee--anchor" id="vstupenky" aria-hidden="true">
  <div class="marquee__track">
    <span><?= $e(Page::marqueeText($b('marquee_tickets'), 2)) ?></span>
    <span><?= $e(Page::marqueeText($b('marquee_tickets'), 2)) ?></span>
  </div>
</div>
<h2 class="vh">Vstupenky</h2>

<?php if ($tickets !== []): ?>
<section class="tickets reveal" aria-label="Typy vstupeniek">
<?php foreach ($tickets as $t): $hl = (int) $t['highlight'] === 1; ?>
  <article class="ticket<?= $hl ? ' ticket--highlight' : '' ?>">
<?php if (trim((string) $t['badge']) !== ''): ?>
    <p class="ticket__badge"><?= $e((string) $t['badge']) ?></p>
<?php endif; ?>
    <h3 class="ticket__title"><?= $e((string) $t['title']) ?></h3>
<?php if (trim((string) $t['subtitle']) !== ''): ?>
    <p class="ticket__sub"><?= $e((string) $t['subtitle']) ?></p>
<?php endif; ?>
<?php $benefits = Html::lines((string) $t['benefits']); if ($benefits !== []): ?>
    <ul class="ticket__list">
<?php foreach ($benefits as $line): ?>
      <li><?= $e($line) ?></li>
<?php endforeach; ?>
    </ul>
<?php endif; ?>
    <p class="ticket__price"><?= $e(Tickets::priceLabel($t)) ?></p>
<?php $buy = Tickets::buyUrl($t); if ($buy !== ''): ?>
    <a class="btn <?= $hl ? 'btn--ghost' : 'btn--sun' ?> ticket__buy" href="<?= $e($buy) ?>" target="_blank" rel="noopener noreferrer">
      KÚPIŤ<span class="vh"> vstupenku <?= $e((string) $t['title']) ?></span>
    </a>
<?php endif; ?>
  </article>
<?php endforeach; ?>
</section>
<?php endif; ?>

<div class="notes">
<?php if (trim($b('tickets_note_kids')) !== ''): ?>
  <p class="note note--solid"><?= $e($b('tickets_note_kids')) ?></p>
<?php endif; ?>
<?php if (trim($b('tickets_note_students')) !== ''): ?>
  <p class="note note--outline"><?= $e($b('tickets_note_students')) ?></p>
<?php endif; ?>
</div>
<?php if (trim($b('tickets_note')) !== ''): ?>
<p class="tickets__note"><?= $e($b('tickets_note')) ?></p>
<?php endif; ?>

<?php
$aftermovieUrl = Html::safeUrl($s('aftermovie_url'));
$aftermovieImg = Settings::int('aftermovie_media_id') ?: null;
if (Settings::bool('show_aftermovie', true)):
    $tag = $aftermovieUrl !== '' ? 'a' : 'div';
?>
<section class="section section--wide reveal" style="padding-top:50px" aria-label="Aftermovie">
  <<?= $tag ?> class="aftermovie"<?= $aftermovieUrl !== '' ? ' href="' . $e($aftermovieUrl) . '" target="_blank" rel="noopener noreferrer"' : '' ?>>
    <?= Page::image($aftermovieImg, 'aftermovie__img', 'Aftermovie — náhľadový záber', (string) $b('aftermovie_caption')) ?>
    <span class="aftermovie__overlay">
      <span class="aftermovie__play" aria-hidden="true"></span>
      <span class="aftermovie__caption"><?= $e($b('aftermovie_caption')) ?></span>
    </span>
  </<?= $tag ?>>
</section>
<?php endif; ?>

<?php if ($faqs !== []): ?>
<section class="section section--narrow reveal" style="padding-top:50px" aria-labelledby="faq-nadpis">
  <h2 class="heading" id="faq-nadpis"><?= $e($b('faq_heading')) ?></h2>
  <div class="faq">
<?php foreach ($faqs as $i => $f): $qid = 'faq-q-' . (int) $f['id']; $aid = 'faq-a-' . (int) $f['id']; ?>
    <div class="faq__item">
      <button type="button" class="faq__q" id="<?= $e($qid) ?>" aria-expanded="false" aria-controls="<?= $e($aid) ?>">
        <span><?= $e((string) $f['question']) ?></span>
        <span class="faq__mark" aria-hidden="true">+</span>
      </button>
      <p class="faq__a" id="<?= $e($aid) ?>" role="region" aria-labelledby="<?= $e($qid) ?>" hidden><?= nl2br($e((string) $f['answer'])) ?></p>
    </div>
<?php endforeach; ?>
  </div>
</section>
<?php endif; ?>

<section class="section reveal" style="padding-top:50px" aria-labelledby="doprava-nadpis">
  <div class="travel">
    <div class="travel__card">
      <h2 class="travel__heading" id="doprava-nadpis"><?= $e($b('travel_heading')) ?></h2>
      <ul class="travel__list">
<?php foreach ([['travel_car_label', 'travel_car'], ['travel_bus_label', 'travel_bus'], ['travel_walk_label', 'travel_walk']] as [$lk, $tk]):
    if (trim($b($tk)) === '') { continue; } ?>
        <li><span class="travel__label"><?= $e($b($lk)) ?></span> — <?= $e($b($tk)) ?></li>
<?php endforeach; ?>
      </ul>
<?php $maps = Html::safeUrl($s('maps_link')); if ($maps !== ''): ?>
      <a class="btn btn--sun" href="<?= $e($maps) ?>" target="_blank" rel="noopener noreferrer"><?= $e($b('travel_maps_label')) ?></a>
<?php endif; ?>
    </div>
    <iframe class="travel__map" src="<?= $e(Page::mapEmbedUrl()) ?>" loading="lazy"
            title="Mapa — <?= $e($s('venue_name')) ?>" allowfullscreen
            referrerpolicy="no-referrer-when-downgrade"></iframe>
  </div>
</section>

<div class="marquee marquee--partners marquee--anchor" id="partneri" aria-hidden="true">
  <div class="marquee__track">
    <span><?= $e(Page::marqueeText($b('marquee_partners'), 2)) ?></span>
    <span><?= $e(Page::marqueeText($b('marquee_partners'), 2)) ?></span>
  </div>
</div>
<h2 class="vh">Partneri</h2>

<?php if (trim($b('partners_body')) !== ''): ?>
<section class="prose" style="padding-top:30px" aria-label="O partnerstve">
  <?= Html::paragraphs($b('partners_body')) ?>
</section>
<?php endif; ?>

<?php if ($partners !== []): ?>
<section class="partners reveal" aria-label="Logá partnerov">
<?php foreach ($partners as $p):
    $url = Html::safeUrl((string) $p['url']);
    $tag = $url !== '' ? 'a' : 'div';
?>
  <<?= $tag ?> class="partner"<?= $url !== '' ? ' href="' . $e($url) . '" target="_blank" rel="noopener noreferrer"' : '' ?>>
    <?= Page::image($p['media_id'] === null ? null : (int) $p['media_id'], '', 'Logo: ' . (string) $p['name'], (string) $p['name']) ?>
  </<?= $tag ?>>
<?php endforeach; ?>
</section>
<?php endif; ?>

</main>

<footer class="footer">
  <img class="footer__logo" src="<?= $e($logo) ?>" alt="<?= $e($title) ?>" width="1400" height="682" loading="lazy">

<?php if (Settings::bool('newsletter_enabled', true)): ?>
  <form class="subscribe" id="subscribe" action="api/prihlasit.php" method="post" novalidate>
    <label class="vh" for="news-email">Tvoj e-mail</label>
    <input type="email" id="news-email" name="email" placeholder="tvoj@email.sk"
           autocomplete="email" required maxlength="190">
    <?php /* Pascička na roboty — človek toto pole nevidí a nevyplní ho. */ ?>
    <div class="vh" aria-hidden="true">
      <label for="news-website">Nevypĺňaj</label>
      <input type="text" id="news-website" name="website" tabindex="-1" autocomplete="off">
    </div>
    <button type="submit"><?= $e($b('newsletter_label', 'ODOBERAŤ')) ?></button>
  </form>
  <p class="footer__hint"><?= $e($b('newsletter_hint')) ?></p>
<?php
// Odpoveď pre návštevníka bez JavaScriptu — server presmeruje späť sem.
$odber = (string) ($_GET['odber'] ?? '');
$odberSprava = $odber === 'ok'
    ? 'Ďakujeme! Ozveme sa s novinkami.'
    : ($odber === 'chyba' ? (string) ($_GET['sprava'] ?? 'Prihlásenie sa nepodarilo.') : '');
?>
  <p class="footer__status<?= $odber === 'chyba' ? ' footer__status--err' : '' ?>" id="subscribe-status" role="status" aria-live="polite"><?= $e($odberSprava) ?></p>
<?php endif; ?>

<?php if (trim($b('footer_supporter')) !== ''): ?>
  <p class="footer__supporter"><?= $e($b('footer_supporter')) ?></p>
<?php endif; ?>

<?php $mail = trim($s('contact_email')); if ($mail !== ''): ?>
  <p class="footer__mail"><a href="mailto:<?= $e($mail) ?>"><?= $e($mail) ?></a></p>
<?php endif; ?>

  <p class="footer__address"><?= $e(mb_strtoupper($s('venue_name'))) ?><br><?= $e(mb_strtoupper($s('venue_city'))) ?></p>

<?php if ($socials !== []): ?>
  <div class="footer__social"><?= Icons::row($socials, 26, '#ffffff') ?></div>
<?php endif; ?>

  <p class="footer__copy"><?= $e($b('footer_copyright')) ?></p>
</footer>

<div class="overlay" id="lightbox" hidden role="dialog" aria-modal="true" aria-label="Fotka na celú obrazovku">
  <img class="lightbox__img" id="lightbox-img" src="" alt="">
  <button type="button" class="overlay__close" data-close>
    <span aria-hidden="true">✕</span><span class="vh">Zavrieť</span>
  </button>
</div>

<div class="overlay overlay--artist" id="artist-modal" hidden role="dialog" aria-modal="true" aria-labelledby="artist-name">
  <div class="modal">
    <button type="button" class="overlay__close modal__close" data-close>
      <span aria-hidden="true">✕</span><span class="vh">Zavrieť</span>
    </button>
    <p class="badge" id="artist-tag"></p>
    <h2 class="modal__name" id="artist-name"></h2>
    <p class="modal__desc" id="artist-desc"></p>
    <div class="modal__social" id="artist-social"></div>
  </div>
</div>

<a class="to-top" href="#top"><span aria-hidden="true">↑</span><span class="vh">Späť hore</span></a>

<script id="artists-data" type="application/json"><?= json_encode(
    array_map(static fn (array $a): array => [
        'slug'    => (string) $a['slug'],
        'name'    => (string) $a['name'],
        'tag'     => (string) $a['tag'],
        'bio'     => (string) $a['bio'],
        'socials' => Artists::socials($a),
    ], $artists),
    JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT
) ?></script>

<script src="<?= $e(Page::asset('assets/js/site.js')) ?>" defer></script>
</body>
</html>
