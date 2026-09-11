# Majáles Nitra 2027

Web festivalu Majáles Nitra s kompletnou správou obsahu.
Jedna dlhá stránka, všetko na nej sa dá zmeniť z admin rozhrania.

> **Nasadenie:** krok za krokom v [`NAVOD-WEBSUPPORT.md`](./NAVOD-WEBSUPPORT.md)
> **Balík na nahratie:** `majales-web.zip` (vyrobí `bash scripts/pack.sh`)

**7. – 8. máj 2027 · Areál Agrokomplex, Nitra**

---

## Prečo PHP a nie statický web

Zadanie znelo: *admin a databáza cez Websupport, aby sa dali meniť veci.*
Websupport ponúka PHP 8 a MySQL — žiadny Node, žiadne dlho bežiace procesy.

Stránka sa preto skladá **na serveri priamo z databázy**. Keď obsluha
v admine zmení text, je na webe pri ďalšom načítaní. Pri statickom exporte
(Next.js a podobne) by sa po každej zmene musel web nanovo postaviť
a nahrať — pre marketingový web, ktorý sa počas sezóny mení denne,
je to zbytočná prekážka.

| Vrstva | Použité |
|---|---|
| Stránka | PHP 8.1+ šablóna, obsah z MySQL |
| Štýly | Vlastné CSS, rozloženie cez media queries (nie cez JS) |
| Skripty | Vanilla JS, ~10 kB, bez knižníc |
| Databáza | MySQL/MariaDB, alternatívne SQLite na vývoj |
| Písma | Anton + Inter uložené priamo na hostingu (SIL OFL) |
| Obrázky | GD — prekreslenie, zmenšenie, prevod na WEBP |
| Závislosti | **žiadne** — bez composeru, bez npm |

---

## Štruktúra

```
index.php              celá verejná stránka
404.php                stránka sa nenašla
robots.php             robots.txt (rešpektuje prepínač indexovania)
sitemap.php            sitemap.xml
install.php            jednorazová inštalácia — po nej zmazať

admin/                 správa webu (prihlásenie cez session)
  index.php            prihlásenie
  dashboard.php        prehľad, rýchle prepínače, „čo ešte doplniť"
  obsah.php            všetky texty stránky po sekciách
  zoznam.php           zoznam položiek ľubovoľného typu
  polozka.php          pridanie a úprava položky
  media.php            knižnica fotiek
  odberatelia.php      newsletter + export CSV
  nastavenia.php       údaje o podujatí, odkazy, prepínače
  pouzivatelia.php     účty a role (len správca)
  audit.php            denník zmien (len správca)

api/
  prihlasit.php        odber noviniek
  odhlasit.php         odhlásenie cez odkaz z e-mailu

lib/                   doménová logika — pravidlá patria sem, nie do šablón
sql/                   schéma pre MySQL aj SQLite + počiatočný obsah
assets/                CSS, JS, písma, logo, listy, video
uploads/               nahraté fotky (mimo gitu)
storage/               logy, maily v dev režime, SQLite (mimo gitu)
tests/                 testy backendu a bezpečnosti
```

---

## Vývoj

```bash
bash scripts/dev-server.sh      # spustí web na SQLite, http://localhost:8099
php tests/run.php               # testy backendu (129 kontrol)
php tests/security.php          # bezpečnostné kontroly (32 kontrol, proti bežiacemu serveru)
php tests/reset-dev.php         # vráti vývojovú inštanciu do východiskového stavu
bash scripts/pack.sh            # zabalí do majales-web.zip
```

Prihlásenie do vývojového adminu: **majales / MajalesHeslo2027**

---

## Nemenné pravidlá

1. **Databáza je zdroj pravdy.** Šablóna nič nedopĺňa natvrdo — keď
   obsah chýba, ostane prázdne miesto s popisom, nie vymyslený text.
2. **Ceny sú celé centy (`int`).** Nikdy float. Formátovanie cez `Money`.
3. **Cena sa neukáže, kým predaj nebeží.** Aj keď už v databáze je.
   Rozhoduje prepínač `sale_live`, nie prítomnosť ceny.
4. **Autorizácia je vždy na serveri.** Skrytie položky v menu nie je ochrana —
   každá stránka adminu si rolu overuje sama.
5. **Do stránky nič nejde surové.** Všetko cez `Html::e()`.
   Jediná výnimka sú meracie kódy v nastaveniach — tie smie meniť len správca.
6. **Odkazy od obsluhy prechádzajú cez `Html::safeUrl()`.**
   `javascript:` a `data:` sa zahodia.
7. **Nahratý obrázok sa nikdy neuloží tak, ako prišiel.** Prekreslí sa
   cez GD — tým z neho vypadne všetko, čo nie je obraz.
8. **Interpret bez adresy (`slug`) neexistuje.** Odvodí sa z mena v repozitári,
   nie vo formulári.
9. **Zmena obsahu zvýši `content_version`.** Na ňom stojí ETag, takže
   prehliadač drží stránku v cache presne dovtedy, kým sa niečo nezmení.
10. **Denník zmien sa nemaže po kúskoch** — dá sa len orezať podľa veku.

---

## Ako je riešená editovateľnosť

Šesť zoznamov (interpreti, vstupenky, otázky, zóny, galéria, partneri)
sa v admine správa rovnako: pridať, upraviť, skryť, posunúť, zmazať.
Namiesto šiestich takmer rovnakých stránok je jeden popis v
`lib/CrudSpec.php` a dve stránky, ktoré ho vykreslia. Nový typ obsahu
znamená pridať tabuľku, triedu s dvoma metódami a záznam v `CrudSpec`.

Texty, ktoré nie sú zoznamom (nadpisy, popisky tlačidiel, odseky),
sú v tabuľke `blocks`. Kľúč používa šablóna, hodnotu mení obsluha.
Keď blok chýba, šablóna dostane prázdny reťazec — stránka sa nerozbije.

---

## Prístupnosť a výkon

- Sémantické HTML, jeden `h1`, správna hierarchia nadpisov
- Skip link, viditeľné focus stavy, focus pasca v modáloch
- `Escape` zatvára modál, lightbox aj mobilné menu
- Dotykové ciele min. 44 px na webe aj v admine
- Rešpektuje `prefers-reduced-motion` — animácie sa vypnú
- **Funguje bez JavaScriptu**: obsah je v HTML, odpočet má hodnoty
  zo servera, odber noviniek funguje obyčajným formulárom
- Obrázky majú `width`/`height`, takže sa stránka pri načítaní netrhá
- Písma sa nesťahujú z Google — rýchlejšie a bez posielania adries
  návštevníkov tretej strane
- ETag na obsahovej verzii: opakovaná návšteva vracia 304

---

## Vizuál

Podľa dizajnového zadania `Festival_branding_2027`.

| Farba | HEX |
|---|---|
| Sky blue | `#2BA9E1` |
| Festival blue | `#1476BE` |
| Deep blue | `#0A4E85` |
| Sun yellow | `#FFF200` |
| Leaf green | `#8DC63F` |
| Ink | `#101418` |

Písma: **Anton** (nadpisy, mená, bežiace pásy), **Inter** (text).
Zlom rozloženia na 768 px.

---

## Čo web zatiaľ nerobí

- **Nepredáva vstupenky.** Karty vedú na externý predajný systém
  (odkaz v Nastaveniach). Napojenie platobnej brány by bolo ďalšie kolo.
- **Nerozposiela newsletter.** Zbiera e-maily a exportuje ich do CSV
  pre Mailchimp, Ecomail a podobne.
- **Nemá viac jazykov.** Celý web je po slovensky.

## Otvorené otázky pre zadávateľa

- Fotografie sú zatiaľ prázdne miesta — treba dodať fotky z minulých
  ročníkov (galéria, zóny, interpreti, partneri, náhľad aftermovie).
- Ceny vstupeniek nie sú určené (v návrhu boli označené ako „ČOSKORO").
- Chýbajú odkazy na sociálne siete festivalu a na playlist na Spotify.
- Lineup je z návrhu — pred spustením treba potvrdiť, ktoré mená sú
  naozaj potvrdené a ktoré ešte nie.
