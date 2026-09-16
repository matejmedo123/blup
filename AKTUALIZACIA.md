# Aktualizácia bežiacej inštalácie

Toto je postup pre prípad, keď na `blup.sk` **už beží staršia verzia a v databáze
sú skutočné dáta** — účty, eventy, prihlásenia. Nič sa nemaže a nič sa nemusí
zakladať odznova.

Počítaj s **20 minútami**, z toho väčšina je čakanie na build.

> **Zálohu si sprav aj tak.** Supabase → **Database → Backups → Create backup**.
> Trvá to minútu a je to jediná vec v tomto postupe, ktorá sa nedá vrátiť späť,
> ak ju vynecháš.


---

## Čo je nové v tomto balíku

Zo šiestich vecí z tvojho testovania. Pri každej je aj to, čo presne bolo zle.

**Vstupenky**

- **Vidíš, kto príde.** *Organizátor → pri evente „Kto príde"* (a aj zo
  *Štatistík eventu*): zoznam s **menom, adresou, na ktorú vstupenka odišla, a
  kódom vstupenky**. Nad ním počty — platné, použité, neplatné. Hľadá sa v ňom
  podľa mena, e-mailu aj kódu.
- **Jednu vstupenku sa dá vypnúť a zase zapnúť.** Deaktivovaná vstupenka
  **naozaj neprejde pri vstupe** — skener odmieta všetko, čo nie je platné —
  a držiteľovi príde upozornenie s dôvodom, ktorý napíšeš. Znovuaktivovanie
  zmaže aj odbavenie, takže vstupenka funguje ešte raz a potom je *použitá*.
  Vrátená (refundovaná) vstupenka sa znovu zapnúť nedá; to je rozhodnutie o
  peniazoch, nie o dverách.
- Kto to smie: **tvorca eventu, majiteľ/admin/event manager organizácie a
  admin BLUPu.** Nikto iný tie mená a adresy ani neuvidí — kontrola je v
  databáze, nie v appke. Každé vypnutie a zapnutie sa zapisuje do auditu.

**Objav**

- **„Stojí za cestu."** Keď si z Nitry a v Bratislave je koncert, ktorý sedí na
  tvoj vkus a ide naň veľa ľudí, uvidíš ho na domovskej stránke vo vlastnom
  páse. Berie sa 50 – 220 km a len to, čo prejde cez dosť vysokú latku — inak by
  to bol druhý feed, nie tip.

**Vytváranie eventu**

- **Tlačidlá v orezávaní fotky majú konečne text.** Boli tam celý čas: nápis mal
  farbu `accentText`, čo je **tá istá modrá ako pozadie tlačidla**, takže modré
  písmená na modrom tlačidle. A skratka `font: 700 15px/1 inherit` je neplatná,
  takže ju prehliadač zahodil celú. Teraz je popis biely a veľkosť sa nastavuje
  po vlastnostiach.
- **Admin vie pridať event „ako BLUP".** Pri vytváraní eventu je prepínač
  *Pridať ako BLUP* a dve políčka: **kto to naozaj organizuje** a **odkaz na
  zdroj**. Tak sa dajú na začiatku ručne pridávať cudzie eventy bez toho, aby
  to vyzeralo, že ich robíme my. Na taký event sa nedajú predávať vstupenky —
  cudzie peniaze cez náš účet nepotečú.

**Na telefóne**

- **Potiahnutie nadol obnoví stránku.** Nefungovalo z dvoch dôvodov naraz:
  súbor `usePullToRefresh.ts` prekrýval webovú verziu `.web.tsx` (**tá istá
  pasca s príponami ako pri cookies** — Metro berie prvú príponu, `ts` je pred
  `tsx`), a keď sa to odkrylo, poslucháči sa odpájali a pripájali pri každom
  vykreslení — nameraných **728-krát ešte pred prvým dotykom**, takže pohyb
  prsta pristál na už zrušenom poslucháčovi. Aby sa to nestalo tretíkrát,
  `scripts/check-platform-files.mjs` odteraz odmietne dvojicu súborov s
  rozdielnou príponou.

**E-maily so vstupenkami**

- Queue je v poriadku a testy to pokrývajú — **chýba nasadenie a cron**. Aby to
  už nebolo neviditeľné: *Admin → prehľad* ukazuje **koľko e-mailov čaká, ako
  starý je najstarší a koľko zlyhalo**. Keď najstarší čaká dlhšie ako 10 minút,
  cron nebeží. Rýchla kontrola z príkazového riadka: `./scripts/check-emails.sh`.

**Nahrávanie webu**

- **`blup-config.js` vedľa `index.html`.** Build si doteraz zapiekol adresu
  backendu v momente, keď vznikol — a balík vyrobený proti lokálnej databáze sa
  na doméne načíta úplne v poriadku a **nehovorí s ničím**. Tichšie to zlyhať
  nevie. Odteraz sa dá ten istý balík nasmerovať prepísaním jedného súboru na
  hostingu, bez buildovania. Nič tajné v ňom nie je — `anon key` si aj tak
  stiahne každý návštevník a dáta chráni RLS. `service_role` tam nepatrí a
  kontrola `check-origin --dist` to odmietne.

**✓ Rýchla kontrola po nasadení**

```sql
-- kto príde na event (spusti ako organizátor, nie service_role)
select code, holder_name, email, status
from public.event_ticket_holders('<event-id>');

-- vypnutie jednej vstupenky
select status from public.set_ticket_active('<ticket-id>', false, 'test');
-- ... a skener ju musí odmietnuť
select public.check_in_ticket('<kod>', '<qr_secret>');   -- reason: CANCELLED
```

---

## Čo bolo nové v predchádzajúcom balíku

Toto je zoznam vecí z tvojho posledného testovania. Pri každej je aj to, čo
presne bolo zle — nie preto, aby to znelo dôkladne, ale aby si vedel, čo presne
overiť.

**Peniaze a vstupenky**

- **DPH.** Zapína sa v *Organizátor → Verejný profil a logo → DPH*, sadzba je
  prednastavená na 23 %. **Kupujúci vidí a platí plnú sumu** — pri cene mu
  pribudne len poznámka `(s DPH 23 %)`, na vstupenke, v košíku aj v pokladni.
  **Rozpad brutto / netto / DPH vidíš len ty**, v *Účtovníctve* a v štatistike
  eventu. Počíta sa z celej tržby za obdobie, nie sčítaním zaokrúhlení po
  vstupenkách, takže to sedí s tým, čo ide do priznania.
- **Na jednu objednávku ide najviac 10 vstupeniek** (bolo 20). Číslo je v
  `platform_settings.max_tickets_per_order`, dá sa zmeniť bez nasadenia.
- **Plávajúci košík.** Po pridaní vstupenky ťa sleduje bublina s počtom; po
  kliknutí ponúkne *Prejsť do pokladne* alebo *Pokračovať v nákupe*. Predtým to
  bolo len číslo v bočnom menu, ktoré si nikto nevšimol — a rezervácie medzitým
  ticho vypršali.
- **Onboarding výplat** už nemlčí. Ak organizácia ešte nie je overená, pošle ťa
  rovno na formulár overenia; ak zlyhá čokoľvek iné, napíše čo.

**Zobrazenia**

- **Zobrazenie sa počíta, len keď niekto otvorí event.** Predtým sa počítalo aj
  pri prejdení kartou vo feede, a navyše sa zapisovalo vo funkcii, ktorá načítava
  event — takže jedno otvorenie pripočítalo tri. Nová verzia počíta jedného
  návštevníka raz za pol hodiny.

**Vytváranie eventu**

- **Naozajstný kalendár a hodiny** namiesto písania `YYYY-MM-DD`.
- **Návrhy adries počas písania**; Enter adresu potvrdí a **špendlík sa naozaj
  presunie** tam, kde adresa je.
- **Mapa v evente** ukazuje event, nie miesto, kde práve stojíš.
- Pri *Viac dní* už nie je nad políčkom napísané „Koniec Začiatok".
- **Titulná fotka** si drží svoje proporcie, malú fotku nezväčšuje a formulár
  píše odporúčaný rozmer aj to, čo sa naozaj nahralo.
- **Voľba spôsobu predaja (po sektoroch a miestach) je zatiaľ vypnutá**, ako si
  písal. Kód pre sedadlá ostáva v projekte, len sa naň z formulára nedá dostať.

**Vzhľad**

- **Karta ukazuje celý plagát**, nie výrez zo stredu. Čo sa nezmestí, leží na
  rozmazanej kópii tej istej fotky namiesto sivých pruhov.
- **Karty sa už neroztiahnu** cez celú šírku monitora — a to platí pre feed aj
  pre swipovanie.
- **Komentáre a Spoločné plány** sú zarovnané na stred, nadpisy tiež.
- **Prechod medzi stránkami** modro prebliskne a skeletony pulzujú tou istou
  modrou.

**Feed**

- Novo vytvorený event sa **objaví vo feede hneď**, nie až keď vyprší cache.
- **Organizátor môže písať na feed pod menom svojej organizácie.** Autorom
  zostáva človek — za každý príspevok niekto ručí — ale zobrazí sa logo a názov
  organizácie. Podpísať príspevok cudzou organizáciou databáza nedovolí.

**Mazanie a prázdne stránky**

- **„Zmazať natrvalo" naozaj maže.** Pod RLS nie je odmietnuté zmazanie chyba,
  je to zmazanie nula riadkov — appka si teraz prečíta, čo skutočne odišlo, a
  event vyhodí zo všetkých cache, kým odíde z obrazovky.
- **Pád obrazovky končí na chybovej stránke s tlačidlom *Skúsiť znova*.**
  Doteraz nebola žiadna — jediná chyba pri vykresľovaní nechala bielu stránku a
  jediná cesta von bol refresh. Presne to, čo si opisoval.

**Cookies a pätička**

- **Lišta o cookies naozaj funguje.** A tu je horšia časť: doteraz nefungovala
  vôbec. Súbor s natívnou (prázdnou) verziou meracieho modulu prekrýval webovú
  verziu — Metro berie prvú príponu, na ktorú narazí, a `ts` je pred `tsx` —
  takže na webe sa načítala prázdna verzia. **Nenačítal sa žiadny pixel a lišta
  sa nikdy neukázala**, práve na jedinej platforme, kde cookies vôbec sú.
  Premenovaním súboru je to vyriešené a `scripts/smoke-cookies.mjs` to odteraz
  overuje v prehliadači, aby to znova nestíchlo.
- **Zásady cookies** sú štvrtý právny dokument a idú v migrácii ako ostatné.
  Popisujú, čo BLUP naozaj ukladá — prihlásenie, košík, odpoveď na lištu — a čo
  sa načíta až po súhlase.
- **Pätička na každej stránke**: právne dokumenty, *Aktualizovať nastavenia
  cookies* (lišta sa otvorí znova a odpoveď sa dá prepísať) a údaje
  prevádzkovateľa.
- **Údaje prevádzkovateľa** vyplníš v *Admin → Poplatky a sadzby →
  Prevádzkovateľ*: obchodné meno, sídlo, IČO, IČ DPH, kontakt. **Nič sa
  nedopĺňa za teba** — čo nevyplníš, sa nezobrazí. Bez obchodného mena, sídla a
  IČO nie je stránka v EÚ v poriadku, tak si na to vyhraď dve minúty.

**Drobnosti**

- Enter potvrdzuje aj zľavový kód, sumu výplaty, názov partie a názov
  organizátora.
- Tlačidlá pod nadpismi v organizátorskej sekcii sú užšie a na strede.
- „Vytvor BLUP" sa volá **„Vytvor event"**.

**✓ Rýchla kontrola po nasadení**

```sql
-- zobrazenia sa počítajú raz za pol hodiny na návštevníka
select public.cart_limits();          -- max_tickets_per_order musí byť 10
select public.vat_split(1200, 2300);  -- 976 netto, 224 DPH

-- štyri právne dokumenty vrátane cookies
select kind from public.legal_documents where published_at is not null;
```

A v prehliadači: dole na stránke klikni na **Aktualizovať nastavenia cookies** —
musí sa objaviť lišta s dvoma rovnocennými tlačidlami.

---

## 1 · Databáza (3 minúty)

```bash
npx supabase db push
```

Aplikuje sa **17 nových migrácií** (počítané od verzie, v ktorej si hlásil tie
chyby) — 10 z predošlého balíka a 7 z tohto. Existujúce tabuľky sa nemažú ani neprepisujú; pridávajú sa stĺpce a
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

> **A pozri sa do `blup-config.js`.** Leží vedľa `index.html` a načíta sa skôr
> než appka. Ak si buildoval s vyplneným `mobile/.env`, netreba v ňom nič meniť
> — prázdne hodnoty sa ignorujú. Ak buildoval niekto iný alebo si si nie istý,
> vyplň v ňom `supabaseUrl` a `supabaseAnonKey` (Supabase → *Project Settings →
> API*) a `webUrl` na `https://blup.sk`. Je to jediný súbor, ktorý sa dá na
> hostingu prepísať bez buildovania.
>
> **Service_role key tam nepatrí.** Ani Stripe secret key. Tento súbor si
> stiahne každý návštevník — presne ako celý zvyšok JavaScriptu.

**✓ Kontrola:** otvor `https://blup.sk` a pozri sa na názov v záložke
prehliadača. Musí byť **„Blup — eventy okolo teba"**, nie `blup.sk`. Ak vidíš
`blup.sk`, na server sa dostal starý build.

Ešte istejšia kontrola, pred nahratím:

```bash
node scripts/check-origin.mjs --dist
```

Odmietne build, ktorý ukazuje na `127.0.0.1`, aj taký, kde `blup-config.js` leží
v priečinku a stránka ho vôbec nenačíta.

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

Postaví dočasnú databázu, aplikuje **všetkých 47 migrácií od nuly** a prejde
**198 tvrdení**. Tvojej databázy sa to nedotkne. Ak toto prejde a `db push`
potom zlyhá, chyba je v tvojich dátach, nie v schéme — a to je pri hľadaní
veľmi cenné vedieť.
