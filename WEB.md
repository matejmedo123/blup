# BLUP on the web

The web build is not a preview. It is the target BLUP launches on, for one
concrete reason: outside the App Store there is no 15–30 % commission on
Premium, and a subscription business that hands away a third of its revenue
before it has a single customer is starting from behind.

It is the **same codebase** — same screens, same API layer, same design system,
same database. What changes is only the handful of places where a browser
genuinely cannot do what a phone does.

```
mobile/                     one app, three platforms
├─ app/**                   every route runs on all three
├─ src/payments/
│  ├─ checkout.ts           native: PaymentSheet
│  └─ checkout.web.ts       web:    hosted Stripe Checkout
├─ src/api/
│  ├─ accounting.ts         native: share sheet
│  └─ accounting.web.ts     web:    Blob download
├─ src/maps/calendar.web.ts .ics download instead of the OS calendar
├─ src/notifications/push.web.ts   honest "not here yet" instead of a fake
├─ app/organizer/scan.web.tsx      BarcodeDetector + manual entry
└─ app/+html.tsx            the document shell: meta, manifest, share card
```

Metro resolves `*.web.ts(x)` before the plain file, so nothing branches at
runtime and nothing native is bundled into the browser build.

---

## What differs, and why

| | Native | Web |
|---|---|---|
| **Ticket payment** | Stripe PaymentSheet in-app | Stripe hosted Checkout (redirect) |
| **Premium** | Apple IAP, 15–30 % commission | Stripe subscription, **no commission** |
| **Boost** | PaymentIntent + PaymentSheet | Stripe hosted Checkout |
| **Manage subscription** | Settings → Apple ID | Stripe billing portal |
| **Door scanner** | expo-camera | `BarcodeDetector`, plus manual entry |
| **Add to calendar** | writes to the OS calendar | downloads an `.ics` |
| **Accounting export** | share sheet | file download |
| **Sharing an event** | OS share sheet | `navigator.share`, else the clipboard |
| **Push notifications** | APNs / FCM via Expo | Web Push (RFC 8291), same `notifications` rows |
| **Maps** | react-native-maps | tiled map: pan, zoom, markers, no dependency |
| **Offline** | persisted query cache | service worker + the same query cache |
| **Install** | App Store / Play | PWA — "Add to home screen" |

Two rules held throughout: **no button does nothing**, and **nothing is
faked**. Where the web cannot do something, it says so and offers what it can.

### Payments

Both platforms create the order with the same `create_order()`, so the price,
the discount, the 4 % commission and the €1 archive fee are decided in the
database either way. Both wait for the webhook before showing a ticket. The
only difference is where the card is typed.

Hosted Checkout was chosen over card fields in our own page deliberately: it
brings Apple Pay, Google Pay, Link and 3-D Secure with it, and no card number
ever touches BLUP's origin.

### Premium without Apple

`web-checkout` creates a Stripe subscription; the webhook writes it into the
same `premium_subscriptions` table Apple receipts write into, with
`platform = 'stripe'`. The unique key is `(platform, original_transaction_id)`,
so an Apple subscription and a Stripe one are two rows and `is_premium()` sees
whichever is active. Somebody who subscribes on the web keeps Premium when they
later install the app, and nobody is ever charged twice.

The price shown before the redirect is read from the same Stripe Price object
the session is built from — a quoted price that could drift from the charged
one is worse than no price at all.

`web_premium_status()` returns `managed_here`, which is false for an Apple
subscription: a web page cannot cancel one, and offering a button that pretends
otherwise leaves somebody believing they cancelled when they did not.

---

## Building and serving

```bash
cd mobile
npm run web            # dev server
npm run build:web      # static export to mobile/dist
npm run serve:web      # serve the export locally on :4321
```

`output: 'static'` pre-renders every route to its own HTML file, so an event
link pasted into a chat shows a real card and a search engine sees a page
rather than an empty `<div>`. The app hydrates into the same SPA afterwards.

Deploy `mobile/dist` to any static host. Two requirements:

1. **SPA fallback** for unknown paths (`/event/abc123` is a client route).
   Vercel/Netlify do this from the export; nginx needs
   `try_files $uri $uri.html $uri/index.html /index.html;`.
2. **HTTPS**, because Stripe, the camera and the clipboard all refuse to work
   without it.

### Environment

Client (`mobile/.env`, all public):

```
EXPO_PUBLIC_SUPABASE_URL=…
EXPO_PUBLIC_SUPABASE_ANON_KEY=…
EXPO_PUBLIC_WEB_URL=https://blup.app       # used for share cards
```

Server (`supabase secrets set …`):

```
STRIPE_SECRET_KEY=…
STRIPE_WEBHOOK_SECRET=…
STRIPE_PRICE_PREMIUM_MONTHLY=price_…       # web Premium
STRIPE_PRICE_PREMIUM_YEARLY=price_…
APP_PUBLIC_URL=https://blup.app            # where Checkout returns to
RESEND_API_KEY=…                           # ticket emails
```

The web build needs **no** `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY`: the Checkout
URL is issued by the server, so the browser never holds a Stripe key.

### Stripe webhook events

Point the endpoint at `/functions/v1/stripe-webhook` and subscribe to:

```
payment_intent.succeeded          tickets and boosts
payment_intent.payment_failed
payment_intent.canceled
charge.refunded
checkout.session.completed        web Premium starts here
customer.subscription.created
customer.subscription.updated     renewal, cancellation, card failure
customer.subscription.deleted
```

`return_url` is validated against `APP_PUBLIC_URL` and must be a path on that
origin — an echoed redirect on a page that has just taken money is a phishing
kit, not a convenience.

---

### The map

`react-native-maps` has no web build, so `EventMap.web.tsx` draws a slippy map
directly: Web Mercator tiles in a grid, markers positioned over them, drag to
pan and wheel to zoom. About two hundred lines and no dependency — which
matters more than it sounds, because Leaflet and Mapbox GL each want a
stylesheet Metro cannot import and a bundle several times the size.

Tiles come from CARTO's dark basemap over OpenStreetMap data. **Attribution is
rendered on the map because it is a condition of use.** Both are courtesy tiers:
fine for a launch, not for scale. When traffic outgrows them, change
`TILE_URL` in that one file to a paid provider (MapTiler, Stadia, Mapbox) — the
rest of the component does not care where a tile came from.

### Push notifications

Real Web Push, not a shim. The browser hands out a subscription, the server
encrypts each notification so only that browser can read it (RFC 8291) and
signs the request so the push service knows it is us (VAPID, RFC 8292). Both
are implemented in `_shared/webpush.ts` on Web Crypto alone, and verified by a
round-trip test that decrypts as a browser would.

The same `notifications` rows drive phones and browsers; `push-dispatch` splits
them by `push_tokens.platform` and fans out to Expo and to Web Push in one run.
A `404`/`410` from the push service means the browser threw the subscription
away, and the row is deleted rather than retried forever.

Generate the keys once:

```bash
node scripts/generate-vapid-keys.mjs
```

Rotating the public key invalidates every existing subscription and every
browser has to be asked again — so generate once and keep it.

**iOS caveat:** Safari grants push only to a site installed to the home screen,
never to a tab. `registerForPushNotifications()` returns `NEEDS_INSTALL` there
and the UI says how to install, rather than reporting a generic failure.

### Offline

The service worker (`public/sw.js`) caches the app shell and the content-hashed
bundles, so opening Blup with no connection shows the app rather than the
browser's error page; the app then hydrates from its own persisted query cache,
which already holds your tickets and the events you are going to.

Nothing from the API is cached by the worker. Two caches disagreeing about the
same data is worse than one cache — the query cache knows what is safe to keep,
the service worker does not.

Verified with the origin server killed outright: the page still loads and
renders.

---

## Still missing on the web

- **Background sync.** An action taken offline is not queued and replayed; it
  fails and says so. Replaying writes needs care around idempotency that has
  not been built.
- **Native-quality maps at scale.** The tile provider is a courtesy tier (see
  above).
