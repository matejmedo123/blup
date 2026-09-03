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
Prebieha. Stav jednotlivých úloh nižšie.

- [x] Audit oproti zadaniu, `CLAUDE.md`, `progress.md`
- [ ] Migrácia databázy v2 (história stavov, platby, zóny, hodiny, audit,
      idempotencia, kupóny, modifier groups, indexy)
- [ ] State machine s validáciou prechodov + ochrana proti súbehu
- [ ] Idempotencia objednávky a platobného webhooku
- [ ] Otváracie hodiny, doručovacie zóny, kupóny
- [ ] Modifier groups s povinnosťou a min/max
- [ ] RBAC admin/staff, audit log, jednotné chybové kódy
- [ ] Platby ako samostatná entita + analytika
- [ ] Mobilná verzia adminu, doladenie webu na telefóne
- [ ] Testy — unit, integračné, E2E
- [ ] Finálny audit, build, zabalenie

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
