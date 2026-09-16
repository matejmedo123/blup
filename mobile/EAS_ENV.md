# Čo musí byť nastavené, než sa spustí build

`app.config.ts` číta `EXPO_PUBLIC_*` **v čase buildu**. Na tvojom počítači ich
berie z `mobile/.env`; na serveroch EAS žiadne `.env` nie je, takže build bez
nastavených premenných vyrobí appku, ktorá sa spustí a **nepripojí sa nikam** —
prázdna adresa Supabase, žiadne eventy, žiadne prihlásenie, nikde chyba.

Je to tá istá chyba, akú zachytáva `scripts/check-origin.mjs --dist` na webe.
Na natívnom builde ju nikto nezachytí, preto tento súbor.

## Raz, pre každé prostredie

```bash
cd mobile
npx eas login

# production
npx eas env:create --environment production \
  --name EXPO_PUBLIC_SUPABASE_URL --value "https://<project-ref>.supabase.co" --visibility plaintext
npx eas env:create --environment production \
  --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "<anon key>" --visibility sensitive
npx eas env:create --environment production \
  --name EXPO_PUBLIC_WEB_URL --value "https://blup.sk" --visibility plaintext
npx eas env:create --environment production \
  --name EXPO_PUBLIC_DEEPLINK_DOMAIN --value "blup.sk" --visibility plaintext
npx eas env:create --environment production \
  --name EXPO_PUBLIC_IOS_BUNDLE_ID --value "sk.blup.app" --visibility plaintext
npx eas env:create --environment production \
  --name EXPO_PUBLIC_ANDROID_PACKAGE --value "sk.blup.app" --visibility plaintext
npx eas env:create --environment production \
  --name EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY --value "pk_live_..." --visibility sensitive
npx eas env:create --environment production \
  --name EXPO_PUBLIC_VAPID_PUBLIC_KEY --value "<verejná polovica>" --visibility plaintext
npx eas env:create --environment production \
  --name EXPO_PUBLIC_MAPS_API_KEY_ANDROID --value "<kľúč>" --visibility sensitive
```

`--visibility sensitive` znamená, že sa hodnota nevypisuje do logov buildu.
Žiadna z týchto premenných nie je tajná v pravom zmysle — všetky končia
v aplikácii, ktorú si stiahne ktokoľvek. Tajné kľúče (`sk_live_`, service role)
sem **nepatria**; tie žijú iba v Edge Functions.

## Premium na iOS

```bash
# Nenastavovať = appka nepredáva žiadny digitálny obsah. Toto chceš pri prvom
# odoslaní: žiadne In-App Purchase, žiadna provízia.
npx eas env:create --environment production \
  --name EXPO_PUBLIC_PREMIUM_IOS --value "off" --visibility plaintext
```

Na `iap` to prepni, až keď budeš mať v App Store Connect vytvorené predplatné
a zmierený s tým, že Apple si z neho berie 15–30 %. Vstupeniek sa to netýka —
tie idú cez Stripe aj v aplikácii a Apple z nich nemá nič.

## Overenie, že to zabralo

```bash
npx eas env:list --environment production
```

A po builde: prihlás sa v TestFlighte. Ak sa prihlásenie podarí, adresa Supabase
sa do buildu dostala — je to jediná vec, ktorá to overí naisto.
