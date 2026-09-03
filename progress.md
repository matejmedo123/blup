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
- [x] Testy: 93 backendových + 18 E2E kontrol cez celý cyklus objednávky
- [x] Finálny audit, build, zabalenie

Overené: čistá inštalácia z balíka, objednávka cez prehliadač na mobile,
prijatie a preklikanie objednávky v admine, e-maily, doklad, CSV export.

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
