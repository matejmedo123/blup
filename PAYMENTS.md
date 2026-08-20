# Payments, payouts and premium

Two separate money systems, on purpose.

| | Ticket for an event | Premium subscription |
|---|---|---|
| What it is | A real-world experience | Digital functionality in the app |
| Provider | Stripe (card, Apple Pay, Google Pay) | Apple StoreKit / Google Play Billing |
| Why | Apple does not require IAP for real-world goods | Apple **requires** IAP for in-app digital features |
| Confirmed by | Stripe webhook → `fulfill_order()` | Receipt verified with Apple → `upsert_premium_subscription()` |

Building one universal payment system for both would get the iOS app rejected.

---

## Ticket purchase

```
   app                     checkout-create              Stripe            webhook
    │                            │                        │                  │
    │ {ticket_type_id, qty}      │                        │                  │
    ├───────────────────────────►│                        │                  │
    │                            │ create_order()         │                  │
    │                            │  · availability        │                  │
    │                            │  · sales window        │                  │
    │                            │  · max per order       │                  │
    │                            │  · subtotal + BLUP fee │                  │
    │                            ├───────────────────────►│                  │
    │  client_secret             │  PaymentIntent         │                  │
    │◄───────────────────────────┤                        │                  │
    │                                                     │                  │
    │  PaymentSheet (card / Apple Pay / Google Pay)       │                  │
    ├────────────────────────────────────────────────────►│                  │
    │                                                     │ payment_intent.  │
    │                                                     │ succeeded        │
    │                                                     ├─────────────────►│
    │                                                     │                  │ verify signature
    │                                                     │                  │ fulfill_order()
    │                                                     │                  │  · mark paid
    │                                                     │                  │  · mint tickets
    │                                                     │                  │  · ledger entries
    │                                                     │                  │  · RSVP + notify
    │  poll until the tickets exist                                          │
    │◄───────────────────────────────────────────────────────────────────────┤
```

**"Payment successful" on the phone means nothing.** The success screen only
appears after the ticket rows the webhook created are visible to the client. If
the webhook is slow, the app says so honestly and the ticket appears in *My
tickets* when it lands.

### What the client can and cannot influence

It sends exactly `{ticket_type_id, quantity}` plus an optional promo code. It
cannot set a price, a fee, a currency, an order status, or which organization
gets paid. `create_order()` reads the price from `ticket_types`, the discount
from `evaluate_promo_code()` and the fee schedule from `resolve_fees()`, and
computes:

```
subtotal   = unit_price_cents × quantity
net        = subtotal − discount                       (what the tickets sold for)
archive    = archive_fee_cents × quantity              (0 when net = 0)
commission = net × platform_fee_bps / 10000            (integer division)

buyer pays      = net + archive        when the buyer carries the archive fee
organizer keeps = net − commission     (− archive when the organizer carries it)
BLUP keeps      = commission + archive always
```

`quote_order()` runs exactly this arithmetic without writing anything, so the
checkout screen can show the breakdown before the buyer commits and cannot
disagree with the charge.

`fulfill_order()` additionally refuses to fulfil when the confirmed amount does
not equal `total_cents` (`AMOUNT_MISMATCH`) — asserted in `test_02`.

### Idempotency

Webhooks retry. Two independent guards:

1. `webhook_events` has `unique (provider, event_id)`; a duplicate delivery is
   recorded once and short-circuits.
2. `fulfill_order()` returns the existing tickets when the order is already
   `succeeded`, instead of minting more.

`test_02` replays the same webhook and asserts the ticket count stays at 2.

### Free tickets

If `total_cents = 0`, `checkout-create` calls `fulfill_order()` immediately with
provider `manual`. No payment provider is involved, and the same ticket, ledger
and notification path runs.

---

## The BLUP fee and the organizer ledger

BLUP charges two things, both stored in `platform_settings` so changing the
price is an UPDATE rather than a release:

| | Default | Basis |
|---|---|---|
| Commission | **4.00 %** (`platform_fee_bps = 400`) | the discounted ticket revenue |
| Archive fee | **1.00 € per ticket** (`archive_fee_cents = 100`) | each issued paid ticket |

An organization may carry a negotiated override in
`organizations.platform_fee_bps` / `archive_fee_cents`; `null` means "use the
platform value". Only an admin can write either — `protect_organization_privileges()`
reverts the columns on any other update.

**Who pays the archive fee** is a recorded decision, not an accident of
arithmetic. `archive_fee_payer` defaults to `buyer`: it appears as its own line
on the checkout, which is how ticketing platforms state it and which keeps a
3 € ticket from reaching the organizer as 1.88 €. Setting it to `organizer`
moves it to the organizer's side of the ledger with no application change. Free
tickets are never charged it — an archive fee on a zero-price ticket would be a
fee for nothing.

Every sale writes two or three ledger rows:

```
sale          +net_cents           available_at = now() + settlement_days
platform_fee  −commission_cents    available_at = now() + settlement_days
platform_fee  −archive_fee_cents   only when the organizer carries it
```

The sale credits `net_cents`, not `subtotal_cents`: the organizer is credited
what the buyer actually paid for tickets, so a promo code is funded by the
organizer who issued it rather than by money that was never collected. (Until
migration 0021 it credited the list price — a real bug, fixed there.)

A payout writes `payout −amount` (immediately available). A refund writes
`refund −net` plus an `adjustment +platform_fee` that gives BLUP's cut back —
a refunded order earns BLUP nothing.

`organization_balances` derives everything from those rows:

| Column | Meaning |
|---|---|
| `balance_cents` | everything, settled or not |
| `available_cents` | only entries whose `available_at` has passed — this is what can be withdrawn |
| `pending_cents` | still inside the settlement delay |
| `gross_sales_cents` | sum of `sale` |
| `platform_fee_cents` | everything deducted from the organizer |
| `commission_cents` | the percentage part of that |
| `archive_fee_cents` | the per-ticket part — `0` while the buyer carries it |
| `refunded_cents` | reversed sales |
| `paid_out_cents` | already transferred |

Worked example, asserted in `test_02` (a €25 ticket, quantity 2, 4 % + 1 €):

```
buyer pays      5200   = 5000 tickets + 200 archive fee
sale           +5000
commission      −200
balance         4800   (all pending for 7 days)
payout 4000    −4000
balance          800
refund         −5000 +200 (fee reversal)
balance        −4000

BLUP revenue     400   = 200 commission + 200 archive fee
```

The invariant `test_02` asserts on every order:

```
buyer total = (organizer net) + (BLUP revenue)
```

If that ever fails, money is being invented somewhere.

---

## Accounting export

`accounting_orders()`, `accounting_ledger()` and `accounting_summary()` are the
sales journal, the movement book with a running balance, and the monthly
summary. `platform_accounting_summary()` is the same monthly shape for BLUP's
own books, with boost revenue alongside ticket revenue.

Each one authorizes before it reads a row — owner, admin or finance on that
organization, or a BLUP admin — as a statement rather than a `WHERE` predicate,
because a predicate the planner is free to skip is not an authorization rule.

`accounting-export` renders them as RFC 4180 CSV with a UTF-8 BOM (so Excel
stops guessing a legacy code page and mangling accented event titles) and runs
the query under the **caller's own JWT**, not the service role: a service-role
call presents as "no user", which those functions read as an already-authorized
Edge Function and would skip exactly the check that matters.

---

## Payouts (Stripe Connect)

```
organizer                payout-request               Stripe
    │  {org, amount}          │                          │
    ├────────────────────────►│ request_payout()         │
    │                         │  · role: owner/finance   │
    │                         │  · payouts_enabled       │
    │                         │  · amount ≤ available    │
    │                         │  · write payout + ledger │
    │                         ├─────────────────────────►│ transfer
    │  status                 │                          │
    │◄────────────────────────┤◄─────────────────────────┤ transfer.paid
```

Three things this gets right:

- **The balance check is in the database**, inside the same transaction that
  debits the ledger. Two concurrent requests cannot both succeed against the same
  funds.
- **A failed transfer returns the money.** `mark_payout_failed()` marks the payout
  failed and writes a compensating `adjustment` entry, so the balance never
  silently loses money.
- **KYC is real.** `payouts_enabled` is set from Stripe's `account.updated`
  webhook, never by the organizer. Until onboarding completes, the withdraw
  button is disabled and says why.

If Stripe is not configured, `request_payout()` still records the payout as
`pending` with the ledger correct, and the response says
`PAYMENT_PROVIDER_NOT_CONFIGURED: recorded as pending for manual settlement`. No
fake bank transfer is ever displayed.

### Destination charges

When the organizer has completed Connect onboarding, the PaymentIntent carries
`transfer_data.destination` and `application_fee_amount`, so Stripe splits the
money at the source. Until then the charge stays on the platform account and the
ledger tracks what is owed. Both paths produce identical BLUP accounting.

---

## Premium (Apple StoreKit)

```
StoreKit purchase → receipt → iap-apple-verify
    → POST buy.itunes.apple.com/verifyReceipt   (retry sandbox on 21007)
    → check status == 0 and bundle_id matches
    → derive status: active / trialing / expired / revoked
    → upsert_premium_subscription()   ← the only writer
    → is_premium() now returns true
```

The app cannot grant itself premium: `premium_subscriptions` has no client
INSERT/UPDATE policy and the grants are revoked. `test_04` asserts that a user
trying to insert an `active` subscription is rejected with `insufficient_privilege`.

`iap-apple-notifications` receives App Store Server Notifications V2 (signed
JWS, certificate chain checked) and handles `DID_RENEW`, `EXPIRED`, `REFUND`,
`REVOKE`, `DID_FAIL_TO_RENEW` (→ grace period) and
`DID_CHANGE_RENEWAL_STATUS`. Without it, a cancelled subscription would keep
unlocking features forever.

The native store module (`react-native-iap`) is an **optional** dependency,
resolved at runtime. In Expo Go, or in a build without it, the Premium screen
shows exactly what is missing and how to fix it, rather than a button that does
nothing.

---

## Setting it up

### Stripe

1. Create an account and grab the keys from **Developers → API keys**.
2. Put the publishable key in `mobile/.env` as
   `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and the secret key in `supabase/.env`
   as `STRIPE_SECRET_KEY`.
3. Add a webhook endpoint pointing at
   `https://<project>.functions.supabase.co/stripe-webhook`, subscribed to:
   `payment_intent.succeeded`, `payment_intent.payment_failed`,
   `payment_intent.canceled`, `charge.refunded`, `account.updated`,
   `transfer.created`, `transfer.paid`.
4. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
5. Enable **Connect** (Express accounts) for payouts.
6. `supabase secrets set --env-file supabase/.env && ./scripts/deploy-functions.sh`

Test cards: `4242 4242 4242 4242` succeeds, `4000 0000 0000 9995` is declined.
Forward webhooks locally with `stripe listen --forward-to localhost:54321/functions/v1/stripe-webhook`.

### Apple

1. In App Store Connect create auto-renewable subscription products matching
   `EXPO_PUBLIC_PREMIUM_PRODUCT_ID_MONTHLY` / `..._YEARLY`.
2. Copy the **App-Specific Shared Secret** into `APPLE_SHARED_SECRET`.
3. Set the Server Notifications V2 URL to
   `https://<project>.functions.supabase.co/iap-apple-notifications`.
4. `npm i react-native-iap` in `mobile/`, then `npx expo prebuild` and build with
   EAS — StoreKit does not exist in Expo Go.
5. Test with a sandbox tester account and `APPLE_IAP_ENVIRONMENT=sandbox`.

### Google Play

The abstraction in `mobile/src/api/premium.ts` covers Android, but the
server-side Play verification function is **not implemented**. Purchasing on
Android currently raises `GOOGLE_PLAY_VERIFICATION_NOT_CONFIGURED` rather than
pretending to work. Adding it means writing one Edge Function that calls the
Play Developer API and then reusing `upsert_premium_subscription()`.

---

## Failure modes and what the user sees

| Situation | Behaviour |
|---|---|
| No Stripe keys | Checkout button disabled, banner: “Payments are not configured on this deployment yet.” |
| Card declined | PaymentSheet reports it; the order is marked `failed`; no ticket exists |
| User cancels the sheet | Returns to selection; the order simply expires |
| Webhook slow | “Confirming your payment with the bank…”, then the ticket appears in *My tickets* |
| Webhook never arrives | Order stays `processing`; Stripe’s dashboard can replay it; `fulfill_order` is idempotent |
| Amount tampered with | `AMOUNT_MISMATCH`, no ticket |
| Sold out mid-checkout | `SOLD_OUT` before any charge |
| Payout above available | `INSUFFICIENT_AVAILABLE_BALANCE` with the real figure |
| Transfer fails | Payout marked failed, money returned to the balance, organizer notified |
| IAP module missing | Premium screen explains exactly what to install and build |

---

## Ticket delivery by email

A ticket that only exists inside the app is a ticket you lose when your phone
dies at the door, so every paid order also goes out as an email with a PDF
attached — one page per ticket, QR included.

`fulfill_order()` calls `queue_ticket_email()` in the same transaction that
mints the tickets: an email is never queued for an order that did not complete,
and never lost for one that did. Sending is a separate, retryable step, because
a slow mail provider must not be able to hold up (or roll back) a payment that
already went through.

| Piece | Where |
|---|---|
| Queue + retry state | `email_deliveries`, unique on `(kind, order_id)` |
| Claiming | `claim_email_deliveries()` — `for update skip locked`, so two workers never send the same ticket twice |
| Render + send | `ticket-email` Edge Function |
| QR | `_shared/qr.ts` — ISO/IEC 18004, byte mode, level M |
| PDF | `_shared/pdf.ts` — hand-built, no dependency |

The QR is generated in-house rather than fetched from an image service: the
payload *is* the ticket (`blup://t/{code}/{secret}`), and asking a third party
to render it would mean handing them every ticket's secret.

Retries back off 2/4/8/16 minutes and stop after five attempts, so a permanently
bad address stops burning quota. A deployment with no `RESEND_API_KEY` records
deliveries as `skipped` rather than failing them — an integration that has not
been wired up is not an error to retry.


---

## Baskets

One order has always meant one ticket type. A basket needs several, and still
one payment, so `checkouts` was added as the payment envelope:

```
cart_items  --create_checkout-->  checkout ── order (Early bird x2)
                                          └── order (Standard  x3)
                                   one Stripe Checkout session
                                          |
                              webhook -> fulfill_checkout()
                                          |
                              fulfill_order() per order, as before
```

Nothing about the money model changed. Each order keeps its own commission,
archive fee and ledger entries, so accounting, refunds, analytics and the CSV
export all work with no idea that a basket existed. The single-line native path
is untouched — those orders simply have `checkout_id` null.

Details worth knowing:

* **Reservations hold stock.** `held_quantity()` counts live basket lines plus
  orders that are `processing` or not-yet-expired `requires_payment`. An order
  that never reached a provider expires with the basket it came from; one that is
  `processing` is left alone, because its fate belongs to the webhook and not to
  a timer.
* **20 tickets per order.** In `platform_settings`, enforced in `cart_add` and
  again in `create_order`.
* **A promo code discounts the basket**, once. It is evaluated against the basket
  subtotal, split across the lines by largest remainder so the parts sum exactly,
  and `used_count` goes up by one.
* **References stay unique.** Orders inside a basket carry `pi_123#1`,
  `pi_123#2`, … so `(provider, provider_reference)` remains a unique index and
  `charge.refunded` still finds every order that charge paid for.
* **A free basket takes no card.** If the total is zero, `web-checkout` fulfils
  it directly through `manual` and never touches Stripe.
