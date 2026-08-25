# Aktualizácia bežiacej inštalácie

Toto je postup pre prípad, keď na `blup.sk` **už beží staršia verzia a v databáze
sú skutočné dáta** — účty, eventy, prihlásenia. Nič sa nemaže a nič sa nemusí
zakladať odznova.

Počítaj s **20 minútami**, z toho väčšina je čakanie na build.

> **Zálohu si sprav aj tak.** Supabase → **Database → Backups → Create backup**.
> Trvá to minútu a je to jediná vec v tomto postupe, ktorá sa nedá vrátiť späť,
> ak ju vynecháš.

---

## 1 · Databáza (3 minúty)

```bash
npx supabase db push
```

Aplikuje sa **10 nových migrácií** (počítané od verzie, v ktorej si hlásil tie
chyby). Existujúce tabuľky sa nemažú ani neprepisujú; pridávajú sa stĺpce a
funkcie.

Nemusíš mi to veriť — `db push` sám vypíše, ktoré aplikuje, a čo je už v
databáze preskočí. Zoznam toho, čo tam už je, si pozrieš takto:

```bash
npx supabase migration list
```

Tri z nich sa dotknú tvojich dát, tak nech vieš, čo robia:

**Adresy eventov.** Každý event dostane `slug` z názvu. **Staré odkazy s uuid
fungujú ďalej** — nič, čo si komu poslal, neprestane fungovať.

**Prepočet počítadiel.** Toto je dôležité. V starej verzii bola chyba, ktorá
držala `attendee_count`, `view_count` a ďalšie na nule — preto mapa hlásila
„0 ide". Oprava mechanizmu by sama od seba staré eventy nespravila; opravili by
sa až pri ďalšom prihlásení, čo pri prebehnutom evente nenastane nikdy. Migrácia
ich preto **prepočíta zo zdrojových tabuliek**, ktoré boli celý čas správne.
Vypíše, koľkých eventov sa to týkalo:

```
NOTICE:  Counters recomputed on 42 events
```

Zobrazenia sa nikdy neznížia — ak databáza pozná viac, než je v `event_views`,
nechá si vyššie číslo.

**Košík.** Jedno obmedzenie sa mení na čiastočný index, aby sa dali držať
konkrétne sedadlá. Ak má niekto práve otvorený košík, rezervácia mu vydrží.

**✓ Kontrola:**

```sql
select count(*) from public.legal_documents where published_at is not null;
-- musí vrátiť 3

select count(*) from public.events where slug is null;
-- musí vrátiť 0
```

---

## 2 · Serverové funkcie (2 minúty)

```bash
npx supabase functions deploy
```

Nasadí sa **16 funkcií**, z toho jedna nová: **`og`** — tá, ktorá robí náhľad
odkazu na Instagrame a vo WhatsApp. Bez nej sa zdieľané eventy budú ďalej
zobrazovať s generickou kartou.

Nové premenné prostredia netreba. Ak si už raz spustil `supabase secrets set`,
funkcie si ich načítajú samy.

**✓ Kontrola:**

```bash
curl "https://<project-ref>.supabase.co/functions/v1/og?ref=test"
```

Musí vrátiť HTML s `og:title`, nie chybu.

---

## 3 · Web (10 minút, väčšinou čakanie)

```bash
cd mobile
npm install
npm run build:web
```

`npm install` je tu preto, že pribudli závislosti. Build vypíše na konci, koľko
pravidiel pre náhľady zapísal — ak uvidíš varovanie o `EXPO_PUBLIC_SUPABASE_URL`,
`mobile/.env` nie je vyplnený a **náhľady odkazov fungovať nebudú**.

Potom nasaď obsah `mobile/dist` tak, ako si zvyknutý:

```bash
# Vercel
cd dist && vercel --prod

# Websupport — cez FTP, celý obsah dist do web/, aj skryté súbory
```

> **Nahraj `.htaccess` znova.** Vygeneroval sa nanovo a **pribudli v ňom
> pravidlá pre náhľady odkazov**. Starý súbor by fungoval, ale Instagram by
> ďalej ukazoval generickú kartu.

**✓ Kontrola:** otvor `https://blup.sk` a pozri sa na názov v záložke
prehliadača. Musí byť **„Blup — eventy okolo teba"**, nie `blup.sk`. Ak vidíš
`blup.sk`, na server sa dostal starý build.

---

## 4 · Nastavenia, ktoré si možno ešte nespravil (5 minút)

Tieto sa nedajú nasadiť z kódu — sú v Supabase.

| Kde | Čo | Prečo |
| --- | --- | --- |
| **Authentication → URL Configuration** | `Site URL` = `https://blup.sk` | Inak potvrdzovací odkaz v e-maile vedie na `localhost` |
| **Authentication → Emails → SMTP** | Resend, podľa Fázy 5c v `SPUSTENIE.md` | Bez toho chodia 2 e-maily za hodinu a len členom tímu |
| **Authentication → Rate Limits** | *Emails per hour* z `2` na `100` | Tretia registrácia v hodine inak ticho odpadne |
| **Authentication → Providers → Google** | Client ID a Secret | Tlačidlo sa objaví samo, keď je zapnuté |

---

## Čo sa po aktualizácii zmení pre ľudí, ktorí už appku používajú

Nič sa im nestratí — účty, vstupenky ani uložené eventy. Zmení sa toto:

- **Adresy eventov** sa im v prehliadači prepíšu na čitateľné. Staré fungujú ďalej.
- **Profily** odpovedajú aj na `@meno`.
- **Počítadlá** prestanú ukazovať nuly — u eventov, kde ich mali, čísla naskočia naraz.
- **Feed** má tri záložky a otvorí sa na tej, kde niečo je.
- **Pri registrácii** treba súhlas s podmienkami; existujúcich používateľov sa to netýka.
- **Organizátori** musia pri ďalšom overení prijať zmluvu. Už overené organizácie
  bežia ďalej, ale zmluvu podpísanú nemajú — ak ju chceš aj od nich, pošli im
  odkaz na `/legal/agreement` a nechaj ich prejsť overením znova.

---

## Keď sa niečo pokazí

| Príznak | Čo s tým |
| --- | --- |
| `db push` sa zastaví na chybe | Nič sa nezapísalo — Postgres migráciu vracia celú. Pošli mi text chyby. |
| Počítadlá stále na nule | Migrácia `20260101003800` nedobehla; pusti `npx supabase db push` znova a sleduj `NOTICE: Counters recomputed` |
| V záložke je `blup.sk` | Na serveri je starý build — nahraj `dist` znova |
| `/event/nieco` vracia 404 | Nenahral sa `.htaccess` (FTP ho skrýva) alebo `vercel.json` |
| Náhľad na Instagrame je generický | Buď chýba nasadená funkcia `og`, alebo je na serveri starý `.htaccess` |
| Potvrdzovací odkaz vedie na localhost | `Site URL` v Supabase, krok 4 |

---

## Ak si chceš byť istý pred nasadením

```bash
./scripts/verify-db.sh
```

Postaví dočasnú databázu, aplikuje **všetkých 40 migrácií od nuly** a prejde
**188 tvrdení**. Tvojej databázy sa to nedotkne. Ak toto prejde a `db push`
potom zlyhá, chyba je v tvojich dátach, nie v schéme — a to je pri hľadaní
veľmi cenné vedieť.
