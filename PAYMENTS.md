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

It sends exactly `{ticket_type_id, quantity}`. It cannot set a price, a fee, a
currency, an order status, or which organization gets paid. `create_order()`
reads the price from `ticket_types`, the fee from `organizations.platform_fee_bps`,
and computes:

```
subtotal = unit_price_cents × quantity
fee      = subtotal × platform_fee_bps / 10000    (integer division)
total    = subtotal                                (the buyer pays the ticket price)
```

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

BLUP takes a percentage of every ticket sale — `platform_fee_bps`, default 300
(3.00%), adjustable per organization by an admin only.

Every sale writes two ledger rows:

```
sale          +subtotal_cents      available_at = now() + 7 days
platform_fee  −fee_cents           available_at = now() + 7 days
```

A payout writes `payout −amount` (immediately available). A refund writes
`refund −subtotal` plus an `adjustment +fee` that gives the fee back.

`organization_balances` derives everything from those rows:

| Column | Meaning |
|---|---|
| `balance_cents` | everything, settled or not |
| `available_cents` | only entries whose `available_at` has passed — this is what can be withdrawn |
| `pending_cents` | still inside the settlement delay |
| `gross_sales_cents` | sum of `sale` |
| `platform_fee_cents` | what BLUP took |
| `paid_out_cents` | already transferred |

Worked example, asserted in `test_02` (a €25 ticket, quantity 2, 4% fee):

```
gross           5000
BLUP fee        −200
balance         4800   (all pending for 7 days)
payout 4000    −4000
balance          800
refund         −5000 +200 (fee reversal)
balance        −4000
```

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
