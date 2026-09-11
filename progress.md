# Priebeh prác

Krátky denník stavu, aby sa dalo nadviazať tam, kde sa skončilo.
Podrobné porovnanie so zadaním je v `docs/AUDIT.md`, pravidlá v `CLAUDE.md`.

## Hotové

### Kolo 1 — web
Statický web (Next.js 16, statický export), značka ENZO Smash Burgers & Pizza
Koniarovce, menu zo 40 položiek, logá, favicon, OG obrázok, ZIP pre Websupport
a návod na nasadenie.

### Kolo 2 — objednávkový backend
PHP 8 + PDO (MySQL aj SQLite), verejné API, e-maily s dokladom a časom
prípravy, admin so živým prehľadom a odklikávaním minút, editor menu
a nastavení, platba hotovosťou aj kartou cez Stripe, účtovníctvo s CSV
exportom, inštalátor, bezpečnostné opatrenia. Otestované end-to-end
z čistej inštalácie.

### Kolo 3 — dotiahnutie na špecifikáciu + mobil

- [x] Audit oproti zadaniu, `CLAUDE.md`, `progress.md`
- [x] Migrácie databázy s evidenciou; nové tabuľky pre históriu stavov,
      platby, zóny, hodiny, kupóny, varianty, audit a idempotenciu
- [x] Stavový automat s validáciou prechodov + ochrana proti súbehu
- [x] Idempotencia objednávky aj platobného webhooku
- [x] Otváracie hodiny, doručovacie zóny, kupóny
- [x] Varianty s povinnosťou a min/max výberom
- [x] RBAC admin/obsluha, audit log, jednotné chybové kódy
- [x] Platby ako samostatná entita + analytika prevádzky
- [x] Mobilná verzia adminu, doladenie webu na telefóne
- [x] Nástenka pípa, kým je objednávka nepotvrdená (zvuk, vibrácie, blikajúci titulok)
- [x] Automatické predlžovanie sľúbených časov podľa vyťaženia kuchyne
- [x] Testy: 122 backendových + 32 E2E kontrol cez celý cyklus objednávky
- [x] Finálny audit, build, zabalenie

Overené: čistá inštalácia z balíka (rozbalený ZIP, vlastný config, migrácie,
seed, beh pod `php -S`), objednávka cez prehliadač na mobile, prijatie
a preklikanie objednávky v admine, e-maily, doklad, CSV export.

### Kolo 4 — Majáles Nitra 2027 (nový web v `majales/`)

Druhý, samostatný web v tom istom repozitári: festivalová stránka
Majáles Nitra podľa dizajnového zadania `Festival_branding_2027`.

Postavený ako **PHP monolit renderovaný z MySQL** — nie ako statický
export. Dôvod: zadanie znelo „admin a databáza cez Websupport, aby sa
dali meniť veci". Pri statickom exporte by sa po každej zmene textu
musel web nanovo postaviť a nahrať; takto je zmena z adminu na webe
okamžite.

- [x] Schéma (MySQL aj SQLite), migrácie, inštalátor, počiatočný obsah z návrhu
- [x] Celá stránka podľa zadania: hero s videom a odpočtom, bežiace pásy,
      galéria s lightboxom, zóny, lineup s modálom, vstupenky, aftermovie,
      FAQ, mapa, partneri, pätička s newsletterom a konfetami
- [x] Admin: texty po sekciách, 6 zoznamov cez jeden spoločný CRUD,
      knižnica fotiek s prevodom na WEBP, nastavenia, role, denník zmien
- [x] Newsletter so zberom e-mailov, odhlásením a exportom do CSV
- [x] Bezpečnosť: CSRF, brzda pokusov, RBAC na serveri, ochrana priečinkov,
      pascička na roboty, prekreslenie nahratých obrázkov
- [x] Web funguje aj bez JavaScriptu; video sa na telefóne vôbec nesťahuje
- [x] Testy: 129 backendových + 32 bezpečnostných + 5 prehliadačových scenárov
- [x] Overené čistou inštaláciou z balíka `majales-web.zip`

Otvorené otázky sú v [`majales/README.md`](./majales/README.md) na konci.

## Ako pokračovať

```bash
git status && git log --oneline -5
npm run test:all          # čo je zelené a čo nie
cat docs/AUDIT.md         # čo zo zadania ešte chýba
```

Lokálny beh backendu bez MySQL:

```bash
bash scripts/dev-server.sh    # postaví SQLite inštanciu a spustí php -S
```

## Otvorené otázky pre zákazníka

- Cena Kofoly 2,00 € je odhad — na tlačenom menu nebola.
- Doručovacie zóny a ich poplatky treba potvrdiť (zatiaľ jedna zóna
  Koniarovce s poplatkom 2,50 €, zdarma od 35 €).
- Otváracie hodiny sú prepísané z podkladov; overiť sviatky.
