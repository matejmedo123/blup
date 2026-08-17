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
conversion rate, gross revenue, BLUP fee, organizer net. Host, organizer or
admin only.

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
| `GET /config-status` | none | which integrations have credentials (booleans only) |

### `POST /checkout-create`

```json
// request
{ "ticket_type_id": "uuid", "quantity": 2 }

// response
{
  "order_id": "uuid",
  "status": "requires_payment",
  "requires_payment": true,
  "payment_intent_client_secret": "pi_..._secret_...",
  "amount_cents": 5000,
  "platform_fee_cents": 200,
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
