# Architecture

## The one rule everything follows

**The database is the authority.** Not the app, not a service layer, not a
convention. Prices are computed in SQL, tickets are minted by a function only the
webhook can reach, premium is written only by the receipt verifier, and every
table is behind Row Level Security. A hostile client with a valid session and a
rewritten binary can still not give itself a free ticket, promote itself to
admin, or forge an attendee count.

Everything else in this document follows from that.

---

## Shape

```
┌──────────────────────────────────────────┐
│  Expo / React Native app                 │
│                                          │
│  app/            routes (Expo Router)    │
│  src/api/        one module per domain   │
│  src/auth/       session provider        │
│  src/components/ EventCard, Map, Deck    │
└───────────┬──────────────────┬───────────┘
            │ anon key         │ user JWT
            │ (RLS applies)    │
            ▼                  ▼
┌────────────────────┐  ┌─────────────────────────────┐
│ PostgREST + RPC    │  │ Edge Functions (Deno)       │
│ tables, views,     │  │ service role — bypasses RLS │
│ SECURITY DEFINER   │  │ checkout, webhooks, IAP,    │
│ functions          │  │ payouts, AI, push           │
└─────────┬──────────┘  └──────────┬──────────────────┘
          │                        │
          ▼                        ▼
┌──────────────────────────────────────────┐   ┌──────────┐
│ PostgreSQL 16                            │   │ Stripe   │
│ RLS · triggers · ranker · ledger         │   │ Apple    │
└──────────────────────────────────────────┘   │ LLM      │
                                               │ Expo push│
┌──────────────────────────────────────────┐   └──────────┘
│ Supabase Auth · Storage · Realtime       │
└──────────────────────────────────────────┘
```

Two paths into the data, on purpose:

- **Direct (PostgREST/RPC)** for everything a user may do as themselves — read
  events, RSVP, comment, upload an avatar. RLS is the guard. No proxy layer to
  keep in sync, and realtime works out of the box.
- **Edge Functions** for everything that must not be decided on a phone —
  amounts, payment confirmation, subscription state, payouts, LLM calls. These
  hold the service-role key and the third-party secrets.

The split is not stylistic. If an operation can be safely expressed as "this
user, acting as themselves, under RLS", it goes direct. If it needs a secret or
must outrank the user, it goes through a function.

---

## Technology choices and why

**Expo (SDK 57) + React Native + TypeScript.** One codebase for both stores,
native modules for the things BLUP actually needs (GPS, camera, maps, StoreKit,
push), and EAS builds without a Mac in the loop for Android. Expo Router gives
file-based routing and deep links (`blup://event/<id>`) for free, which the
notification and share flows depend on.

**Supabase over a hand-written backend.** Postgres, auth, storage, realtime and
edge compute in one project. Critically, it lets the security model live *in the
database* as RLS rather than in middleware — which is what makes the direct-access
path above safe. The cost is that Postgres is doing real work; that is a
deliberate trade, and `scripts/verify-db.sh` is how we keep it honest.

**Deterministic SQL ranker instead of an LLM in the hot path.** Ranking runs
where the data is: no network hop, no per-request token cost, no cold start, and
identical results every time (which is why it can be unit-tested). The LLM adds
*language* on top — a one-line "why" — and its absence degrades the feature
instead of removing it. See [AI.md](AI.md).

**No PostGIS.** Geo is plain `latitude`/`longitude` plus an `IMMUTABLE`
haversine function and a bounding-box pre-filter over a btree index. This keeps
the schema portable, so migrations and geo queries can be executed and asserted
against a throwaway PostgreSQL cluster in CI with no extensions. At city scale
the bbox pre-filter is not the bottleneck; the upgrade path to a
`geography(Point,4326)` column and a GiST index is a single migration, described
in [DATABASE.md](DATABASE.md).

**Stripe for tickets, StoreKit for premium.** Not one universal payment system.
A ticket is a real-world event, so it may go through a card processor; a premium
subscription is digital functionality inside the app, so Apple requires it to go
through In-App Purchase. Mixing those two would get the app rejected.
See [PAYMENTS.md](PAYMENTS.md).

**Integer money.** Every amount is an integer in the currency's minor unit.
There is no float anywhere in the money path.

---

## Where the code lives

```
mobile/src/
  api/          One module per domain: events, profiles, tickets,
                organizations, notifications, ai, admin, premium, signals.
                Screens never call supabase directly.
  auth/         AuthProvider (session + profile + role) and the auth calls.
  components/   EventCard, EventMap, SwipeDeck, and ui.tsx — the primitives
                (Screen, Button, Input, EmptyState, ErrorState, Notice…).
  hooks/        useLocation — real GPS with permission states.
  lib/          supabase client, env, format, errors (code → human message).
  maps/         calendar + external directions.
  notifications/ Expo push registration and local reminders.
  storage/      pick → compress → upload → return public URL.
  theme/        design tokens. No ad-hoc hex values in components.
  types/        the application models.

supabase/
  migrations/   Ordered, immutable once deployed.
  functions/    One directory per endpoint, plus _shared/ for env, http,
                stripe and ai helpers.
  seed/         Opt-in demo data, never a migration.
  tests/        SQL assertions + the local auth shim.
```

The spec asked for `src/screens/` and `src/navigation/`; with Expo Router the
routes *are* the navigation, so screens live in `app/` and everything reusable
lives in `src/`. Route files stay thin and delegate to `src/api` and
`src/components`.

---

## Request lifecycles

**Reading the feed**

```
useLocation (GPS) → api/events.getNearbyEvents
  → rpc events_nearby(lat, lon, radius, …)
    → bbox pre-filter → haversine → RLS-safe projection
  → EventCard list + EventMap markers
```

**Creating an event**

```
Create screen → validation → storage.uploadEventCover (Storage)
  → api/events.createEvent → insert into events
    → RLS: creator_id must equal auth.uid()
    → trigger: paid events require a verified organization
  → realtime INSERT → every open map refreshes
```

**Buying a ticket** — the full flow is in [PAYMENTS.md](PAYMENTS.md). The short
version: the app sends only `{ticket_type_id, quantity}`; everything else is
decided server-side, and the ticket is created by the webhook, not by the app.

**Signals → recommendations**

```
swipe / save / RSVP / open → rpc record_signal (fire-and-forget)
  → user_event_signals
    → recommend_events() derives category affinity from the last 180 days
      → score + breakdown → feed, and the debug screen shows the arithmetic
```

---

## Security model

Layered, so no single mistake is fatal:

1. **Authentication** — Supabase Auth. The app never sees or stores a password.
2. **RLS on every table.** Deny by default; each policy is written against
   `auth.uid()`. `supabase/tests/test_04_rls.sql` asserts the important denials.
3. **Privilege-protection triggers.** Even a permitted `UPDATE` cannot change
   `app_role`, `is_suspended`, `verification_status`, `payouts_enabled`,
   `platform_fee_bps` or any denormalised counter — those columns are reset from
   `OLD` unless the caller is an admin.
4. **No client write path for money.** `orders`, `tickets`, `payments`,
   `ledger_entries`, `payouts` and `premium_subscriptions` have no INSERT/UPDATE
   policy and the grants are revoked. They are written only by SECURITY DEFINER
   functions reachable from the service role.
5. **Signature verification.** Stripe webhooks are HMAC-verified with a
   constant-time comparison and a timestamp tolerance; Apple notifications are
   checked against the JWS certificate chain. An unsigned request is rejected
   before it touches the database.
6. **Idempotency.** `webhook_events` has a unique `(provider, event_id)`;
   `fulfill_order` returns existing tickets instead of minting more. Webhook
   retries are safe by construction.
7. **Secrets never ship.** The app bundle contains only the anon key, the Stripe
   *publishable* key and map keys. Everything else lives in the Edge Function
   environment.
8. **Upload validation.** Buckets enforce MIME types and size limits; storage
   policies derive ownership from the first path segment (`<user-id>/…`).
9. **Rate limiting.** Per-instance limits on checkout, payout and AI endpoints,
   with the hard guarantees kept in the database (unique constraints, balance
   checks) rather than in a counter.

---

## Realtime

Subscribed tables: `events`, `event_attendees`, `comments`, `notifications`,
`tickets`, `orders`, `event_likes`. The home map invalidates its query on any
event change, the detail screen watches its own attendee rows, and the activity
tab updates on notification inserts. Realtime respects RLS, so a user only ever
receives rows they were already allowed to read.

---

## Adding a feature without breaking the previous ones

The workflow this repository is built for:

1. **Migration first** — a new file in `supabase/migrations/`. Never edit a
   migration that has been applied to a live database; add a new one.
2. **RLS for the new tables** in the same migration, and a grant/revoke if it
   touches money.
3. **Assertions** in `supabase/tests/`, then `npm run db:verify`.
4. **Types** in `mobile/src/types/models.ts`.
5. **API module** in `mobile/src/api/` — screens do not call `supabase` directly.
6. **UI** with loading, empty and error states from the start, and a real error
   message in `src/lib/errors.ts`.
7. `npm run typecheck` and `npx expo export` before committing.
8. Update the relevant doc.

Because state lives in Postgres and every change is a forward migration, data
and behaviour survive redeploys: v1 → feature → v2 → feature → v3, with nothing
lost on the way.
