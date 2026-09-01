# CREW. — Architecture & Implementation Plan

> Systém na nábor, plánovanie, dochádzku, komunikáciu a payroll brigádnikov,
> dobrovoľníkov a stánkarov na festivaloch a eventoch.

---

## 1. Východiskový stav repozitára

Repozitár `matejmedo123/blup` obsahoval na vetve `claude/enzo-burger-website-lc5i0e`
nesúvisiaci projekt (web reštaurácie ENZO). Zdieľaná je iba **technologická základňa**:

| | |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Jazyk | TypeScript (strict) |
| Štýly | Tailwind CSS v4 (`@theme` tokeny v `globals.css`) |
| Lint | `eslint-config-next` (core-web-vitals + typescript) |

**Rozhodnutie:** stack ostáva, ENZO stránky/komponenty sú z tejto vetvy odstránené
(ostávajú zachované v histórii na vlastnej vetve). CREW. je samostatný produkt
a obsadzuje `/`. Nič použiteľné z ENZO domény sa neprenáša — dizajnový jazyk CREW.
je iný (event-tech, nie gastro).

---

## 2. Stack — doplnené technológie

| Vrstva | Voľba | Prečo |
|---|---|---|
| ORM | **Drizzle ORM** (`pg-core`) | typovo bezpečné SQL, žiadny runtime codegen, funguje v Next server komponentoch |
| DB (produkcia) | **PostgreSQL** cez `pg` (node-postgres) | `DATABASE_URL=postgres://…` |
| DB (dev/test) | **PGlite** (`@electric-sql/pglite`) | reálny Postgres vo WASM, v procese, bez externej služby — rovnaká SQL sémantika ako v produkcii |
| Migrácie | `drizzle-kit generate` → SQL v `drizzle/`, aplikované vlastným migrátorom pre oba drivery | jeden zdroj pravdy |
| Validácia | **Zod v4** | zdieľané schémy client + server |
| Formuláre | **React Hook Form** + `@hookform/resolvers` | viac-krokové formuláre (registrácia brigádnika) |
| Auth | **vlastná session auth** (scrypt + opaque session tokeny + httpOnly cookie) | pozri §5 |
| QR | `qrcode` (iba server-side, generuje SVG) | nulová záťaž client bundlu |
| Realtime | **SSE** (`/api/realtime`) nad in-process event busom | abstrakcia `RealtimeBus` — vymeniteľná za Redis / Postgres LISTEN-NOTIFY |
| E-mail | vlastná abstrakcia `EmailProvider` + `ConsoleProvider` / `SmtpProvider` / `ResendProvider` | provider sa mení jednou env premennou |
| Testy | **Vitest** proti PGlite | integračné testy nad reálnou DB |

### Prečo nie Prisma / Auth.js

* **Prisma** vyžaduje literálny `provider` v schéme — nedá sa jednou schémou obslúžiť
  Postgres aj embedded dev DB. Drizzle + PGlite dáva *rovnaký* Postgres dialekt v oboch režimoch,
  takže testy overujú presne tú SQL, ktorá pobeží v produkcii.
* **Auth.js v5** je v čase písania na Next 16 / React 19 nestabilné a jeho adaptéry
  by aj tak potrebovali vlastnú RBAC vrstvu. Vlastná session auth je ~200 riadkov,
  plne auditovateľná a bez závislosti na cudzom release cykle. Použité primitívy sú
  štandardné (`crypto.scrypt`, `crypto.randomBytes`, `timingSafeEqual`).

### Známa výhrada

`drizzle-kit` (dev-only nástroj) ťahá starší `esbuild` s moderate advisory
(GHSA-67mh-4wv8-2f99 — týka sa esbuild dev servera). Nie je súčasťou runtime ani
produkčného buildu; downgrade na `drizzle-kit@0.18` by rozbil generovanie migrácií.

---

## 3. Adresárová štruktúra

```
src/
├── app/
│   ├── (public)/                 landing, brigáda, dobrovoľník, stánok, auth
│   ├── portal/                   staff portál (mobile-first)
│   ├── admin/                    admin command center (desktop-first)
│   └── api/                      check-in, SSE, exporty, QR, cron
├── components/
│   ├── ui/                       design system (Button, Card, Field, Table, …)
│   ├── layout/                   AdminShell, PortalShell, PublicHeader
│   ├── forms/                    viac-krokové formuláre
│   ├── admin/                    admin-špecifické komponenty
│   └── portal/                   staff-špecifické komponenty
├── db/
│   ├── schema.ts                 Drizzle schéma (všetky entity)
│   ├── client.ts                 driver switch (pg | PGlite) + migrátor
│   ├── enums.ts                  explicitné enumy (§40 zadania)
│   └── seed.ts
├── lib/
│   ├── auth/                     hash, session, guards
│   ├── permissions.ts            RBAC + permission matrix
│   ├── domain/                   biznis logika (shifts, attendance, payroll, score…)
│   ├── email/                    provider abstrakcia + šablóny
│   ├── realtime.ts               event bus + SSE
│   ├── audit.ts
│   ├── validation/               Zod schémy
│   └── format.ts                 čas, mena, dátumy (Intl, event timezone)
└── tests/                        Vitest
```

---

## 4. Databázový model

Všetky tabuľky majú `id uuid pk default gen_random_uuid()`, `created_at`, `updated_at`.
Mäkké mazanie (`deleted_at`) tam, kde záznam nesie históriu (users, shifts, messages,
positions, konverzácie). Peniaze sú `numeric(10,2)`, hodiny `numeric(6,2)`.
Časy sú `timestamptz` (UTC), zobrazujú sa v `event.timezone`.

### Identita a prístup
| Tabuľka | Kľúčové stĺpce |
|---|---|
| `users` | email (unique, citext-like lower), password_hash, first_name, last_name, phone, city, birth_year, avatar_url, global_role (`admin`\|`staff`\|`applicant_volunteer`\|`applicant_vendor`), status (`active`\|`suspended`\|`pending`), email_verified_at, last_login_at, deleted_at |
| `sessions` | user_id → users, token_hash (unique), expires_at, ip, user_agent |
| `auth_tokens` | user_id, kind (`email_verify`\|`password_reset`), token_hash, expires_at, used_at |
| `events` | name, slug (unique), description, location, lat, lng, start_date, end_date, timezone, status (`draft`\|`active`\|`archived`), settings jsonb |
| `event_members` | user_id, event_id, role (`admin`\|`coordinator`\|`staff`), permissions jsonb (§11), unique(user_id,event_id) |

`event_members.permissions` drží granulárne práva:
`can_check_in_others`, `can_check_out_others`, `can_edit_attendance`,
`can_manage_shifts`, `can_message_staff`, `can_view_payroll`, `can_rate_staff`.

### Prihlášky
| Tabuľka | Poznámka |
|---|---|
| `applications` | user_id, event_id, status (§40), motivation, source, score_snapshot, reviewed_by, reviewed_at, internal_note, unique(user_id,event_id) |
| `experiences` | user_id, position_label, company, work_type, date_from, date_to, description |
| `availabilities` | user_id, event_id, day (date), time_from, time_to, max_hours, note |
| `application_positions` | application_id, position_key (preferované pozície) |
| `application_answers` | application_id, question_key, answer_bool/answer_text (vodičák, jazyky, nočná práca, …) |
| `consents` | user_id, kind, granted_at, ip, text_version (GDPR audit) |
| `volunteer_applications` | samostatná entita, vlastný status, preferences[], availability jsonb |
| `vendor_applications` | firma, IČO, sortiment[], typ stánku, rozmery, elektrina/príkon, voda, odpad, sociálne siete, prílohy jsonb |

### Plánovanie
| Tabuľka | Poznámka |
|---|---|
| `positions` | event_id, name, slug, description, hourly_rate, capacity, color, icon, required_skills[], active |
| `shifts` | event_id, position_id, date, starts_at, ends_at, location, lat/lng, capacity, hourly_rate, status (§40), check_in_method (`manual`\|`qr`\|`geofence`\|`qr_geofence`), geofence_radius_m, qr_secret, coordinator_id, instructions, dress_code |
| `shift_assignments` | shift_id, user_id, status (§40), assigned_by, confirmed_at, declined_at, decline_reason, needs_replacement, unique(shift_id,user_id) |
| `attendance` | assignment_id (unique), shift_id, user_id, event_id, status (§40), check_in_at, check_out_at, check_in_method, check_in_lat/lng, check_out_lat/lng, device jsonb, worked_minutes, break_minutes, approved (bool), approved_by |
| `attendance_corrections` | attendance_id, actor_id, field, before, after, reason |
| `idempotency_keys` | key (unique), user_id, scope, response jsonb, expires_at — ochrana pred dvojitým check-inom pri retry (§73) |

### Komunikácia
`conversations` (event_id, type `direct`\|`shift`\|`group`\|`broadcast`\|`system`, title, shift_id, created_by),
`conversation_members` (conversation_id, user_id, role, last_read_at, muted),
`messages` (conversation_id, sender_id nullable = systémová, body, kind, meta jsonb, edited_at, deleted_at),
`notifications` (user_id, event_id, type (§19), title, body, action_url, entity refs, read_at).

### Výkon a payroll
`ratings` (staff_id, event_id, shift_id, rater_id, reliability, punctuality, work_ethic, communication, quality, note, overall),
`crew_scores` (user_id, event_id unique, score 0–100),
`score_transactions` (user_id, event_id, rule_key, delta, reason, ref),
`score_rules` (event_id, key, label, delta, active) — konfigurovateľné (§23),
`incidents` (event_id, staff_id, shift_id, severity, category, description, created_by, resolved_at, resolution),
`payroll_records` (event_id, user_id, period_from/to, hours, hourly_rate, gross, bonus, adjustments, total, status, approved_by),
`audit_logs` (event_id, actor_id, action, entity, entity_id, before jsonb, after jsonb, ip, created_at).

Indexy: každý FK, plus `(event_id, status)` na applications/shifts/attendance,
`(user_id, read_at)` na notifications, `(conversation_id, created_at)` na messages,
`(starts_at)` na shifts, `lower(email)` unique na users.

---

## 5. Autentifikácia a bezpečnosť

* **Heslá:** `crypto.scrypt` (N=16384, r=8, p=1, 64B), náhodná 16B soľ, formát
  `scrypt$N$r$p$salt$hash`, porovnanie cez `timingSafeEqual`.
* **Session:** 32B náhodný token → cookie `crew_session` (httpOnly, secure v produkcii,
  sameSite=lax, 30 dní, rolling). V DB je uložený iba SHA-256 hash tokenu.
* **CSRF:** sameSite=lax + server-side kontrola `Origin`/`Host` na všetkých mutáciách
  (Next server actions posielajú Origin; middleware to vynucuje).
* **Rate limiting:** in-memory sliding window (`lib/rate-limit.ts`) na login, registráciu,
  reset hesla a check-in; abstrahované tak, aby sa dal podložiť Redisom.
* **Autorizácia:** *každá* server action / route handler volá guard
  (`requireAdmin`, `requireStaff`, `requirePermission`, `requireConversationMember`).
  Frontend checky sú iba kozmetika.
* **Verifikácia e-mailu + reset hesla** cez `auth_tokens` (hash, TTL, jednorazové).
* **GDPR:** logované súhlasy, export vlastných dát (`/portal/profile` → JSON),
  žiadosť o výmaz (anonymizácia), žiadne osobné údaje v URL (všade UUID).

### Permission matrix

| Akcia | admin | coordinator (event) | staff | applicant_* |
|---|---|---|---|---|
| Admin dashboard | ✅ | ✅ (obmedzený) | ❌ | ❌ |
| Schvaľovanie prihlášok | ✅ | ❌ | ❌ | ❌ |
| CRUD pozícií | ✅ | ❌ | ❌ | ❌ |
| CRUD smien | ✅ | `can_manage_shifts` | ❌ | ❌ |
| Prideľovanie | ✅ | `can_manage_shifts` | ❌ | ❌ |
| Check-in/out za iných | ✅ | `can_check_in_others` / `can_check_out_others` | ❌ | ❌ |
| Editácia dochádzky | ✅ | `can_edit_attendance` | ❌ | ❌ |
| Payroll + export | ✅ | `can_view_payroll` | ❌ | ❌ |
| Hodnotenie | ✅ | `can_rate_staff` | ❌ | ❌ |
| Broadcast správy | ✅ | `can_message_staff` (len svoje smeny) | ❌ | ❌ |
| Vlastný profil / smeny / zárobok | ✅ | ✅ | ✅ | ❌ |
| Stav vlastnej prihlášky | — | — | — | ✅ |

Koordinátor vidí **iba ľudí na smenách, ktoré koordinuje**. Nikdy nevidí payroll,
pokiaľ nemá `can_view_payroll`.

---

## 6. Routing

### Public
```
/                              landing (3 CTA)
/brigada                       info + CTA
/brigada/registracia           6-krokový formulár
/brigada/prihlasenie           login
/brigada/registracia/hotovo    potvrdenie odoslania
/dobrovolnik                   formulár dobrovoľníka
/stanok                        formulár stánkara
/prihlaska/[id]                verejný stav prihlášky (token v cookie)
/auth/overenie                 e-mail verification
/auth/zabudnute-heslo, /auth/reset-hesla
/gdpr, /podmienky
```

### Portal (`staff`, mobile-first, bottom nav)
```
/portal                        dashboard (najbližšia smena, live check-in, hodiny, zárobok, skóre)
/portal/shifts                 upcoming / active / completed
/portal/shifts/[id]            detail + sticky CHECK-IN
/portal/checkin                QR landing (?t=token) — jednokrokový check-in
/portal/messages               inbox
/portal/messages/[id]          chat
/portal/notifications          notification center + potvrdenie smeny
/portal/earnings               zárobok podľa smien
/portal/profile                profil, skúsenosti, preferencie, dostupnosť, skóre, export dát
```

### Admin (desktop-first, sidebar; na mobile hamburger + karty)
```
/admin                         dashboard (KPI, Live Crew, Alerts, Today/Upcoming)
/admin/applicants  /admin/applicants/[id]
/admin/staff       /admin/staff/[id]        (Profile|Experience|Shifts|Attendance|Earnings|Rating|Score|Messages|Notes|Activity)
/admin/volunteers  /admin/vendors
/admin/positions
/admin/shifts      /admin/shifts/[id]       /admin/calendar
/admin/assignments                          (manuálne + auto návrh)
/admin/attendance  /admin/attendance/corrections
/admin/messages    /admin/messages/[id]     /admin/notifications
/admin/ratings     /admin/score             /admin/incidents
/admin/payroll     /admin/exports
/admin/settings    /admin/settings/users    /admin/settings/permissions   /admin/settings/audit
```

### API
```
POST /api/attendance/check-in       idempotentný (Idempotency-Key)
POST /api/attendance/check-out
GET  /api/realtime                  SSE (messages, attendance, notifications)
GET  /api/qr/shift/[id]             SVG QR pre smenu (admin)
GET  /api/exports/payroll.csv       CSV export
POST /api/cron/reminders            24h pripomienky + check-in/out reminders
```

---

## 7. Kľúčové biznis pravidlá (§51)

1. Schválenie prihlášky vytvorí `staff` účet, **nepridelí smenu**.
2. Pridelenie smeny → `pending_confirmation`; potvrdiť musí staff.
3. Dochádzku nemožno zmeniť bez `attendance_corrections` + `audit_logs` (v jednej transakcii).
4. Staff dotazy sú vždy scoped na `user_id` z session.
5. Koordinátor má len explicitne udelené `permissions`.
6. Payroll číta iba `attendance.approved = true`.
7. Auto-prideľovanie odmieta prekryv smien (interval overlap check v SQL) a prekročenie `max_hours`.
8. Messaging kontroluje `conversation_members` + `event_id`.

## 8. Výpočet zárobku (§14)

```
worked_minutes = check_out - check_in - break_minutes
hours          = round(worked_minutes / 60, event.settings.rounding)   // "exact" | "5min" | "15min"
gross          = hours × rate                  // rate = shift.hourly_rate ?? position.hourly_rate
total          = gross + bonus + adjustments
```
Staff vidí **odhad** (z aktuálnej dochádzky, aj počas smeny), admin vidí
**schválenú** sumu (`payroll_records` z approved attendance). Overtime nad
`event.settings.overtime_after_hours` sa násobí `overtime_multiplier`.

## 9. Crew Score (§23)

Default pravidlá (editovateľné v `/admin/score`):
`on_time +10`, `shift_confirmed +5`, `positive_rating +5`, `late -10`,
`no_show -20`, `late_cancel -5`, `incident_high -15`.
Score štartuje na 70, clampuje sa na 0–100, každá zmena je `score_transactions`.
Auto-prideľovanie používa skóre ako **jeden z váhových faktorov**, nie ako jediný filter.

## 10. Responzivita (§58–78)

Design tokens + Tailwind v4 breakpointy (`sm 640 / md 768 / lg 1024 / xl 1280 / 2xl 1536`).
* **Admin**: `lg:` sidebar + grid; `<lg` hamburger drawer, tabuľky → karty, filtre → bottom sheet.
* **Portal**: mobile-first, bottom navigation (5 položiek), sticky CTA, touch target ≥ 44px,
  na `md+` sa rozšíri na 2-stĺpcový layout s bočnou navigáciou.
* Komponent `<DataTable>` renderuje `<table>` od `md`, pod tým `<ul>` kariet — jeden zdroj dát.

## 11. Implementačné fázy

0. Schéma, migrácie, DB klient, PLAN.md
1. Auth, RBAC, session, design system, layouty
2. Landing + prihlášky (brigáda / dobrovoľník / stánkar)
3. Admin: applicants, staff, volunteers, vendors
4. Scheduling: positions, shifts, assignments, calendar
5. Attendance: check-in/out, QR, geofence, live, korekcie
6. Staff portal
7. Messaging + realtime
8. Payroll, ratings, crew score, incidents, audit
9. Notifikácie + e-mail + pripomienky
10. Seed, testy, polish, lint/typecheck/build
