@AGENTS.md

# ENZO — objednávkový systém pre jednu prevádzku

Web + objednávkový systém pre ENZO Smash Burgers & Pizza, Koniarovce.
Jedna prevádzka, monolit, nasadené na zdieľanom hostingu Websupport.

## Prečo tento stack (a nie Node + Postgres + Prisma)

Cieľový hosting je **Websupport shared hosting**, ktorý zákazník už má.
Ponúka PHP 8 a MySQL, **nie** dlho bežiace Node procesy, Postgres, Redis
ani WebSockety. Preto:

| Vrstva | Použité | Namiesto |
|--------|---------|----------|
| Frontend | Next.js 16 + React 19 + TypeScript + Tailwind v4, **statický export** | SSR Next.js |
| Backend | PHP 8.1+ s PDO, bez composeru | Node.js API vrstva |
| Databáza | MySQL/MariaDB, alternatívne SQLite | PostgreSQL + Prisma |
| Realtime | HTTP polling s `version` tokenom (odpoveď 304 keď sa nič nezmenilo) | WebSocket / Socket.IO |
| Fronty | žiadne — e-maily sa posielajú synchrónne, zlyhanie sa loguje | Redis + BullMQ |
| Validácia | `Validate` (PHP) + `zod`-štýl kontrola na klientovi | Zod na oboch stranách |

**Toto nie je dočasné provizórium.** Je to vedomé rozhodnutie pre cieľové
prostredie. Keby sa systém niekedy sťahoval na VPS, prepíše sa transportná
vrstva (realtime, fronty), nie doménová logika — tá je v `backend/api/lib/`
oddelená od HTTP.

## Štruktúra

```
src/                      frontend (Next.js App Router, statický export do out/)
  app/                    stránky: /, /pokladna, /objednavka, právne texty
  components/             UI po doménach: menu/, cart/, checkout/, order/, home/, ui/
  context/                MenuContext (menu+nastavenia zo servera), CartContext
  lib/                    api.ts, cart.ts, order.ts, types.ts, config.ts, validation.ts

backend/
  api/                    verejné API (menu, settings, orders, order) + platby
    lib/                  doménová logika — sem patria pravidlá, nie do endpointov
    sql/                  schéma pre MySQL aj SQLite + seed menu
  admin/                  rozhranie pre prevádzku (PHP stránky, session auth)
  storage/                logy, maily v dev režime, SQLite súbor — mimo gitu
  install.php             jednorazová inštalácia
  tests/                  PHP unit + integračné testy
e2e/                      Playwright scenáre
```

## Príkazy

```bash
npm run dev            # vývoj frontendu
npm run build          # produkčný statický export do out/
npx tsc --noEmit       # typecheck
npx eslint src --max-warnings=0
npm run test:php       # PHP unit + integračné testy
npm run test:e2e       # Playwright E2E (potrebuje bežiaci testovací server)
npm run test:all       # všetko naraz
bash scripts/pack.sh   # zabalí out/ + backend do enzo-web.zip
```

## Nemenné pravidlá

1. **Databáza je zdroj pravdy.** Realtime ani localStorage nikdy nie.
2. **Backend nikdy nedôveruje cene z frontendu.** `OrderService::priceCart()`
   načíta ceny z DB a všetko prepočíta. Klient posiela len `productId`,
   `quantity`, `note` a zoznam id doplnkov.
3. **Doplnky sa akceptujú len tie, ktoré sú k produktu naozaj priradené.**
4. **Ceny sú celé centy (`int`).** Nikdy float. Prevod cez `Money`.
5. **Objednávka ukladá cenu v čase objednania** (`base_cents`, `unit_cents`,
   `extras_json`). Historickú objednávku nikdy neprepočítavaj podľa
   aktuálneho cenníka.
6. **Vytvorenie objednávky aj zmena stavu bežia v transakcii.**
7. **Neplatný prechod stavu server odmietne** — pozri state machine nižšie.
8. **Históriu stavov nikdy nemaž.**
9. **Autorizácia je vždy na serveri.** Skrytie tlačidla v UI nie je ochrana.
10. **Opakovaná požiadavka nesmie vytvoriť druhú objednávku** (Idempotency-Key),
    ani zaúčtovať platbu dvakrát (webhook idempotencia).
11. **Produkt, ktorý už bol v objednávke, sa nemaže** — iba deaktivuje.
12. **Žiadne tajomstvá v gite.** `backend/api/config.php` je v `.gitignore`
    a nikdy sa nebalí do ZIP-u. Do logov nikdy nepíš heslá ani kľúče.

## State machine objednávky

```
                    ┌─→ rejected (koncový)
received ─→ accepted ─→ preparing ─→ ready ─┬─→ delivering ─→ completed
    │           │           │          │    └─→ picked_up  ─→ completed
    └───────────┴───────────┴──────────┴─→ cancelled (koncový)
```

- `delivering` je len pre `order_type = delivery`, `picked_up` len pre `pickup`.
- `completed`, `rejected`, `cancelled` sú koncové — z nich sa nedá nikam ísť.
- Prechody definuje `OrderStatus::TRANSITIONS`; `OrderService::transition()`
  neplatný prechod odmietne chybou `INVALID_STATUS_TRANSITION`.
- Doklad (`doc_number`) sa prideľuje až pri `completed`, aby v číselnom rade
  nevznikali diery.

## Konvencie kódu

- **Komentáre a texty pre používateľa po slovensky**, aj v PHP aj v TS.
  Značkové slogany ostávajú v angličtine.
- Komentár vysvetľuje *prečo*, nie *čo* — kód hovorí sám za seba.
- PHP: `declare(strict_types=1)`, triedy v `lib/` sa načítajú autoloaderom
  z `_bootstrap.php`, jedna trieda = jeden súbor rovnakého mena.
- TypeScript: strict, žiadne `any`, doménové typy v `src/lib/types.ts`.
- Diakritika v display fonte potrebuje `line-height` aspoň `1.02`, inak
  sa mäkčene a dĺžne orežú.
- Dotykové ciele v zákazníckom UI aj v admine majú aspoň 44 px na výšku.

## Chybové kódy

Server vracia `{"ok":false,"error":"…po slovensky…","code":"KOD","fields":{}}`.
Kódy sú v `ErrorCode`; frontend podľa nich vie reagovať (napr. pri
`RESTAURANT_CLOSED` ukáže odkaz prevádzky, pri `PRODUCT_UNAVAILABLE`
pošle zákazníka upraviť košík).

## Testy

Nikdy nemaž ani nepreskakuj test len preto, aby build prešiel.
Keď test padne, oprav príčinu.
