# BLUP

> **Nasadzuješ to na web?** Celý postup krok za krokom je v
> **[SPUSTENIE.md](SPUSTENIE.md)**.

**What's your next Blup?**

A geolocated event discovery platform: see what is happening around you right now,
create your own event, meet people with the same interests, and buy a ticket —
all backed by a real database, real auth and real money flows.

This is a working MVP, not a mockup. Every button either does something real or
tells you exactly which credential it is missing.

---

## What is in the box

| Layer | Technology | Where |
|---|---|---|
| Mobile app | Expo SDK 57 · React Native 0.86 · React 19 · TypeScript · Expo Router | `mobile/` |
| Database | PostgreSQL 16 (Supabase) · 14 versioned migrations · RLS on every table | `supabase/migrations/` |
| Backend API | Supabase Edge Functions (Deno) | `supabase/functions/` |
| Auth | Supabase Auth — email/password, reset, Apple, Google | `mobile/src/auth/` |
| Storage | Supabase Storage — avatars, event covers, private KYC documents | `mobile/src/storage/` |
| Payments | Stripe PaymentIntents + Connect payouts, webhook-confirmed | `supabase/functions/stripe-webhook/` |
| Premium | Apple StoreKit, receipt verified server-side | `supabase/functions/iap-apple-verify/` |
| Recommendations | Deterministic SQL ranker + optional LLM explanations | `supabase/migrations/…_discovery_and_ranking.sql` |
| Tests | 45 SQL assertions against a real PostgreSQL cluster | `supabase/tests/` |

Deeper docs: [ARCHITECTURE](ARCHITECTURE.md) · [DATABASE](DATABASE.md) ·
[API](API.md) · [PAYMENTS](PAYMENTS.md) · [AI](AI.md) ·
[DEPLOYMENT](DEPLOYMENT.md) · [ENVIRONMENT](ENVIRONMENT.md)

---

## Setup, start to finish

### 1. Clone and install

```bash
git clone https://github.com/matejmedo123/blup.git
cd blup
npm install                 # root: seed-script tooling
npm install --prefix mobile # the app
```

### 2. Create a Supabase project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**.
2. Pick a region close to your users and save the database password.
3. Open **Project Settings → API** and copy the **Project URL** and the **anon** key.

### 3. Configure the environment

```bash
cp mobile/.env.example mobile/.env     # public keys for the app
cp supabase/.env.example supabase/.env # server secrets (never committed)
cp .env.example .env                   # for the seed script
```

Fill in at minimum `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`
in `mobile/.env`. Everything else can wait — the app runs without payments, AI
or premium and says so explicitly where they are missing.
See [ENVIRONMENT.md](ENVIRONMENT.md) for every variable.

### 4. Run the migrations

```bash
# The Supabase CLI blocks global npm installs — run it with npx,
# or install it natively (macOS: brew install supabase/tap/supabase).
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push           # applies supabase/migrations in order
```

Your database is now complete **and completely empty** — that is deliberate.
See [Zero state](#zero-state) below.

### 5. Seed demo data (optional)

```bash
# .env needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
npm run seed             # 20 people, ~32 events, 3 organizations, a social graph
npm run seed -- --city=vienna --events=40
npm run seed:clean       # removes everything the seed created
```

The seed is a **separate opt-in script**, never a migration, so production can
start genuinely empty.

### 6. Deploy the Edge Functions

```bash
npx supabase secrets set --env-file supabase/.env
./scripts/deploy-functions.sh
```

You only need this once you add Stripe, Apple or AI credentials — the app runs
without it.

### 7. Start the app

```bash
npm run mobile           # or: cd mobile && npx expo start
```

### 8. Try it right now, in a browser

```bash
npm run web
```

The whole app runs on web against the same Supabase project. The map becomes a
positional list and checkout is disabled (both are native-only modules) — every
other flow is the real one.

### 9. Get it on your phone

**Quickest path — Expo Go** (works for everything except Stripe’s native payment
sheet, in-app purchases and maps on Android):

```bash
cd mobile && npx expo start
# scan the QR code with the Expo Go app
```

**Real build — required for maps, payments and push:**

```bash
npm install -g eas-cli
eas login
eas init                              # writes your EAS project id
npm --prefix mobile run build:dev:android   # installable .apk
npm --prefix mobile run build:dev:ios       # needs an Apple Developer account
```

Full build and store-submission instructions: [DEPLOYMENT.md](DEPLOYMENT.md).

---

## Zero state

A fresh BLUP database contains no users and no events. On first launch you get:

> **Nothing happening here yet**
> Be the first — put your event on the map and people nearby will see it.
> **[ Create the first BLUP ]**

There are no hardcoded events pretending to be a live community anywhere in the
app. The only reference data a migration inserts is the interest catalogue,
because onboarding cannot work without it.

---

## Verifying it actually works

```bash
npm run db:verify              # spins up a throwaway PostgreSQL 16 cluster,
                               # applies all migrations, runs 45 assertions
npm run typecheck              # tsc --noEmit over the whole app
cd mobile && npx expo export --platform android   # proves the bundle builds
```

`db:verify` needs a local PostgreSQL 16 install (`apt install postgresql-16` or
`brew install postgresql@16`); it never touches your Supabase project.

The SQL suite asserts the things that actually matter:

- a fresh database starts empty
- a paid event cannot exist without a **verified** organization
- capacity limits, counters and per-order ticket limits hold
- tickets exist only after a payment is confirmed, and replaying a webhook does
  not mint duplicates
- the buyer's total always equals the organizer's net plus BLUP's revenue, and
  payouts cannot exceed the settled part of the ledger
- the fee schedule (4 % + 1 € per ticket) resolves from the platform settings,
  free tickets carry no archive fee, and an organizer cannot rewrite their own rate
- the accounting export closes on the same balance the app shows, and refuses a
  caller who is not on that organization
- forged QR codes, foreign scanners and double check-ins are all rejected
- the ranker orders by interest, distance, time and social proof, and explains itself
- RLS blocks privilege escalation, cross-user edits, self-granted premium and
  client-side ticket minting

---

## Platforms

One codebase, three targets. The web build is a first-class target, not a
preview — it is the one BLUP launches on, because outside the App Store there
is no 15–30 % commission on Premium.

```bash
cd mobile
npm run web          # dev server in a browser
npm run build:web    # static export to mobile/dist
```

Everything native-only has a web sibling resolved by Metro (`*.web.tsx`):
hosted Stripe Checkout instead of the payment sheet, the browser's
`BarcodeDetector` instead of expo-camera, an `.ics` download instead of the OS
calendar. Nothing renders a button that does nothing. See **WEB.md**.

---

## Repository layout

```
blup/
├── mobile/                  Expo app
│   ├── app/                 Expo Router routes (45 screens)
│   └── src/
│       ├── api/             events, profiles, tickets, organizations, ai, admin…
│       ├── auth/            session provider + auth calls
│       ├── components/      EventCard, EventMap, SwipeDeck, UI kit
│       ├── hooks/           useLocation (real GPS)
│       ├── lib/             supabase client, env, formatting, error messages
│       ├── maps/            calendar + directions integration
│       ├── notifications/   Expo push registration
│       ├── storage/         image pick → compress → upload
│       ├── theme/           design tokens
│       └── types/           application models
├── supabase/
│   ├── migrations/          14 ordered SQL migrations
│   ├── functions/           9 Deno Edge Functions
│   ├── seed/                opt-in demo data
│   └── tests/               SQL assertions
├── scripts/                 verify-db.sh, deploy-functions.sh
└── docs                     ARCHITECTURE / DATABASE / API / PAYMENTS / AI / …
```

---

## What needs external accounts

The app runs and is useful with only Supabase configured. These add the rest:

| Feature | Needs |
|---|---|
| Maps on Android | Google Maps API key (`EXPO_PUBLIC_MAPS_API_KEY_ANDROID`) |
| Ticket checkout | Stripe account (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, publishable key) |
| Organizer payouts | Stripe Connect enabled on that account |
| Premium subscriptions | Apple Developer account + StoreKit products, or Google Play Billing |
| AI explanations | An LLM API key (`AI_API_KEY`) — ranking works without it |
| Push notifications | An EAS project (`eas init`) and a real device |

Anything missing surfaces as an explicit state in the UI (“Payments are not
configured on this deployment yet”), never as a button that silently fails.

---

## Licence

Not yet chosen — add one before publishing.


---

## What changed most recently

**Guest browsing.** Opening the site signs nobody in. A visitor sees the real
feed, opens events, searches and reads communities; the account is asked for at
the moment it is needed — going, saving, writing, buying — by one sheet that
says why. The feed also degrades honestly: with a location it is the geo query,
without one it is the plain upcoming list rather than an empty city.

**Košík (web).** Tickets in a basket are genuinely reserved for 15 minutes,
held against every other shopper and released on their own. Maximum 20 tickets
per order, enforced by the database in two places. A basket pays once: one
Stripe Checkout session becomes one order per ticket type under one `checkout`
row, and the webhook issues every ticket at once. A promo code discounts the
basket, is counted once, and is split across the lines to the cent.

**Sales curve.** `Organizátor → Štatistiky` now draws the daily line: tickets,
your revenue, BLUP's cut, per day, over 7 / 30 / 90 days, with the busiest day
called out and every day clickable. Drawn with plain views — no charting
dependency to render twenty rectangles.

**Editing.** An organizer can fix anything they got wrong: name, description,
category, date, duration, place, capacity, listing. An admin can find and edit
any event on the platform (`Admin → Všetky eventy`) and is asked why — the
reason goes to the audit log. Being able to fix any event and being able to do it
quietly are not the same power.

**Marketing.** `Admin → Marketing` takes a Meta pixel id, a Google Ads id and
conversion label, and a GA4 id. **Identifiers, not markup** — the loaders live
in the app's code, so the worst a bad value can do is fail to load a pixel.
Nothing loads before consent, and `purchase` is reported when the webhook has
issued the tickets, not when Stripe redirected the browser.

**The ticket PDF** was redrawn: wordmark, event, a panel holding the QR, a
perforation, and a stub carrying the holder, type, price with the archive fee
stated separately, order reference, issue date — and the seller's legal identity
(name, IČO, DIČ, address, contact), because the contract is with the organizer
and BLUP is only where it happened.

**A real security hole, found and closed.** Earlier migrations locked the money
functions down with `revoke execute … from authenticated`, which does nothing:
PostgreSQL grants EXECUTE to `PUBLIC`, and `authenticated` inherits it. Anyone
with an account and the anon key from the client bundle could call
`fulfill_order` (free tickets), `ticket_email_payload` (anyone's QR secret),
`upsert_premium_subscription` (free Premium), `refund_order`, `activate_boost`,
`link_stripe_customer` and `notify_user`. Migration 0024 revokes from `PUBLIC`
and asserts the result; `test_11` asserts it on every run.
