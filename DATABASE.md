# Database

PostgreSQL 16. 14 ordered migrations in `supabase/migrations/`, applied with
`supabase db push` and verified end-to-end by `npm run db:verify`.

**Migrations are immutable once applied to a live database.** Change behaviour by
adding a new migration, never by editing an old one.

---

## Extensions and search_path

Supabase installs its extensions into a dedicated `extensions` schema that is
**not** on the default `search_path` while migrations run. Unqualified
`gen_random_bytes()` or a `citext` column therefore fails on a hosted project
while working fine on a local PostgreSQL that put everything in `public`.

Three rules keep the same SQL working on both:

1. Migration 0001 creates the schema and installs `pgcrypto` and `citext` into it.
2. Every migration starts with `set search_path = public, extensions;`.
3. Every function that pins a `search_path` pins **both** schemas — including
   `blup_short_code()`, which would otherwise only work from a session that
   already had `extensions` on its path.

`test_01` calls the pgcrypto-backed helpers from a deliberately bare
`search_path`, so a regression here fails the suite instead of only failing on
a real Supabase project.

---

## Conventions

- **Money** is always an `integer` in the currency's minor unit (cents), never a
  float. Column names end in `_cents`.
- **Geo** is plain `latitude`/`longitude` (`double precision`) plus
  `blup_distance_m()`, an `IMMUTABLE` haversine function.
- **Counters** (`attendee_count`, `saved_count`, …) are maintained by triggers
  and reset from `OLD` on any client update. They are never authoritative input.
- **Enums** are real Postgres enums for closed sets; text + `CHECK` where the set
  should stay open.
- **Timestamps** are `timestamptz`, defaulted to `now()`, with `updated_at`
  maintained by the `set_updated_at()` trigger — not by the client.

---

## Migration order

| File | Contents |
|---|---|
| `…000100_extensions_and_types` | `pgcrypto`, `citext`, all enums, `blup_distance_m`, `set_updated_at`, `blup_short_code` |
| `…000200_profiles_and_interests` | `profiles`, `interests`, `user_interests`, `follows`, `friendships`, `is_admin`, `is_following` |
| `…000300_organizations` | `organizations`, `organization_members`, verification requests, `is_org_member`, `is_org_verified` |
| `…000400_events` | `events`, `event_images`, `event_attendees`, `saved_events`, `event_likes`, `event_views`, counter + capacity triggers, `can_view_event` |
| `…000500_social` | `communities`, `event_crews`, `posts`, `post_likes`, `comments` |
| `…000550_notifications` | `notifications`, `push_tokens`, `notification_preferences`, `notify_user`, notification triggers |
| `…000600_ticketing_and_payments` | `ticket_types`, `orders`, `payments`, `webhook_events`, `tickets`, `ledger_entries`, `payouts`, `organization_balances`, order lifecycle + check-in + payout functions |
| `…000700_premium` | `premium_subscriptions`, `subscription_events`, `is_premium`, `upsert_premium_subscription` |
| `…000800_ai_signals` | `user_event_signals`, `ai_recommendation_runs/items`, `ai_requests`, `record_signal` |
| `…000900_discovery_and_ranking` | `event_feed_item` type, `events_nearby`, `search_events`, `recommend_events`, `recommend_people`, `event_analytics` |
| `…001000_admin_moderation` | `reports`, `admin_audit_log`, admin RPCs |
| `…001100_rls` | RLS enabled everywhere, all policies, privilege-protection triggers, function grants/revokes |
| `…001200_storage_and_realtime` | Storage buckets + policies, realtime publication |
| `…001300_interest_catalogue` | The 45 interests (reference data, not demo data) |
| `…001400_grants` | Explicit role grants; revokes on money tables |
| `…003600_seating` | `venue_maps`, `venue_sections`, `venue_seats`, `cart_hold_seat`, `seat_map_for_event` |
| `…003700_seat_positions` | Seat positions on the plan; "mine" told apart from "taken" |
| `…006600_mailing` | `email_contacts` (consent per address), `can_email`, `email_unsubscribe`, `email_campaigns`, `send_campaign`, hourly send budget, ticket priority in `claim_email_deliveries` |
| `…006700_invite_xp_kind` | Three enum values, alone, because ADD VALUE cannot be used in the transaction that adds it |
| `…006800_waitlist_and_invites` | `ticket_waitlist`, `join_waitlist`, `notify_waitlists`, `profiles.invite_code`, `invites`, `claim_invite`, `qualify_invites` |
| `…006500_seating_v2` | `seat_claims`, the seat carried onto orders and tickets, `cart_hold_seats`, `suggest_seats`, `generate_section_seats`, `set_seat_state`, `update_section`, `event_seat_manifest` |

---

## Core tables

### profiles

1:1 with `auth.users`, created automatically by the `handle_new_user` trigger,
which also derives a unique username from the email and de-duplicates it.

Identity (`username` `citext unique`, `display_name`, `avatar_url`, `bio`),
location (`latitude`, `longitude`, `city`, `location_updated_at`), privacy
(`is_private`, `show_location`, `anonymous_mode`, `allow_dm`), and lifecycle
(`app_role`, `onboarding_completed`, `is_suspended`).

`app_role`, `is_suspended` and `suspended_reason` cannot be changed by the owner —
`protect_profile_privileges()` restores them from `OLD` unless the caller is an
admin. This is what makes self-promotion impossible even with a valid session.

### events

Location, schedule, capacity, pricing, `status`, `visibility` and seven
trigger-maintained counters.

Two rules are enforced in the database, not the UI:

```sql
constraint events_paid_requires_org check (is_free or organization_id is not null)
```

plus `enforce_paid_event_rules()`, which additionally requires the organization
to be **verified**. A paid event created by an unverified organization raises
`ORGANIZATION_NOT_VERIFIED` — asserted in `test_01`.

`enforce_event_capacity()` rejects an RSVP that would exceed `capacity`, counting
only `going` and `checked_in`.

Indexes: `(latitude, longitude)`, `start_at`, `(status, visibility, start_at)`,
GIN on `tags`, and a GIN `to_tsvector` index for full-text search.

### organizations

Branding, `verification_status`, payout state (`stripe_account_id`,
`charges_enabled`, `payouts_enabled`) and `platform_fee_bps` — the BLUP cut in
basis points, default 300 (3.00%).

`protect_organization_privileges()` prevents an organizer from setting their own
verification status, payout flags, fee or Stripe account id. Only an admin can.

Roles in `organization_members`: `owner`, `admin`, `event_manager`, `finance`.
The creator becomes `owner` automatically.

### Ticketing and money

```
ticket_types ──< orders ──< tickets
                   │
                   ├──< payments        (one row per provider transaction)
                   └──< ledger_entries  (signed amounts, per organization)
                                │
                              payouts
```

- **`orders`** — one purchase intent. Amounts are computed by `create_order()`,
  never sent by the client. Unique partial index on
  `(provider, provider_reference)`.
- **`tickets`** — one row per admitted person, with a unique `code` and a
  `qr_secret`. Created only by `fulfill_order()`.
- **`ledger_entries`** — signed: `sale` `+subtotal`, `platform_fee` `−fee`,
  `payout` `−amount`, `refund` `−subtotal`, `adjustment` for reversals.
  `available_at` implements the settlement delay (7 days).
- **`organization_balances`** — a view: `balance`, `available` (settled only),
  `pending`, `gross_sales`, `platform_fee`, `paid_out`.

### Seating (migrations 0036, 0037, 0065)

```
venue_maps ──< venue_sections ──< venue_seats
                    │                  │
              ticket_types      cart_items.venue_seat_id
                                orders.venue_seat_id
                                tickets.venue_seat_id
```

**A sector is a ticket type.** That is the whole trick: pricing, holds, the
per-order ceiling, promo splitting, the ledger and the archive fee already work
on ticket types, so a sector adds a rectangle on a picture and, optionally,
named seats inside it. A sector with no seats sells by count exactly as any
ticket type does.

The rectangles are stored as fractions of the plan image (0..1), so
re-photographing the plan moves nothing. Both the editor and the buyer's picker
draw it at `image_height / image_width`.

**The seat travels: basket → order → ticket.** Migration 0065 closed the gap
that made the whole feature unsafe — `checkout_start()` deleted the cart line
the hold lived on, `create_order()` was never told which seat, and
`fulfill_order()` left `tickets.venue_seat_id` null. A seat is therefore claimed
by three things, and `seat_claims(event)` is the single function that says so:

| claim | source | releases when |
|---|---|---|
| `held` | `cart_items` with `expires_at > now()` | the basket expires |
| `ordered` | `orders` that are `processing`, or `requires_payment` and unexpired | the order is cancelled or expires |
| `sold` | `tickets` with status `valid`/`used` | the ticket is refunded or cancelled |

Two unique partial indexes make double-selling impossible rather than unlikely:
`tickets_seat_once` and `orders_seat_once`. Neither predicate can call `now()`,
so an expired-but-unswept order still blocks its seat — the safe direction to be
wrong in, and `release_expired_holds()` runs on every basket operation.

`create_order()` and `cart_add()` both refuse a ticket type whose sector has
seats when no seat is named (`SEAT_REQUIRED`). Without that the guest checkout
and the plain ticket list each sold numbered stalls seats with no seat on them.

Seats have a `kind` (`standard`, `wheelchair`, `companion`, `limited_view`) and
an `is_sellable` flag, so a pillar or a wheelchair space is a seat that exists
and is not an ordinary chair. `suggest_seats()` only ever offers `standard`.

### E-mail, consent and volume (migration 0066)

```
email_contacts (one row per ADDRESS, account or not)
      │
      ├── can_email(address, kind)
      └── unsubscribe_token ──> /functions/v1/unsubscribe  (anon, one click)

email_campaigns ──< email_deliveries (kind, payload, campaign_id, claimed_at)
```

Consent belongs to the **address**, not the account: a guest who bought one
ticket never made an account and never saw a preferences screen. Three tiers,
and the difference is legal as well as practical:

| tier | kinds | rule |
|---|---|---|
| transactional | `ticket`, `order_refunded`, `waitlist_open` | always, unless the address is dead or complained |
| invited | `invite` | unless unsubscribed |
| marketing | `announcement`, `digest` | `digest` needs `digest_opt_in`; `announcement` needs the recipient to be that organizer's own customer, which `campaign_audience()` establishes by *how it picks the audience* rather than by a flag |

Two ceilings keep a blast from being the last thing this domain ever sends:
`platform_settings.email_per_hour` (counted from `coalesce(sent_at, claimed_at)`,
so rows in flight spend the budget too), and a priority in
`claim_email_deliveries()` that puts a ticket in front of any campaign — a ticket
is somebody standing at a door.

### The waitlist and invites (migration 0068)

`notify_waitlists()` tells the head of the queue when stock returns, and never
more people than there are tickets minus the people already told and still
inside their six-hour window. Nothing is reserved; the mail says so.

`qualify_invites()` pays an invite when the invited person has **confirmed their
address and done something real** — a ticket, or a check-in — never for a
signup. Ten rewards per inviter per 30 days. That single rule is the difference
between a referral scheme and a bounty on making accounts.

### premium_subscriptions

Keyed by `(platform, original_transaction_id)` — the identity that survives
renewals. Written exclusively by `upsert_premium_subscription()` from the
receipt-verification functions. `is_premium()` is the single source of truth for
"is this user premium right now".

### Signals and AI

`user_event_signals` records every meaningful interaction (impression, open,
swipe, save, RSVP, purchase, attend). `ai_recommendation_runs` and
`ai_recommendation_items` persist what was actually served, with the full score
breakdown, which is what the AI debug screen reads. `ai_requests` logs LLM calls
including failures.

---

## Functions worth knowing

| Function | Callable by | Does |
|---|---|---|
| `events_nearby(...)` | anon, authenticated | bbox pre-filter → haversine → feed rows |
| `search_events(...)` | anon, authenticated | full-text + category/date/price/distance filters |
| `recommend_events(...)` | authenticated | the ranker, with `score_breakdown` |
| `recommend_people(...)` | authenticated | shared interests, mutual events, mutual follows |
| `record_signal(...)` | authenticated | append a behavioural signal (+ a view row) |
| `check_in_ticket(code, secret, event?)` | authenticated | validates the QR, the scanner's authority and double use |
| `request_payout(org, amount)` | authenticated (owner/finance) | validates the settled balance, writes the payout + ledger |
| `event_analytics(event)` | authenticated (host/organizer/admin) | views, saves, RSVPs, sales, fee, net |
| `create_order(...)` | **service role only** | computes amounts, checks availability |
| `fulfill_order(...)` | **service role only** | marks paid, mints tickets, writes the ledger — idempotent |
| `refund_order(...)` | **service role only** | reverses sale and fee, invalidates tickets |
| `mark_payout_failed(...)` | **service role only** | returns the money to the balance |
| `upsert_premium_subscription(...)` | **service role only** | the only writer of premium state |
| `admin_*` | admins (checked inside) | suspend, moderate, verify, resolve, payout status |

The service-role functions are explicitly `REVOKE`d from `authenticated` and
`anon` in migration `…001100_rls`.

---

## Row Level Security

Every table has RLS enabled. Highlights:

- **profiles** — self and admins always; others only if not suspended and either
  public or followed.
- **events** — creator, organizers and admins always; everyone else only
  `published` and (`public`/`unlisted`, or `followers` when following).
- **orders/tickets/payments/ledger/payouts/premium** — SELECT only, scoped to
  the buyer, the owning organization's finance roles, or an admin. **No
  INSERT/UPDATE policy exists.**
- **notifications** — strictly the owner.
- **storage** — public read for `avatars`, `event-images`, `org-assets`; write
  only where the first path segment matches `auth.uid()` (or the organization for
  org assets). `verification-docs` is private: only the owning organization and
  admins.

---

## Geo, and when to move to PostGIS

`events_nearby` narrows with a bounding box on the `(latitude, longitude)` btree
index, then filters exactly with `blup_distance_m()`. `blup_lat_delta` and
`blup_lon_delta` convert metres to degrees (the longitude one is
latitude-corrected).

This is deliberate: no extension means the whole schema can be applied and
asserted against a plain PostgreSQL 16 cluster in CI, which is how the 45
assertions run on every push.

Move to PostGIS when a single metro area holds hundreds of thousands of live
events. The migration is small:

```sql
create extension postgis;
alter table events add column location geography(Point, 4326)
  generated always as (st_makepoint(longitude, latitude)::geography) stored;
create index events_location_idx on events using gist (location);
-- then swap the bbox + haversine in events_nearby for st_dwithin/st_distance
```

Nothing above the RPC changes: the app only ever sees `distance_m`.

---

## Testing

```bash
npm run db:verify
```

Creates a throwaway cluster, applies the local auth shim
(`supabase/tests/_local_auth_shim.sql` — a minimal stand-in for Supabase's
`auth` schema, never deployed), runs every migration in order, then the suite:

- `test_01_events_and_rules.sql` — zero state, profile provisioning, paid-event
  rules, counters, capacity, distance maths, nearby, search
- `test_02_ticketing_and_money.sql` — order amounts and fee, per-order limits,
  no tickets before payment, fulfilment, idempotency, amount tampering, ledger
  arithmetic, payout bounds and authorization, QR check-in, refunds, analytics
- `test_03_ai_ranking.sql` — ranking order, explainable breakdown, swipe-left
  suppression, behaviour affinity, social relevance, people matching, run logging
- `test_04_rls.sql` — private profiles, cross-user edits, privilege escalation,
  draft visibility, forged counters, client-side ticket/order/premium/ledger
  writes, notification privacy, admin-only RPCs
- `test_05_messaging.sql` — direct and event conversations, closed inboxes,
  participant-only reads, forged senders, unread counts, rate limiting
- `test_06_gamification.sql` — XP on real actions only, idempotent awards,
  levels, streaks, badges that cannot be self-granted
- `test_07_promo_reviews_boosts.sql` — promo arithmetic and limits, attendee-only
  reviews, paid boosts that activate only on a confirmed payment
- `test_08_fees_and_accounting.sql` — the 4 % + 1 € schedule, free tickets,
  who carries the archive fee, the money-conservation invariant, and the
  accounting export's totals and authorization

Assertions run inside a transaction and roll back, so the suite is repeatable.


---

## Basket and grouped checkout (migration 0025)

`cart_items` is a **reservation**, not a wish list. A line holds its tickets
against every other shopper for `platform_settings.cart_hold_minutes` (15) and
stops holding them the moment it expires — availability is computed from live
rows only, so nothing has to sweep for the arithmetic to be right.

| Object | What it is |
| --- | --- |
| `cart_items` | one line per ticket type, per person, with `expires_at` |
| `checkouts` | the payment envelope: one payment, one or more orders |
| `orders.checkout_id` | null for the single-ticket path, set for a basket |
| `held_quantity(type, exclude_user)` | live basket lines + orders on their way to a provider |
| `ticket_type_availability(type)` | total, sold, held, and what is genuinely left |
| `cart_add / cart_set_quantity / cart_remove / cart_clear / cart_view` | the basket, all scoped to `auth.uid()` |
| `create_checkout(buyer, promo)` | basket -> one order per ticket type, under one checkout |
| `fulfill_checkout(...)` / `fail_checkout(...)` | what the webhook calls for a basket |
| `release_expired_holds()` | housekeeping only; correctness never depends on it |

Two rules the database owns, not the browser:

* **20 tickets per order** (`platform_settings.max_tickets_per_order`), enforced
  in `cart_add` *and* in `create_order`.
* **One basket, one event** — a single payment settles to a single organizer.

A basket promo code is evaluated once against the basket subtotal and split
across the lines by largest remainder, so the parts add up to the whole to the
cent and the code's use counter goes up once, not once per line.

Each order inside a basket keeps its own provider reference (`pi_123#1`,
`pi_123#2`, ...) so the unique index on `(provider, provider_reference)` stays
meaningful and a refunded charge can still find every order it paid for.

## Marketing and sales (migration 0026)

| Object | What it is |
| --- | --- |
| `marketing_settings` | Meta / Google identifiers, admin-only, CHECK-validated |
| `marketing_tags()` | the public subset the page needs, readable by `anon` |
| `set_marketing_settings(...)` | full-admin write, audited |
| `event_sales_series(event, days)` | the daily sales curve for one event |
| `admin_events(query, status, ...)` | every event on the platform, searchable |
| `admin_log_event_edit(event, fields, reason)` | the paper trail when an admin edits somebody else's listing |

The marketing table stores **identifiers, never markup**. A "paste your script
tag" box would be stored XSS with every visitor's session behind it.

## Function privileges (migration 0024)

Earlier migrations tried to lock the money functions down with
`revoke execute ... from authenticated`. That does nothing: PostgreSQL grants
EXECUTE to `PUBLIC` on every new function, and `authenticated` inherits it.
Until 0024, `fulfill_order`, `ticket_email_payload`, `refund_order`,
`upsert_premium_subscription`, `activate_boost`, `link_stripe_customer` and
`notify_user` were all callable with the anon key that ships in the client
bundle.

0024 revokes from `PUBLIC` — the actual source of the grant — and hands EXECUTE
back to `service_role` explicitly. The migration asserts the result and fails if
any of them is still reachable; `supabase/tests/test_11_function_privileges.sql`
asserts it again on every run, in both directions: what must be closed, and what
the app must still be able to call.
