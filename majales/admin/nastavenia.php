<?php
declare(strict_types=1);

/**
 * Nastavenia webu — údaje o podujatí, odkazy, prepínače. Na rozdiel od
 * `config.php` sa menia z prehliadača a prejavia sa hneď.
 */

require __DIR__ . '/_layout.php';
require __DIR__ . '/_form.php';
Auth::requireLogin();

/** @return array<string,list<CrudField>> */
function settings_groups(): array
{
    return [
        'Podujatie' => [
            new CrudField('site_title', 'Názov webu', 'text', true, 'Zobrazí sa v záložke prehliadača a pri zdieľaní.', 120),
            new CrudField('site_tagline', 'Podtitul', 'text', false, 'Napríklad „7. – 8. máj 2027, Agrokomplex Nitra".', 190),
            new CrudField('meta_description', 'Popis pre vyhľadávače', 'textarea', false, 'Ideálne 120–160 znakov. Zobrazí sa v Google pod nadpisom.', 320),
            new CrudField('event_start', 'Začiatok festivalu', 'datetime', false, 'Používa sa v údajoch pre Google.'),
            new CrudField('event_end', 'Koniec festivalu', 'datetime'),
            new CrudField('countdown_target', 'Na kedy odpočítavať', 'datetime', false, 'Odpočet v hero časti stránky.'),
            new CrudField('show_countdown', 'Zobraziť odpočet', 'bool'),
        ],

        'Miesto konania' => [
            new CrudField('venue_name', 'Názov areálu', 'text', false, '', 120),
            new CrudField('venue_city', 'Mesto a krajina', 'text', false, '', 120),
            new CrudField('venue_address', 'Presná adresa', 'text', false, 'Ulica, PSČ a mesto.', 190),
            new CrudField('maps_embed_query', 'Čo hľadať v mape', 'text', false, 'Text, ktorý sa pošle do Google Máp pre vloženú mapu.', 190),
            new CrudField('maps_link', 'Odkaz „Otvoriť v Google Maps"', 'url'),
        ],

        'Vstupenky' => [
            new CrudField('sale_live', 'Predaj vstupeniek beží', 'bool', false, 'Kým je vypnutý, na kartách je nápis ČOSKORO namiesto ceny.'),
            new CrudField('tickets_url', 'Spoločný odkaz na predaj', 'url', false, 'Použije sa pri vstupenkách, ktoré nemajú vlastný odkaz.'),
            new CrudField('sale_label_soon', 'Nápis pred spustením', 'text', false, '', 40),
            new CrudField('sale_label_live', 'Nápis bez uvedenej ceny', 'text', false, '', 40),
        ],

        'Odkazy a médiá' => [
            new CrudField('spotify_url', 'Playlist na Spotify', 'url', false, 'Tlačidlo pod lineupom. Prázdne = tlačidlo sa nezobrazí.'),
            new CrudField('aftermovie_url', 'Odkaz na aftermovie', 'url', false, 'Napríklad na YouTube.'),
            new CrudField('show_aftermovie', 'Zobraziť sekciu aftermovie', 'bool'),
            new CrudField('aftermovie_media_id', 'Náhľadový obrázok aftermovie', 'media'),
            new CrudField('hero_video', 'Video v hlavičke', 'text', false, 'Cesta k súboru, napríklad assets/img/hero-video.mp4. Prázdne = bez videa.', 255),
            new CrudField('hero_poster_media_id', 'Náhľad videa', 'media', false, 'Ukáže sa na telefóne a kým sa video nenačíta. Odporúčam záber z festivalu na šírku.'),
            new CrudField('og_image', 'Obrázok pri zdieľaní', 'url', false, 'Celá adresa obrázka. Prázdne = použije sa prvá fotka z galérie.'),
        ],

        'Kontakt a siete' => [
            new CrudField('contact_email', 'Kontaktný e-mail', 'email', false, 'Zobrazí sa v pätičke.'),
            new CrudField('social_facebook', 'Facebook', 'url'),
            new CrudField('social_instagram', 'Instagram', 'url'),
            new CrudField('social_tiktok', 'TikTok', 'url'),
            new CrudField('social_spotify', 'Spotify', 'url'),
            new CrudField('social_youtube', 'YouTube', 'url'),
        ],

        'Odber noviniek' => [
            new CrudField('newsletter_enabled', 'Zapnúť formulár v pätičke', 'bool'),
            new CrudField('newsletter_notify_email', 'Upozorniť na nového odberateľa', 'email', false, 'Prázdne = neposielať upozornenia.'),
        ],

        'Pre pokročilých' => [
            new CrudField('robots_index', 'Povoliť vyhľadávačom indexovať web', 'bool', false, 'Pred spustením webu môžeš vypnúť, nech sa nedostane do Google predčasne.'),
            new CrudField('analytics_head', 'Meracie kódy', 'textarea', false, 'Vloží sa do hlavičky stránky tak, ako to sem napíšeš — napríklad Google Analytics. Vkladaj sem len kód, ktorému dôveruješ.', 6000),
        ],
    ];
}

$groups = settings_groups();
$errors = [];

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    Csrf::require();

    $v      = new Validate($_POST);
    $values = [];

    foreach ($groups as $fields) {
        foreach ($fields as $f) {
            $values[$f->name] = match ($f->type) {
                'bool'     => (string) $v->bool($f->name),
                'textarea' => $v->multiline($f->name, $f->label, $f->required, $f->max),
                'url'      => $v->url($f->name, $f->label, $f->required),
                'email'    => $v->email($f->name, $f->label, false),
                'datetime' => $v->dateTime($f->name, $f->label, $f->required),
                'media'    => (string) $v->int($f->name, $f->label, 0, null, 0),
                default    => $v->text($f->name, $f->label, $f->required, $f->max),
            };
        }
    }

    // Meracie kódy sa vkladajú do stránky bez filtrovania — preto ich smie
    // meniť len správca, nie bežný redaktor.
    if (!Auth::isAdmin()) {
        $values['analytics_head'] = Settings::get('analytics_head');
    }

    if (!$v->ok()) {
        $errors = $v->errors();
        flash('err', 'Skontroluj označené políčka — ostatné zmeny sa neuložili.');
    } else {
        Settings::setMany($values);
        Settings::bumpContentVersion();
        AuditLog::write('update', 'settings', '', ['pocet' => count($values)]);
        flash('ok', 'Nastavenia sú uložené.');
        redirect('nastavenia.php');
    }
}

$e = static fn (?string $v): string => Html::e((string) $v);

/** Hodnota do formulára — po chybe sa vráti to, čo používateľ napísal. */
$valueOf = static function (CrudField $f) use ($errors): mixed {
    if ($errors !== [] && array_key_exists($f->name, $_POST)) {
        return $f->type === 'bool' ? (int) (bool) ($_POST[$f->name] ?? 0) : (string) $_POST[$f->name];
    }
    $raw = Settings::get($f->name);
    return match ($f->type) {
        'bool'     => Settings::bool($f->name) ? 1 : 0,
        // Políčko `datetime-local` chce tvar 2027-05-07T14:00.
        'datetime' => $raw === '' ? '' : date('Y-m-d\TH:i', strtotime($raw) ?: 0),
        'media'    => $raw === '' ? '' : (int) $raw,
        default    => $raw,
    };
};

admin_head('Nastavenia', 'nastavenia');
?>

<form class="form form--wide" method="post" novalidate>
  <?= Csrf::field() ?>

<?php foreach ($groups as $groupName => $fields): ?>
  <section class="panel settings-group">
    <h2><?= $e($groupName) ?></h2>
<?php foreach ($fields as $f):
    if ($f->name === 'analytics_head' && !Auth::isAdmin()) {
        echo '<p class="muted small">Meracie kódy môže meniť len správca.</p>';
        continue;
    }
    field_render($f, $valueOf($f), $errors);
endforeach; ?>
  </section>
<?php endforeach; ?>

  <div class="form__foot" style="position:sticky;bottom:0;background:var(--bg);padding:14px 0">
    <button class="btn" type="submit">Uložiť nastavenia</button>
    <a class="btn btn--ghost" href="../index.php" target="_blank" rel="noopener">Pozrieť web ↗</a>
  </div>
</form>

<?php
media_picker_render();
admin_foot();
