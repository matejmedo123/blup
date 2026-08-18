# Deployment

From a clone to an app on a phone, then to the stores.

---

## 1. Backend

```bash
# The CLI cannot be installed as a global npm module; use npx, or
# install it natively (brew install supabase/tap/supabase).
npx supabase login
npx supabase link --project-ref <your-project-ref>

npx supabase db push                              # migrations
npx supabase secrets set --env-file supabase/.env # server secrets
./scripts/deploy-functions.sh                     # all 9 Edge Functions
```

The deploy script uses `--no-verify-jwt` for `stripe-webhook`,
`iap-apple-notifications`, `push-dispatch` and `config-status`, because Stripe
and Apple cannot present a Supabase JWT — those endpoints authenticate by
signature or by the service-role key instead.

### Auth settings (Supabase dashboard → Authentication)

- **URL Configuration → Site URL**: `blup://`
- **Redirect URLs**: `blup://auth/callback`, `blup://auth/reset-password`
- **Email templates**: the defaults work; the deep-link handler in
  `app/_layout.tsx` exchanges the code for a session.
- **Providers**: enable Apple and Google if you want social sign-in (both need
  developer accounts).

### Scheduled push delivery

`push-dispatch` sends whatever is queued in `notifications`. Schedule it from
the SQL editor:

```sql
select cron.schedule(
  'blup-push', '* * * * *',
  $$ select net.http_post(
       url := 'https://<project-ref>.functions.supabase.co/push-dispatch',
       headers := '{"Authorization": "Bearer <service-role-key>"}'::jsonb
     ); $$
);
```

(Enable the `pg_cron` and `pg_net` extensions first.)

---

## 2. Running the app locally

```bash
cd mobile
npm install
npx expo start          # add --clear after changing .env
```

Press `i`/`a` for a simulator, or scan the QR code with **Expo Go**.

**Expo Go must match the SDK.** This project is on **Expo SDK 57**, which needs
**Expo Go 57.0.9 or newer**. An older Expo Go refuses to open it with
"Project is incompatible with this version of Expo Go". Check the installed
version in Expo Go under the Profile tab; if the store says it is up to date but
the app is older, delete Expo Go and reinstall it — a pending update is not an
applied one.

**Expo Go limits.** Expo Go ships a fixed set of native modules. These need a
real build:

| Feature | Expo Go | Development build |
|---|---|---|
| Auth, events, map (iOS), uploads, RSVP, comments, AI | ✅ | ✅ |
| Google Maps on Android | ❌ | ✅ |
| Stripe PaymentSheet / Apple Pay | ❌ | ✅ |
| In-app purchases (premium) | ❌ | ✅ (plus `react-native-iap`) |
| Push notifications | ❌ | ✅ |
| QR scanner | ⚠️ limited | ✅ |

---

## 3. Development build (the one to install on your phone)

```bash
npm install -g eas-cli
eas login
cd mobile
eas init                 # creates the project and writes EAS_PROJECT_ID
```

**Android** — produces an installable `.apk`:

```bash
npm run build:dev:android
# download the artifact from the EAS link, or:
eas build:run -p android --latest
```

**iOS** — needs an Apple Developer account ($99/yr) and a registered device:

```bash
eas device:create        # register the device once
npm run build:dev:ios
```

Then start the dev server and open it from the installed dev client:

```bash
npx expo start --dev-client
```

### Native config

`app.config.ts` already declares everything: bundle id, Android package,
permissions with real usage strings, deep links (`blup://` plus universal links
when `EXPO_PUBLIC_DEEPLINK_DOMAIN` is set), the Apple Pay merchant id and the
Google Maps keys. `npx expo prebuild --clean` regenerates the native projects
from it — the `ios/` and `android/` folders are gitignored on purpose.

---

## 4. Store builds

```bash
cd mobile
npm run build:prod       # both platforms, production profile
eas submit -p ios
eas submit -p android
```

### Before submitting to Apple

- Real app icon and splash (`assets/`).
- Privacy policy URL — the app collects location, photos and contact data.
- App Privacy questionnaire: precise location (app functionality), photos
  (user content), identifiers, purchases.
- **Premium must be an In-App Purchase.** Ticket purchases through Stripe are
  allowed because they are real-world goods; make that distinction clear in the
  review notes.
- Demo account for the reviewer: seed a project and hand over
  `alex@blup.demo` / `BlupDemo123!`, plus a verified organizer account if you
  want the ticketing flow reviewed.
- `NSLocationWhenInUseUsageDescription` and friends are already set with honest
  strings — reviewers reject vague ones.

### Before submitting to Google

- Data Safety form matching the same collection list.
- Google Maps API key restricted to your package name and SHA-1.
- If you enable premium on Android, implement the Play verification function
  first (see [PAYMENTS.md](PAYMENTS.md)) — it currently returns an explicit
  `GOOGLE_PLAY_VERIFICATION_NOT_CONFIGURED`.

---

## 5. Over-the-air updates

JavaScript-only changes ship without a new binary:

```bash
eas update --branch production --message "Fix event card layout"
```

Anything touching native modules, permissions or `app.config.ts` needs a new
build.

---

## 6. Environments

Keep two Supabase projects — `blup-dev` and `blup-prod` — and switch with the
`.env` files plus EAS build profiles. Migrations flow one way:

```bash
supabase link --project-ref <dev>  && supabase db push
# verify, then
supabase link --project-ref <prod> && supabase db push
```

Never run the seed script against production; it refuses hosted URLs unless you
pass `--force`.

---

## 7. CI

`.github/workflows/ci.yml` runs on every push:

- **database** — installs PostgreSQL 16, applies every migration to an empty
  cluster and runs the 45 SQL assertions.
- **mobile** — `npm ci` and `tsc --noEmit`.

Locally, the same checks:

```bash
npm run db:verify
npm run typecheck
cd mobile && npx expo export --platform android   # proves the bundle builds
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| “BLUP is not connected to a backend yet” | `mobile/.env` missing the Supabase URL/anon key. Restart with `--clear`. |
| Map is blank on Android | Missing or unrestricted `EXPO_PUBLIC_MAPS_API_KEY_ANDROID`, or running in Expo Go. |
| Events exist but the map is empty | Location permission denied, or the radius is too small — the chip in the header cycles 2 km → 100 km. |
| Payment sheet will not open | No `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY`, or running in Expo Go. |
| Paid for a ticket, none appeared | The webhook did not arrive. Check the Stripe dashboard and Supabase function logs; replaying is safe (`fulfill_order` is idempotent). |
| “Organization not verified” | Expected — approve it in Admin → Verifications. |
| Push token errors | Run `eas init`; push needs a physical device. |
| `db:verify` cannot start | Install PostgreSQL 16 locally (`apt install postgresql-16`). |
| Metro resolves nothing after an env change | `npx expo start --clear`. |
| "Project is incompatible with this version of Expo Go" | Expo Go is older than 57.0.9. Delete and reinstall it from the store; updating in place is often not applied. |
| "Card payments need a development build" on checkout | Expected in Expo Go — the Stripe native module is not bundled there. Everything else keeps working. |
