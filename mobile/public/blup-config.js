/* ===========================================================================
 * BLUP — nastavenie nahratého webu
 * ===========================================================================
 * Tento súbor sa načíta skôr než appka a prebije to, čo bolo zapečené pri
 * builde. Vďaka tomu sa dá ten istý balík nahrať na hosting a nastaviť bez
 * kompilovania — stačí prepísať hodnoty nižšie a súbor uložiť.
 *
 * Prázdna hodnota = ignoruje sa (použije sa tá z buildu). Takže keď si už
 * buildoval so správnym .env, tento súbor netreba meniť.
 *
 * Nič z toho nie je tajné. Presne tieto hodnoty si aj tak stiahne každý
 * návštevník v JavaScripte; anon key je verejný kľúč, ktorý sám o sebe nič
 * neodomkne — dáta chráni RLS v databáze.
 *
 * NIKDY sem nedávaj service_role key, Stripe secret key ani nič, čo začína
 * na sk_ alebo eyJ...service_role. To patrí výhradne do premenných Edge
 * Functions v Supabase.
 * ======================================================================== */
window.__BLUP_CONFIG__ = {
  // Supabase → Project Settings → API → Project URL
  supabaseUrl: '',
  // Supabase → Project Settings → API → anon public
  supabaseAnonKey: '',

  // Stripe → Developers → API keys → Publishable key (pk_live_… / pk_test_…)
  stripePublishableKey: '',

  // Doména, na ktorej web beží. Z nej sa skladá každý odkaz, ktorý appka
  // vydá — zdieľanie eventu, náhľad v chate, odkaz v e-maile so vstupenkou.
  webUrl: 'https://blup.sk',

  // Voliteľné.
  cartoKey: '',
  vapidPublicKey: '',
  routingApiKey: '',
};
