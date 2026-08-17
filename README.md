# BLUP

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
npm install -g supabase        # or: brew install supabase/tap/supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase db push               # applies supabase/migrations in order
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
supabase secrets set --env-file supabase/.env
./scripts/deploy-functions.sh
```

### 7. Start the app

```bash
npm run mobile           # or: cd mobile && npx expo start
```

### 8. Get it on your phone

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
- gross − BLUP fee = organizer balance, and payouts cannot exceed the settled part
- forged QR codes, foreign scanners and double check-ins are all rejected
- the ranker orders by interest, distance, time and social proof, and explains itself
- RLS blocks privilege escalation, cross-user edits, self-granted premium and
  client-side ticket minting

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
