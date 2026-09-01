# CREW.

**Ľudia, ktorí držia event v pohybe.**

Platforma na nábor, plánovanie smien, dochádzku, komunikáciu a mzdy brigádnikov,
dobrovoľníkov a stánkarov na festivaloch a eventoch. Jeden responzívny web:
**desktop = command center pre organizátorov**, **mobil = pracovný nástroj pre crew**.

---

## Rýchly štart

```bash
npm install
npm run db:migrate     # vytvorí lokálnu databázu (PGlite, žiadna externá služba)
npm run db:seed        # demo event, crew, smeny, dochádzka, správy
npm run dev            # http://localhost:3000
```

Demo prístupy zo seedu (menia sa cez `SEED_*` premenné):

| Rola | E-mail | Heslo |
|---|---|---|
| Admin | `admin@crew.local` | `crew-admin-2026` |
| Koordinátor | `peter@crew.local` | `crew-staff-2026` |
| Crew | `martin@crew.local` | `crew-staff-2026` |

> **Pozor:** PGlite je jednoprocesová. Pred `db:seed` alebo `db:reset` zastav dev
> server — inak si obe strany prepíšu svoj pohľad na dáta.

## Príkazy

| | |
|---|---|
| `npm run dev` | vývojový server |
| `npm run build` / `npm start` | produkčný build a beh |
| `npm run lint` / `npm run typecheck` | ESLint a TypeScript |
| `npm test` | Vitest (112 testov nad reálnou databázou) |
| `npm run db:generate` | vygeneruje SQL migráciu zo zmien v schéme |
| `npm run db:migrate` | aplikuje migrácie |
| `npm run db:seed` | naplní demo dáta |
| `npm run db:reset` | zahodí lokálnu DB, migruje a naseeduje |
| `npm run cron:reminders` | pripomienky smien, no-show, upratovanie relácií |

---

## Stack

| Vrstva | Voľba |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack), React 19 |
| Jazyk | TypeScript (strict) |
| Štýly | Tailwind CSS v4, dizajnové tokeny v `globals.css` |
| Databáza | PostgreSQL — `pg` v produkcii, **PGlite** (Postgres vo WASM) v dev a testoch |
| ORM | Drizzle (`pg-core`), migrácie cez `drizzle-kit` |
| Validácia | Zod v4, zdieľaná medzi klientom a serverom |
| Formuláre | React Hook Form (viac-krokové verejné formuláre) |
| Auth | vlastná session vrstva (scrypt + opaque tokeny + httpOnly cookie) |
| Realtime | SSE nad in-process event busom (vymeniteľné za Redis / LISTEN-NOTIFY) |
| E-mail | vlastná abstrakcia `EmailProvider` (console / Resend / webhook) |
| Testy | Vitest proti PGlite |

Rovnaký Postgres dialekt v dev, testoch aj produkcii znamená, že testy overujú
presne tú SQL, ktorá pobeží naostro. Podrobné zdôvodnenie volieb je v [`PLAN.md`](./PLAN.md).

---

## Konfigurácia

Všetko má rozumný default; pre produkciu nastav aspoň `DATABASE_URL` a `SEED_ADMIN_PASSWORD`.

| Premenná | Default | Význam |
|---|---|---|
| `DATABASE_URL` | — | `postgres://…`. Bez nej sa použije lokálna PGlite. |
| `DATABASE_SSL` | `false` | `true` zapne SSL pre spravovaný Postgres. |
| `PGLITE_DATA_DIR` | `.pglite` | Adresár lokálnej databázy. |
| `APP_URL` | `http://localhost:3000` | Základ pre odkazy v e-mailoch a QR kódoch. |
| `EMAIL_PROVIDER` | `console` | `console` \| `resend` \| `webhook` |
| `EMAIL_FROM` | `CREW. <noreply@crew.local>` | Odosielateľ. |
| `RESEND_API_KEY` | — | Pri `EMAIL_PROVIDER=resend`. |
| `EMAIL_WEBHOOK_URL` / `EMAIL_WEBHOOK_TOKEN` | — | Pri `EMAIL_PROVIDER=webhook`. |
| `CRON_SECRET` | — | Bez neho je `/api/cron/reminders` vypnutý. |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` / `SEED_STAFF_PASSWORD` | demo | Prístupy zo seedu. |

Pripomienky spúšťaj hodinovo — buď `POST /api/cron/reminders` s hlavičkou
`Authorization: Bearer $CRON_SECRET`, alebo systémovým cronom cez `npm run cron:reminders`.

---

## Ako to funguje

### Tri vstupy z landingu

1. **Chcem brigádovať** → 6-krokový formulár → schválenie adminom → prístup do `/portal`
2. **Chcem byť dobrovoľník** → krátka prihláška → admin sekcia, bez prístupu do portálu
3. **Chcem mať stánok** → prihláška so sortimentom, rozmermi a technikou

### Role

| Rola | Vidí |
|---|---|
| `admin` | všetko vrátane miezd, nastavení a audit logu |
| `coordinator` | len to, na čo má výslovné oprávnenie (check-in, dochádzka, správy, hodnotenia, smeny, mzdy) |
| `staff` | výhradne vlastné smeny, dochádzku, zárobok, správy a skóre |
| `applicant_volunteer` / `applicant_vendor` | iba stav vlastnej prihlášky |

Oprávnenia koordinátora sú granulárne (`can_check_in_others`, `can_edit_attendance`,
`can_manage_shifts`, `can_message_staff`, `can_view_payroll`, `can_rate_staff`,
`can_check_out_others`) a nastavujú sa v detaile človeka.

### Produktové pravidlá

Tieto pravidlá sú vynútené na serveri, nie v UI:

1. Schválenie prihlášky vytvorí crew účet, **ale nepridelí smenu**.
2. Pridelenie smeny ≠ potvrdenie — potvrdiť ju musí pracovník.
3. Dochádzku nemožno zmeniť bez záznamu korekcie a audit logu (v jednej transakcii).
4. Staff dotazy sú vždy obmedzené na vlastné `user_id`.
5. Koordinátor má len práva, ktoré mu admin udelil.
6. Mzdy počítajú iba zo **schválenej** dochádzky; každá oprava schválenie zruší.
7. Prideľovanie (manuálne aj automatické) nikdy nevytvorí prekrývajúce sa smeny.
8. Prístup ku konverzácii rozhoduje členstvo — platí aj pre adminov.

### Dochádzka

Check-in podporuje **manuálny**, **QR** a **GPS geofence** režim, plus check-in
koordinátorom za pracovníka. QR kód kóduje URL, takže ho naskenuje bežná appka
fotoaparátu. Zápis je **idempotentný** — retry na slabom pripojení nikdy nevytvorí
druhý check-in (hlavička `Idempotency-Key` + DB unikáty a `CHECK` constrainty).

### Mzdy

```
odpracované minúty  = check-out − check-in − prestávka
hodiny              = zaokrúhlenie podľa nastavenia eventu (presne / 5 min / 15 min)
hrubé               = bežné hodiny × sadzba + nadčas × sadzba × násobok
spolu               = hrubé + bonus + korekcie
```

Sadzba smeny prebíja sadzbu pozície. Staff vidí **odhad** z aktuálnej dochádzky,
admin **schválenú** sumu. Export je CSV (`;`, UTF-8 s BOM, ochrana pred CSV injection).

---

## Štruktúra

```
src/
├── app/
│   ├── (public)/     landing, prihlášky, prihlásenie, právne stránky
│   ├── portal/       crew portál (mobile-first, bottom navigation)
│   ├── admin/        command center (desktop-first, sidebar + ⌘K)
│   ├── actions/      server actions (všetky mutácie)
│   └── api/          check-in, SSE, QR, CSV export, cron
├── components/
│   ├── ui/           dizajnový systém (Button, Card, Pill, DataTable, …)
│   ├── layout/       verejná hlavička a pätička
│   ├── forms/        viac-krokové formuláre
│   ├── admin/        admin komponenty
│   └── portal/       crew komponenty
├── db/               Drizzle schéma, enumy, klient (pg | PGlite)
├── lib/
│   ├── auth/         heslá, session, guardy
│   ├── domain/       biznis logika (smeny, dochádzka, mzdy, skóre, messaging…)
│   ├── email/        provider + šablóny
│   └── validation/   Zod schémy
└── tests/            Vitest
```

---

## Dizajn

Vizuálny jazyk vychádza z dodaného prototypu: uhľová `#111111`, podklad `#F7F7F5`,
akcent `#C7F36B`, Inter 400–800, **žiadne tiene** — elevácia vzniká 1px linkami
a kontrastom pozadia. Stav je vždy farba **a** text, nikdy len farba.

* **Desktop (admin):** sidebar + grid, klasické tabuľky, týždenný kalendár, ⌘K vyhľadávanie.
* **Mobil (crew):** bottom navigation, veľké CTA, tabuľky sa menia na karty,
  kalendár na agendu, filtre na bottom sheet, dotykové ciele ≥ 44 px.

Overené na 320 / 375 / 390 / 414 / 768 / 1280 / 1440 / 1920 px — bez horizontálneho
presahu na žiadnom z nich.

## Prístupnosť a súkromie

Skip link, viditeľný focus ring, `prefers-reduced-motion`, sémantické `<button>`
a `<a>` s popismi. Heslá sú výhradne scrypt hashe, session tokeny sa v databáze
ukladajú len ako SHA-256. Súhlasy sa logujú, crew si vie stiahnuť všetky svoje
údaje z profilu a osobné údaje sa nikdy neobjavia v URL.

## Známe obmedzenia

* `drizzle-kit` (iba vývojový nástroj) ťahá starší `esbuild` s moderate advisory —
  netýka sa runtime ani produkčného buildu.
* Realtime beží nad in-process busom, takže pri viacerých inštanciách treba
  `RealtimeBus` podložiť Redisom alebo Postgres `LISTEN/NOTIFY` (rozhranie je pripravené).
* Rate limiting je in-memory z rovnakého dôvodu — rozhranie `RateLimiter` počíta
  s výmenou za Redis.
* Prílohy stánkarov sa zadávajú ako odkazy; nahrávanie súborov nie je súčasťou.
