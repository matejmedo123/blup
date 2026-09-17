# API

Two surfaces:

- **Database RPCs and tables** through PostgREST, called with the user's JWT and
  governed by RLS.
- **Edge Functions** for anything needing a secret or authority over the user.

The app never calls either directly from a screen — everything goes through
`mobile/src/api/*`, which is the contract described here.

---

## Client API modules

### `api/events.ts`

| Function | Backed by |
|---|---|
| `getNearbyEvents({latitude, longitude, radiusM, from, to, categories, freeOnly})` | `rpc events_nearby` |
| `searchEvents({query, categories, freeOnly, maxPriceCents, sort, …})` | `rpc search_events` |
| `getEvent(id)` | `events` + creator, organization, gallery, ticket types, own RSVP/save/like |
| `createEvent(input)` / `updateEvent(id, patch)` / `cancelEvent(id)` / `deleteEvent(id)` | `events` |
| `rsvpToEvent(id, 'going' \| 'interested')` / `cancelRsvp(id)` | `event_attendees` |
| `saveEvent(id)` / `unsaveEvent(id)` / `toggleLike(id, liked)` | `saved_events`, `event_likes` |
| `getSavedEvents()` / `getMyEvents()` / `getAttendingEvents()` | joins on the above |
| `getEventAttendees(id)` / `getFollowedAttendees(id)` | `event_attendees` + `follows` |
| `getComments(id)` / `addComment(id, body)` / `deleteComment(id)` | `comments` |

RSVP, save, like and comment also record a behavioural signal.

### `api/profiles.ts`

`getProfile`, `getProfileByUsername`, `updateProfile`, `isUsernameAvailable`,
`updateMyLocation`, `getInterests`, `getMyInterests`, `setMyInterests`,
`getInterestsFor`, `followUser`, `unfollowUser`, `isFollowing`,
`getFollowCounts`, `getFollowers`, `getFollowing`, `getEventsByCreator`,
`searchProfiles`.

### `api/tickets.ts`

| Function | Notes |
|---|---|
| `createCheckout(ticketTypeId, quantity)` | → `checkout-create`; returns a PaymentIntent client secret |
| `waitForTickets(orderId)` | polls until the **webhook** has issued the tickets |
| `getMyTickets()` / `getTicket(id)` / `getMyOrders()` | reads under RLS |
| `ticketQrPayload(ticket)` / `parseTicketQr(payload)` | `blup://t/<code>/<secret>` |
| `checkInTicket(code, secret, eventId?)` | → `rpc check_in_ticket`, validated entirely server-side |

### `api/organizations.ts`

`getMyOrganizations`, `getOrganization`, `createOrganization`,
`updateOrganization`, `requestVerification`, `getVerificationRequests`,
`getOrganizationMembers`, `addOrganizationMember`, `removeOrganizationMember`,
`getOrganizationEvents`, `createTicketType`, `updateTicketType`,
`getOrganizerBalance`, `getLedger`, `getPayouts`, `requestPayout`,
`startPayoutOnboarding`, `refreshPayoutStatus`, `getEventAnalytics`,
`getEventOrders`.

### `api/ai.ts`

`getAIRecommendations({coords, radiusM, limit})` — the Edge Function, with a
direct-RPC fallback. `getRankedEvents(...)` — the ranker on its own.
`getPeopleRecommendations({eventId})`, `describeMatch(match)`,
`getRecentRecommendationRuns()`, `getRecommendationRunItems(runId)`,
`explainBreakdown(breakdown)`.

### `api/notifications.ts`, `api/premium.ts`, `api/admin.ts`, `api/signals.ts`

Notifications: list, unread count, mark read, preferences.
Premium: `getPremiumStatus`, `purchasePremium`, `restorePurchases`, `getStore`.
Admin: stats, users, suspend, event status, verifications, reports, payouts,
plus `reportContent` for all users.
Signals: `recordSignal`, `queueImpression` (batched).

---

## Database RPCs

### `events_nearby`

```
p_lat, p_lon, p_radius_m = 25000, p_from = now(), p_to = null,
p_categories = null, p_free_only = false, p_limit = 50, p_offset = 0
→ setof event_feed_item
```

Bounding-box pre-filter on the `(latitude, longitude)` index, then exact
haversine. Only `published` + `public`/`unlisted` events. Each row carries
`distance_m`, `friends_going`, `is_saved`, `is_attending`.

### `search_events`

Adds `p_query` (full-text over title/description/venue/city, with an `ILIKE` and
a tag fallback), `p_max_price_cents` and
`p_sort` = `start_at` | `distance` | `popularity`.

### `recommend_events`

```
p_user_id = auth.uid(), p_lat, p_lon, p_radius_m = 50000, p_limit = 30
→ setof event_feed_item   (score + score_breakdown populated)
```

See [AI.md](AI.md).

### `recommend_people`

```
p_user_id = auth.uid(), p_event_id = null, p_limit = 20
→ user_id, username, display_name, avatar_url, bio, city,
  shared_interests, shared_interest_names[], mutual_events, mutual_follows,
  same_event, distance_m, score, score_breakdown
```

### `record_signal(p_event_id, p_signal, p_weight, p_context)`

Appends to `user_event_signals`; for `open_detail`/`impression` also writes an
`event_views` row and increments `view_count`.

### `check_in_ticket(p_code, p_qr_secret, p_event_id)`

```json
{ "ok": true,  "ticket_id": "…", "event_title": "…", "checked_in_at": "…" }
{ "ok": false, "reason": "INVALID_SIGNATURE" }
```

Reasons: `TICKET_NOT_FOUND`, `INVALID_SIGNATURE`, `NOT_AUTHORIZED`,
`WRONG_EVENT`, `ALREADY_USED`, `REFUNDED`, `CANCELLED`.
Only the event creator, a member of the owning organization, or an admin may
scan.

### `request_payout(p_organization_id, p_amount_cents)`

Requires the `owner` or `finance` role and `payouts_enabled`; raises
`INSUFFICIENT_AVAILABLE_BALANCE` when the amount exceeds the **settled**
balance. Writes the payout and the debiting ledger entry in one transaction.

### `event_analytics(p_event_id)`

Views, unique viewers, saves, likes, comments, RSVPs, check-ins, tickets sold,
conversion rate, and the full money split: gross (list price), discounts, net,
commission, archive fee, what the organizer keeps and what the buyers paid.
Host, organizer or admin only.

### `quote_order(p_ticket_type_id, p_quantity, p_promo_code)`

Prices a basket without creating anything — the same arithmetic `create_order()`
uses, so checkout can show the archive fee and the discount before the buyer
commits. Returns `{valid, reason, …}` rather than raising: a sold-out ticket or
a mistyped code is normal, not exceptional.

### `resolve_fees(p_organization_id)`

The fee schedule that applies to one organization: the platform values from
`platform_settings` with any negotiated override laid on top.

### `accounting_orders / accounting_ledger / accounting_summary(p_organization_id, p_from, p_to)`

The sales journal, the movement book with a running balance, and the monthly
summary. Owner, admin or finance on that organization, or a BLUP admin — each
one authorizes before it reads a row.

### `platform_accounting_summary(p_from, p_to)`

BLUP's own monthly books: commission, archive fees and boost revenue. Admin
only.

### `admin_*`

`admin_platform_stats`, `admin_suspend_user`, `admin_set_event_status`,
`admin_review_organization`, `admin_resolve_report`,
`admin_update_payout_status`. Each re-checks `is_admin()` internally.

### Service-role only

`create_order`, `fulfill_order`, `fail_order`, `refund_order`,
`mark_payout_failed`, `upsert_premium_subscription` — explicitly revoked from
`authenticated` and `anon`.

---

## Edge Functions

Base URL: `https://<project-ref>.functions.supabase.co`

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /checkout-create` | user JWT | create the order, return a PaymentIntent |
| `POST /organizer-connect` | user JWT | Stripe Connect onboarding / status refresh |
| `POST /payout-request` | user JWT | validate against the ledger, create the transfer |
| `POST /iap-apple-verify` | user JWT | verify a StoreKit receipt with Apple |
| `POST /ai-recommendations` | user JWT | ranked events + explanations, logs the run |
| `POST /stripe-webhook` | Stripe signature | **the only path that mints a ticket** |
| `POST /iap-apple-notifications` | Apple JWS | renewals, expiry, refunds, revocations |
| `POST /push-dispatch` | service-role key | deliver queued notifications via Expo |
| `POST /boost-create` | user JWT | buy a paid boost for an event |
| `POST /accounting-export` | user JWT | books as CSV, rendered under the caller's own session |
| `GET /config-status` | none | which integrations have credentials (booleans only) |
| `POST /ticket-email` | service-role key (or a user JWT to resend one order) | drains the whole mail queue: tickets as PDF, everything else rendered from its payload |
| `GET\|POST /unsubscribe?t=…` | **none** | one click from a mail client, and the RFC 8058 List-Unsubscribe target. No JWT on purpose — the person clicking has no session and often no account |

### `POST /checkout-create`

```json
// request
{ "ticket_type_id": "uuid", "quantity": 2, "promo_code": null }

// response — a EUR 25 ticket x2 on the standard 4 % + 1 EUR schedule
{
  "order_id": "uuid",
  "status": "requires_payment",
  "requires_payment": true,
  "payment_intent_client_secret": "pi_..._secret_...",
  "amount_cents": 5200,          // what the buyer is charged
  "subtotal_cents": 5000,
  "discount_cents": 0,
  "net_cents": 5000,             // ticket revenue after discounts
  "archive_fee_cents": 200,
  "archive_fee_payer": "buyer",
  "commission_cents": 200,
  "platform_fee_cents": 200,     // deducted from the organizer
  "currency": "EUR",
  "quantity": 2,
  "split_at_source": true
}
```

Free tickets return `{"status": "succeeded", "requires_payment": false}` with the
ticket already issued.

### `POST /payout-request`

```json
{ "organization_id": "uuid", "amount_cents": 4000 }
→ { "payout_id": "uuid", "status": "processing", "provider_transfer_id": "tr_…",
    "amount_cents": 4000, "currency": "EUR" }
```

### `GET /config-status`

```json
{
  "payments": { "stripe_configured": false, "webhook_configured": false, "connect_payouts": false },
  "premium":  { "apple_iap_configured": false, "bundle_id": null },
  "ai":       { "llm_configured": false, "provider": "anthropic",
                "ranker": "sql_ranker_v1", "ranker_available": true },
  "push":     { "expo_access_token": false }
}
```

---

## Errors

Every failure returns the same envelope:

```json
{ "error": { "code": "SOLD_OUT", "message": "…", "details": {} } }
```

`mobile/src/lib/errors.ts` maps codes to sentences a user can act on. Notable
codes:

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 401 | missing or expired session |
| `NOT_AUTHORIZED` | 403 | authenticated but not permitted |
| `SOLD_OUT` / `QUANTITY_ABOVE_LIMIT` / `SALES_ENDED` | 400 | ticket availability |
| `PAID_EVENT_REQUIRES_ORGANIZATION` / `ORGANIZATION_NOT_VERIFIED` | 400 | organizer rules |
| `AMOUNT_MISMATCH` | 400 | confirmed amount ≠ order total; nothing is fulfilled |
| `INSUFFICIENT_AVAILABLE_BALANCE` / `PAYOUTS_NOT_ENABLED` | 400 | payout rules |
| `INVALID_SIGNATURE` | 400 | webhook signature failed |
| `RATE_LIMITED` | 429 | too many requests |
| `*_NOT_CONFIGURED` | 503 | the feature exists, this deployment has no credentials |

`503 *_NOT_CONFIGURED` is a first-class state, not a bug: it is how the UI knows
to say "Payments are not configured on this deployment yet" instead of failing
silently.

---

## Realtime

```ts
supabase.channel('home-events')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, refetch)
  .subscribe();
```

Published tables: `events`, `event_attendees`, `comments`, `notifications`,
`tickets`, `orders`, `event_likes`. Subscriptions respect RLS.


---

## Basket (RPC, signed in)

| Call | Returns |
| --- | --- |
| `cart_view(p_promo_code)` | the whole basket: lines, both fees, total, `seconds_left` |
| `cart_add(p_ticket_type_id, p_quantity)` | the basket after adding; restarts the 15-minute hold |
| `cart_set_quantity(p_ticket_type_id, p_quantity)` | 0 removes the line |
| `cart_remove(p_ticket_type_id)` / `cart_clear()` | the basket after removing |
| `ticket_type_availability(p_ticket_type_id)` | `total, sold, held, available` — also readable by `anon` |

Errors worth handling: `CART_OTHER_EVENT`, `CART_LIMIT_REACHED`, `SOLD_OUT`,
`SALES_ENDED`, `EVENT_ALREADY_OVER`, `AUTH_REQUIRED`.

## Paying for a basket

`POST /functions/v1/web-checkout` with `{ "kind": "cart", "promo_code": "..." }`.

The browser sends nothing else — which tickets, how many and what they cost all
come from the reservations already in the database. The response carries
`checkout_id` and a `redirect_url` to Stripe's hosted Checkout; the webhook then
calls `fulfill_checkout` and issues every ticket in the basket at once.

The return page reads `?checkout=<id>` (a basket) or `?order=<id>` (a single
ticket) and waits for the webhook either way. A redirect is not a payment.

## E-mail, waitlist and invites (RPC)

| RPC | Who | What |
|---|---|---|
| `my_email_preferences()` / `set_email_preferences(digest)` | signed in | The digest switch, and whether this address has unsubscribed or gone undeliverable. |
| `email_unsubscribe(token)` | **anon** | One click from a mail client, no session. Returns false for any token that means nothing, rather than saying which — an endpoint that distinguished them would be an address checker. |
| `can_email(address, kind)` | signed in | Whether that kind of mail may go to that address. |
| `campaign_audience(org, audience, event)` | org member | Who would get it, using the same query the send runs. |
| `send_campaign(org, audience, subject, body, event)` | org member | Writes and queues in one transaction. Three a day per organization; verified organizations only. |
| `campaign_report(campaign)` | org member | Queued, delivered, failed, and how many unsubscribed after reading it. |
| `email_queue_stats()` | admin | Budget, what has gone out, what is waiting, what has given up. |
| `join_waitlist(ticket_type, wanted, email)` | **anon** or signed in | "Daj mi vedieť." A guest needs only an address; six queues an hour from one bare address. |
| `leave_waitlist(ticket_type)` / `my_waitlist()` | signed in | Your own places in the queue. |
| `waitlist_size(ticket_type)` | anyone | The count only. Who is waiting is nobody's list, not even the organizer's. |
| `my_invite_code()` / `my_invites()` | signed in | The code (made on first use) and what it has actually done. |
| `claim_invite(code)` | signed in | Within 14 days of signing up, once, never your own and never your own address. |

Service-role only: `notify_waitlists(limit)`, `qualify_invites(limit)`,
`mark_email_undeliverable(address, complaint)`, `ensure_email_contact(…)`.
The first two are called by cron directly in SQL — they are database functions,
not Edge Functions, so no key travels anywhere.

## Seating (RPC)

| RPC | Who | What |
|---|---|---|
| `seat_map_for_event(event)` | anyone | The plan, its sectors, and every seat with `free` / `mine` / `mine_claim` / `hold_until` / `kind`. Null for an event with no plan. |
| `seat_claims(event)` | anyone | Every seat that is not available and why: `held`, `ordered`, `sold`. The one definition the picker, the hold and the order all read. |
| `cart_hold_seat(seat)` | signed in | Holds one seat for the basket window. `SEAT_HELD` / `SEAT_TAKEN` / `SEAT_NOT_SELLABLE`. |
| `cart_hold_seats(seat[])` | signed in | The same for a group — all of them or none. |
| `cart_release_seat(seat)` | signed in | Gives a held seat back. Somebody else's is a no-op, not an error. |
| `suggest_seats(section, count)` | anyone | The best block of `count` seats next to each other: nearest the stage first, then nearest the middle. Never offers a wheelchair or limited-view seat. Empty when the group cannot sit together. |
| `generate_section_seats(section, rows, per_row, start_row)` | venue team | Builds or rebuilds the grid. Refuses to delete a seat somebody holds or bought (`SEATS_IN_USE`); surviving seats keep their id and kind. |
| `set_seat_state(seat[], sellable, kind, note)` | venue team | Takes seats out of sale or says what they are. Null means "leave it". |
| `update_section(section, name, colour, ticket_type, x, y, w, h, sort)` | venue team | Renames, recolours or moves a sector. Refuses to re-point one that has sold. |
| `event_seat_manifest(event)` | organizer | Who sits where, walked sector → row → seat, empty seats included. |
| `event_ticket_holders(event, …)` | organizer | The attendee list; carries `seat_label` and matches a search for `D14`. |

## Organizer

| Call | Returns |
| --- | --- |
| `event_sales_series(p_event_id, p_days)` | one row per day: orders, tickets, gross, net, BLUP's cut, cumulative |

Same authorization as `event_analytics`: host, organization member, or admin.

## Admin

| Call | Returns |
| --- | --- |
| `admin_events(p_query, p_status, p_limit, p_offset)` | every event, with open-report counts |
| `admin_log_event_edit(p_event_id, p_fields, p_reason)` | records an edit to somebody else's event |
| `marketing_tags()` | the ad tag ids the page should load (public) |
| `set_marketing_settings(...)` | writes them; full admin only |

## Maintenance

`POST /functions/v1/cart-sweep` (service-role key only) calls
`release_expired_holds()`. Schedule it every minute or five; nothing breaks if
it does not run, because an expired reservation already holds nothing.
