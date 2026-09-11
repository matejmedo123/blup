<?php
declare(strict_types=1);

/**
 * Popis jedného zoznamu v admine — ktorá trieda ho spravuje, ako sa volá
 * a aké má políčka. Vďaka tomu má všetkých šesť zoznamov (interpreti,
 * vstupenky, otázky, zóny, galéria, partneri) jeden spoločný, otestovaný
 * kód namiesto šiestich takmer rovnakých stránok.
 */
final class CrudSpec
{
    /**
     * @param class-string<Repo> $repo
     * @param list<CrudField> $fields
     */
    public function __construct(
        public readonly string $key,
        public readonly string $repo,
        public readonly string $titlePlural,
        public readonly string $titleSingle,
        public readonly string $listColumn,
        public readonly array $fields,
        public readonly string $intro = '',
        public readonly bool $hasMedia = false,
    ) {
    }

    /** @return array<string,CrudSpec> */
    public static function all(): array
    {
        static $specs = null;
        if ($specs !== null) {
            return $specs;
        }

        $specs = [
            'interpreti' => new self(
                key: 'interpreti',
                repo: Artists::class,
                titlePlural: 'Interpreti',
                titleSingle: 'Interpret',
                listColumn: 'name',
                intro: 'Poradie na stránke sa riadi šípkami. Headliner je len jeden — keď označíš nového, predchádzajúci sa odznačí sám.',
                hasMedia: true,
                fields: [
                    new CrudField('name', 'Meno interpreta', 'text', true, 'Píše sa veľkými písmenami, napr. VENGABOYS.', 160, inList: true),
                    new CrudField('tag', 'Žáner', 'text', false, 'Krátky popisok pod menom, napr. POP / RAP.', 80, inList: true),
                    new CrudField('bio', 'Popis', 'textarea', false, 'Zobrazí sa po kliknutí na kartu interpreta.', 2000),
                    new CrudField('media_id', 'Fotka', 'media', false, 'Na výšku aj na šírku — orežeme ju na potrebný pomer.'),
                    new CrudField('is_headliner', 'Headliner', 'bool', false, 'Zobrazí sa vo veľkom páse nad ostatnými.', inList: true),
                    new CrudField('badge', 'Odznak headlinera', 'text', false, 'Napríklad HEADLINER 2027. Ukáže sa len pri headlinerovi.', 80),
                    new CrudField('url_facebook', 'Facebook', 'url'),
                    new CrudField('url_instagram', 'Instagram', 'url'),
                    new CrudField('url_spotify', 'Spotify', 'url'),
                    new CrudField('url_youtube', 'YouTube', 'url'),
                ],
            ),

            'vstupenky' => new self(
                key: 'vstupenky',
                repo: Tickets::class,
                titlePlural: 'Vstupenky',
                titleSingle: 'Typ vstupenky',
                listColumn: 'title',
                intro: 'Ceny sa na webe ukážu až vtedy, keď v Nastaveniach zapneš „Predaj vstupeniek beží". Dovtedy je na kartách nápis ČOSKORO.',
                fields: [
                    new CrudField('title', 'Názov', 'text', true, '', 120, inList: true),
                    new CrudField('subtitle', 'Podnadpis', 'text', false, 'Napríklad „Celý festival, piatok + sobota".', 190),
                    new CrudField('benefits', 'Čo je v cene', 'textarea', false, 'Každý riadok je jedna odrážka so zelenou fajkou.', 1000),
                    new CrudField('price_cents', 'Cena', 'price', false, 'Napríklad 24,90. Nechaj prázdne, kým cenu neviete.', inList: true),
                    new CrudField('badge', 'Štítok nad kartou', 'text', false, 'Napríklad NAJVÝHODNEJŠÍ.', 60),
                    new CrudField('highlight', 'Zvýrazniť žltou', 'bool', false, 'Karta bude žltá a vyššia ako ostatné.'),
                    new CrudField('buy_url', 'Odkaz na kúpu', 'url', false, 'Nechaj prázdne a použije sa spoločný odkaz z Nastavení.'),
                ],
            ),

            'otazky' => new self(
                key: 'otazky',
                repo: Faqs::class,
                titlePlural: 'Časté otázky',
                titleSingle: 'Otázka',
                listColumn: 'question',
                fields: [
                    new CrudField('question', 'Otázka', 'text', true, '', 255, inList: true),
                    new CrudField('answer', 'Odpoveď', 'textarea', true, 'Zalomenie riadku ostane zachované.', 4000),
                ],
            ),

            'zony' => new self(
                key: 'zony',
                repo: Zones::class,
                titlePlural: 'Zóny',
                titleSingle: 'Zóna',
                listColumn: 'title',
                intro: 'Karty v sekcii „Viac než koncerty".',
                hasMedia: true,
                fields: [
                    new CrudField('title', 'Názov zóny', 'text', true, '', 120, inList: true),
                    new CrudField('description', 'Popis', 'textarea', false, 'Jedna až dve vety.', 500),
                    new CrudField('media_id', 'Fotka', 'media'),
                ],
            ),

            'galeria' => new self(
                key: 'galeria',
                repo: Gallery::class,
                titlePlural: 'Galéria',
                titleSingle: 'Fotka v galérii',
                listColumn: 'caption',
                intro: 'Na webe sa ukážu len fotky, ktoré naozaj majú nahratý obrázok. Kliknutím na fotku sa návštevníkovi otvorí na celú obrazovku.',
                hasMedia: true,
                fields: [
                    new CrudField('caption', 'Popis fotky', 'text', false, 'Slúži aj ako text pre čítačky obrazovky.', 190, inList: true),
                    new CrudField('media_id', 'Fotka', 'media', true),
                ],
            ),

            'partneri' => new self(
                key: 'partneri',
                repo: Partners::class,
                titlePlural: 'Partneri',
                titleSingle: 'Partner',
                listColumn: 'name',
                intro: 'Logá sa zobrazujú na bielom podklade — najlepšie fungujú súbory s priehľadným pozadím (PNG).',
                hasMedia: true,
                fields: [
                    new CrudField('name', 'Názov partnera', 'text', true, '', 160, inList: true),
                    new CrudField('media_id', 'Logo', 'media'),
                    new CrudField('url', 'Odkaz na web', 'url'),
                ],
            ),
        ];

        return $specs;
    }

    public static function get(string $key): ?self
    {
        return self::all()[$key] ?? null;
    }

    /** @return list<CrudField> */
    public function listFields(): array
    {
        return array_values(array_filter($this->fields, static fn (CrudField $f): bool => $f->inList));
    }

    /**
     * Prevedie odoslaný formulár na hodnoty pre databázu.
     *
     * @param array<string,mixed> $post
     * @return array{0:array<string,mixed>,1:Validate}
     */
    public function readForm(array $post, ?int $id = null): array
    {
        $v    = new Validate($post);
        $data = [];

        foreach ($this->fields as $f) {
            $data[$f->name] = match ($f->type) {
                'textarea' => $v->multiline($f->name, $f->label, $f->required, $f->max),
                'url'      => $v->url($f->name, $f->label, $f->required),
                'price'    => $v->priceCents($f->name, $f->label),
                'bool'     => $v->bool($f->name),
                'media'    => ($mid = $v->int($f->name, $f->label, 0, null, 0)) > 0 ? $mid : null,
                default    => $v->text($f->name, $f->label, $f->required, $f->max),
            };

            if ($f->type === 'media' && $f->required && $data[$f->name] === null) {
                $v->fail($f->name, $f->label . ' treba vybrať.');
            }
        }

        // Interpret má adresu odvodenú z mena — je v nej odkaz z modálu.
        if ($this->repo === Artists::class) {
            $data['slug'] = Artists::uniqueSlug((string) ($data['name'] ?? ''), $id);
        }

        return [$data, $v];
    }
}
