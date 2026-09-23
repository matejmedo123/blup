# Environment variables

Three files, three trust levels. Templates: `mobile/.env.example`,
`supabase/.env.example`, `.env.example`. None of the real files are committed.

| File | Trust | Read by |
|---|---|---|
| `mobile/.env` | **Public** — shipped inside the app bundle | `app.config.ts` → `src/lib/env.ts` |
| `supabase/.env` | **Secret** — server only | Edge Functions, via `supabase secrets set` |
| `.env` (root) | **Secret** — local only | the seed script |

The rule: if a value would let someone spend money, grant access or impersonate
the platform, it belongs in `supabase/.env` and must never appear in
`mobile/.env`. `EXPO_PUBLIC_*` variables are readable by anyone who downloads the
app — treat them as published.

---

## `mobile/.env` — public

| Variable | Required | Notes |
|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | **yes** | Project Settings → API |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | **yes** | anon key. Safe to ship: RLS is the guard. |
| `EXPO_PUBLIC_MAPS_API_KEY_ANDROID` | for Android maps | Google Cloud, “Maps SDK for Android”. Restrict to your package + SHA-1. |
| `EXPO_PUBLIC_MAPS_API_KEY_IOS` | no | iOS uses Apple Maps by default |
| `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` | for checkout | `pk_test_…` / `pk_live_…`. **Publishable only.** |
| `EXPO_PUBLIC_APPLE_MERCHANT_ID` | for Apple Pay | `merchant.com.blup.app` |
| `EXPO_PUBLIC_PREMIUM_PRODUCT_ID_MONTHLY` | for premium | must match App Store Connect |
| `EXPO_PUBLIC_PREMIUM_PRODUCT_ID_YEARLY` | for premium | " |
| `EXPO_PUBLIC_IOS_BUNDLE_ID` | for builds | default `com.blup.app` |
| `EXPO_PUBLIC_ANDROID_PACKAGE` | for builds | default `com.blup.app` |
| `EXPO_PUBLIC_DEEPLINK_DOMAIN` | no | e.g. `blup.sk`; enables universal/app links |
| `EXPO_PUBLIC_ROUTING_API_KEY` | no | real walking times; without it, straight-line estimates |
| `EXPO_PUBLIC_DEBUG_AI` | no | `true` shows the AI debug screen in release builds |
| `EAS_PROJECT_ID` | for push | written by `eas init` |

Changing any of these requires `npx expo start --clear` (they are inlined at
build time).

---

## `supabase/.env` — server secrets

Load with `supabase secrets set --env-file supabase/.env`.

| Variable | Needed for | Where to find it |
|---|---|---|
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | local function dev | injected automatically in deployed functions |
| `STRIPE_SECRET_KEY` | checkout, payouts | Stripe → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | webhook | Stripe → Webhooks → endpoint → signing secret |
| `STRIPE_CONNECT_RETURN_URL` / `_REFRESH_URL` | payout onboarding | default `blup://organizer/payouts` |
| `APPLE_SHARED_SECRET` | premium | App Store Connect → App-Specific Shared Secret |
| `APPLE_BUNDLE_ID` | premium | must match the built app |
| `APPLE_IAP_ENVIRONMENT` | premium | `sandbox` while testing |
| `APPLE_STRICT_CHAIN_VALIDATION` | premium | keep `true`; `false` only in sandbox |
| `AI_PROVIDER` / `AI_API_KEY` / `AI_MODEL` | LLM explanations | ranking works without them |
| `EXPO_ACCESS_TOKEN` | push (optional) | only if your Expo project enforces push security |
| `TENOR_API_KEY` | GIF search (optional) | Google Cloud → Tenor API. Without it the picker says so and sending your own GIF still works. |
| `TENOR_CLIENT_KEY` | GIF search (optional) | identifies the integration to Tenor; defaults to `blup` |

**The service-role key bypasses RLS.** It exists only inside Edge Functions and
the seed script. It must never reach the app, a client-side build, or a log.

---

## `.env` (root) — seed script

```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

Used by `npm run seed`. The script refuses a hosted `*.supabase.co` URL unless
you pass `--force`, so a stray run cannot fill production with demo accounts.

---

## What works with what

BLUP is built so a missing credential is a visible, explained state — never a
dead button.

| Configured | You get |
|---|---|
| Supabase only | Everything except payments, premium and LLM text: auth, profiles, uploads, GPS, maps (iOS), events, RSVP, social, search, recommendations with template explanations, notifications in-app |
| \+ Google Maps key | Maps on Android |
| \+ Stripe | Ticket checkout, organizer sales, payouts (with Connect onboarding) |
| \+ Apple IAP | Premium subscriptions on iOS |
| \+ `AI_API_KEY` | LLM-written explanations for premium users |
| \+ EAS project | Push notifications on real devices |

`GET /config-status` reports these as booleans (never key material) so the app
can render the right message.

---

## Rotating a key

1. Create the new key in the provider's dashboard.
2. Update `supabase/.env`, run `supabase secrets set --env-file supabase/.env`.
3. Redeploy the affected functions: `./scripts/deploy-functions.sh <name>`.
4. Revoke the old key.

For `mobile/.env` values a rotation means a new build (they are compiled in), so
prefer restricting keys by bundle id / package name over rotating them.

If a service-role key ever leaks: rotate it in Project Settings → API
immediately, then redeploy every function.

## Email (ticket delivery)

| Variable | Required | What it is |
|---|---|---|
| `RESEND_API_KEY` | for email | Resend API key. Without it, deliveries are recorded as `skipped` and the ticket still lives in the app. |
| `EMAIL_FROM` | no | Sender, e.g. `Blup <tickets@blup.sk>`. The domain must be verified with the provider or mail lands in spam. |
| `EMAIL_REPLY_TO` | no | Where replies go — usually support, not the sending address. |
| `APP_PUBLIC_URL` | no | Base URL used in email links. Defaults to `https://blup.sk`. |

Ticket emails are queued by `fulfill_order()` inside the transaction that mints
the tickets, and sent by the `ticket-email` function. Run it on a schedule as
well as from the webhook, so a provider outage recovers on its own:

```
*/5 * * * *  POST /functions/v1/ticket-email   { "limit": 50 }
```

## Web (Stripe subscriptions, no App Store commission)

| Variable | Where | What it is |
|---|---|---|
| `STRIPE_PRICE_PREMIUM_MONTHLY` | server | Stripe Price id for monthly Premium on the web |
| `STRIPE_PRICE_PREMIUM_YEARLY` | server | Stripe Price id for yearly Premium on the web |
| `APP_PUBLIC_URL` | server | Origin Checkout returns to. Return paths are validated against it — an unvalidated redirect after a payment is a phishing kit. |
| `EXPO_PUBLIC_WEB_URL` | client | Origin used in share cards (`og:url`, `og:image`) |

The web build needs **no** `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` — the Checkout
URL is issued by the server, so the browser never holds a Stripe key.

See WEB.md for the full web story.

## Web Push

| Variable | Where | What it is |
|---|---|---|
| `VAPID_PUBLIC_KEY` | server + client | Identifies BLUP to the push service. Public by design. |
| `VAPID_PRIVATE_KEY` | server only | Signs the delivery request. Never leaves the Edge Function environment. |
| `VAPID_SUBJECT` | server | `mailto:` the push service can reach you at. |
| `EXPO_PUBLIC_VAPID_PUBLIC_KEY` | client | The same public key, shipped to the browser. |

Generate once with `node scripts/generate-vapid-keys.mjs`. Rotating the public
key invalidates every existing subscription.


## Scheduled jobs

| Function | Cadence | Auth |
| --- | --- | --- |
| `cart-sweep` | every 1–5 minutes | service-role key in `Authorization` |
| `ticket-email` | every minute (plus a nudge from the webhook) | service-role key |
| `weekly-digest` | weekly | service-role key |
| `push-dispatch` | every minute | service-role key |

`cart-sweep` is housekeeping only. An expired reservation stops holding stock
the moment it expires, whether or not anything has swept it — the sweep exists
to keep dead rows out of the tables and to move never-paid orders to
`cancelled`.

## No new secrets

The basket, the sales curve, the admin event desk and the ad tags all run on
credentials that already exist. Meta and Google tags are configured **in the
app**, by an admin, at `Admin → Marketing` — they are public identifiers that
ship in the page, so they belong in the database rather than in the build.
