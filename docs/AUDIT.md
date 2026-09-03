# Audit oproti špecifikácii (master prompt)

Porovnanie systému ENZO s požiadavkami zadania. Stav k začiatku prác na
rozšírení; priebežný stav vedie `progress.md`.

## Vedomé odchýlky od navrhovaného stacku

Zadanie navrhuje technológie s výhradou *„Ak repo ešte nemá technológie,
použi…“*. Repo ich má a cieľové prostredie je dané — **Websupport shared
hosting**, ktorý zákazník používa a do ktorého sme systém už nasadili.

| Zadanie | Použité | Dôvod |
|---------|---------|-------|
| PostgreSQL + Prisma | MySQL/MariaDB (aj SQLite) cez PDO | Websupport dáva MySQL; Postgres tam nie je |
| Node.js API vrstva | PHP 8 monolit | zdieľaný hosting nespúšťa dlho bežiace Node procesy |
| WebSocket / Socket.IO | HTTP polling s `version` tokenom | WebSocket na shared hostingu nemá kde bežať |
| Redis + BullMQ | bez fronty, e-mail synchrónne + log zlyhaní | Redis nie je k dispozícii |
| Docker Compose | lokálny beh cez `php -S` + SQLite | prevádzka nasadzuje cez FTP, nie cez Docker |
| Argon2 | bcrypt cost 12 | Argon2 nie je na hostingu zaručene skompilovaný; bcrypt je |

Doménová logika je oddelená v `backend/api/lib/`, takže prípadný presun na
VPS by menil transportnú vrstvu, nie pravidlá.

Ostatné požiadavky zadania platia bez výnimky a plnia sa.

## Stav podľa oblastí

### Hotové pred týmto kolom

- Menu, kategórie, produkty, doplnky; správa v admine
- Košík s množstvom, doplnkami, poznámkou; prepočet ceny
- Checkout: odber/donáška, údaje, platba, poznámka, súhrn
- Vytvorenie objednávky v **transakcii**, ceny počítané **výhradne na serveri**
- **Snapshot cien** v `order_items` (base/unit/extras v čase objednania)
- Ceny ako **celé centy**, nikdy float
- Číslo objednávky `ENZO-1042`, doklad `2026/000001`, obe unikátne
- Sledovanie objednávky zákazníkom cez číslo + prístupový kód z e-mailu
- Admin: živý prehľad, odklikávanie času prípravy, história, detail, tlač
- E-maily: prijatá, potvrdený čas, pripravené, zrušené + log odoslaní
- Platba hotovosťou aj kartou (Stripe Checkout + overenie podpisu webhooku)
- Účtovníctvo: tržby, rozdelenie platieb, DPH, CSV export
- Bezpečnosť: session auth, HttpOnly cookies, bcrypt, CSRF, rate limiting,
  server-side validácia, PDO prepared statements, `.htaccess` pred konfiguráciou
- Nasadenie: statický export + PHP backend v jednom ZIP-e, inštalátor, návod

### Chýbalo — rieši sa v tomto kole

| # | Požiadavka | Stav pred |
|---|-----------|-----------|
| 14 | Striktný state machine s odmietnutím neplatného prechodu | `setStatus()` bral hocijaký stav |
| 14 | Stavy `rejected`, `delivering`, `picked_up` | neexistovali |
| 15 | `OrderStatusHistory` s `fromStatus`/`toStatus`/`changedBy` | len generický `order_events` bez pôvodného stavu |
| 13 | Idempotency-Key pri vytvorení objednávky | žiadna — retry vytvoril druhú objednávku |
| 44 | Súbeh: dvaja pracovníci prijmú tú istú objednávku | bez ochrany |
| 20 | Otváracie hodiny po dňoch + validácia pri checkoute | len prepínač „prijímame/neprijímame“ |
| 19 | Doručovacie zóny s vlastným poplatkom a minimom | zóny len ako zoznam názvov v nastaveniach |
| 8 | Modifier groups s povinnosťou a min/max výberom | len plochý zoznam doplnkov |
| 10 | Kupóny a zľavy | neboli |
| 22 | `Payment` ako samostatná entita s vlastnými stavmi | stĺpce priamo v `orders` |
| 45 | Idempotentný platobný webhook | podpis overený, opakované doručenie nie |
| 6 | RBAC s rozdielom admin vs staff vynúteným na serveri | rola v DB, ale práva sa nekontrolovali |
| 32 | Audit log admin operácií | nebol |
| 29 | Jednotné chybové kódy | len text chyby |
| 27 | Analytika (dnešok, priemerná objednávka, top produkty) | len mesačné účtovníctvo |
| 30 | Časť indexov | chýbali na `order_items.order_id`, `products.is_available` a i. |
| 33 | Testy — unit, integračné, E2E | žiadne v repozitári |
| 40 | Admin použiteľný na telefóne | technicky sa vošiel, ale hlavička sa lámala a stĺpce boli pod sebou |
| 47 | `CLAUDE.md` s pravidlami projektu | súbor generovaný Next.js-om, bez pravidiel |
| 54 | `progress.md` | nebol |

### Zámerne mimo rozsah

- **Zákaznícke účty a história objednávok pod prihlásením** (`/account`).
  Prevádzka je jedna pobočka s objednávkami na telefón/e-mail; nútiť
  zákazníka registrovať sa znižuje počet objednávok. Sledovanie objednávky
  ide cez podpísaný odkaz z e-mailu, ktorý funguje aj na inom zariadení.
  Dátový model účty umožňuje doplniť bez migrácie objednávok.
- **Refundácie cez rozhranie.** Entita `payments` s ich stavmi existuje,
  ale vracať peniaze sa zatiaľ robí v Stripe administrácii. Doplniť sa dá,
  keď to prevádzka bude reálne potrebovať.
- **Viac prevádzok.** Zadanie výslovne hovorí optimalizovať pre jednu.

## Poznámka k eKase

Systém nie je registračná pokladnica podľa zákona o používaní elektronickej
registračnej pokladnice. Doklady slúžia ako interná evidencia a podklad pre
účtovníctvo. Je to napísané v admine, na doklade aj v návode.
