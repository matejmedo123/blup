import { FunctionError } from './supabase';

/**
 * Turns any thrown value into a message a user can act on.
 *
 * The database raises stable error codes (SOLD_OUT, ORGANIZATION_NOT_VERIFIED,
 * …) and the Edge Functions forward them, so the app can explain what happened
 * instead of showing "something went wrong".
 */
const MESSAGES: Record<string, string> = {
  // auth
  'Invalid login credentials': 'Táto kombinácia e-mailu a hesla nesedí.',
  'Email not confirmed': 'Najprv si potvrď e-mail — odkaz máš v schránke.',
  'User already registered': 'Na tento e-mail už účet existuje. Skús sa prihlásiť.',
  UNAUTHENTICATED: 'Tvoja relácia vypršala. Prihlás sa znova.',
  // GoTrue answers in English; a Slovak app should not hand that to a person.
  'Error sending confirmation email':
    'Potvrdzovací e-mail sa nepodarilo odoslať, takže účet nevznikol. Skús to o chvíľu znova — ak to pretrváva, ozvi sa nám.',
  'Signup requires a valid password': 'Heslo musí mať aspoň 8 znakov.',
  'Password should be at least 6 characters': 'Heslo musí mať aspoň 8 znakov.',
  'Email rate limit exceeded': 'Priveľa pokusov o odoslanie e-mailu. Skús to o pár minút.',
  'For security purposes, you can only request this after':
    'Priveľa pokusov po sebe. Skús to o chvíľu.',
  'User not found': 'Taký účet neexistuje.',
  'New password should be different from the old password':
    'Nové heslo musí byť iné ako to staré.',

  // events
  EVENT_AT_CAPACITY: 'Tento event je plný.',
  EVENT_NOT_AVAILABLE: 'Tento event už nie je dostupný.',
  PAID_EVENT_REQUIRES_ORGANIZATION:
    'Na predaj vstupeniek potrebuješ účet organizátora. Vytvor si ho v Ja → Organizátor.',
  ORGANIZATION_NOT_VERIFIED:
    'Tvoju organizáciu musí BLUP overiť, až potom môžeš predávať vstupenky.',

  // ticketing
  SOLD_OUT: 'Tieto vstupenky sú vypredané.',
  QUANTITY_ABOVE_LIMIT: 'To je viac vstupeniek, než tento event povoľuje na jednu objednávku.',
  SALES_ENDED: 'Predaj vstupeniek na tento event sa skončil.',
  SALES_NOT_STARTED: 'Predaj vstupeniek sa ešte nezačal.',
  TICKET_TYPE_INACTIVE: 'Táto vstupenka už nie je v predaji.',
  AMOUNT_MISMATCH: 'Suma platby nesedela s objednávkou. Nič sme ti nestrhli.',
  EVENT_ALREADY_OVER: 'Tento event už prebehol.',
  EVENT_ALREADY_ENDED: 'Tento event už skončil — propagovať sa dá len to, čo ešte len bude.',
  RECIPIENT_NOT_FOUND: 'Takého používateľa nemám. Potrebuješ @username alebo e-mail, ktorým sa registroval — vstupenka musí niekomu patriť.',
  INVALID_QUANTITY: 'Počet musí byť od 1 do 50.',
  TICKET_TYPE_NOT_FOUND: 'Tento typ vstupenky už neexistuje.',
  EVENT_NOT_CLAIMABLE: 'Prihlásiť sa dá len o event, ktorý pridal BLUP za niekoho iného.',
  CLAIM_NOT_PENDING: 'Tento nárok už niekto vybavil.',
  CLAIM_TOKEN_INVALID: 'Tento odkaz už neplatí — buď ho niekto použil, alebo je zle prekopírovaný.',
  BOOST_PACKAGE_NOT_FOUND: 'Tento balík už nie je v ponuke.',

  // basket
  CART_EMPTY: 'Košík je prázdny.',
  CART_OTHER_EVENT:
    'V košíku máš vstupenky na iný event. Doplať ich alebo košík vyprázdni — jedna objednávka patrí jednému eventu.',
  CART_LIMIT_REACHED: 'Na jednu objednávku ide najviac 10 vstupeniek.',

  // Seating. All three mean "pick another seat", and say which kind of gone it
  // is — a seat somebody is deciding about frees itself, a sold one does not.
  SEAT_HELD: 'Toto miesto si práve drží niekto iný. Skús ho o pár minút, alebo vyber iné.',
  SEAT_TAKEN: 'Toto miesto je už predané. Vyber si iné.',
  SEAT_NOT_SELLABLE: 'Toto miesto sa nepredáva — býva to výhľad alebo vyhradené miesto.',
  SEAT_NOT_FOUND: 'Toto miesto na pláne nenájdeme. Skús stránku obnoviť.',
  SECTION_NOT_ON_SALE: 'Tento sektor zatiaľ nie je v predaji.',
  SEAT_REQUIRED: 'V tomto sektore sa sedí na konkrétnych miestach — vyber si na pláne, kde chceš sedieť.',
  SEAT_WRONG_SECTION: 'Toto miesto patrí do iného sektora, než je vstupenka. Vyber ho na pláne.',
  SEAT_IS_SINGLE: 'Jedno miesto je jedno miesto. Ak vás je viac, vyber viac miest.',
  SEATS_DIFFERENT_EVENTS: 'Vybrané miesta nie sú z toho istého eventu.',
  NO_SEATS: 'Najprv vyber aspoň jedno miesto.',
  // The organizer's side of the plan.
  SEATS_IN_USE: 'Tieto miesta sú už predané alebo ich niekto drží.',
  SECTION_NOT_FOUND: 'Tento sektor už na pláne nie je.',
  VENUE_MAP_NOT_FOUND: 'Tento plán sály už neexistuje.',
  INVALID_GRID: 'Zadaj počet radov aj počet miest v rade — obe aspoň 1.',
  GRID_TOO_BIG: 'Najviac 200 radov a 200 miest v rade. Väčšiu sálu rozdeľ na sektory.',
  INVALID_SEAT_KIND: 'Taký druh miesta nepoznáme.',
  // Waitlist, invites and mail.
  INVALID_EMAIL: 'Táto e-mailová adresa nevyzerá správne.',
  INVITE_CODE_INVALID: 'Taký kód nepoznáme. Skontroluj ho — ľahko sa poplieta O a 0.',
  INVITE_SELF: 'Vlastný kód si uplatniť nemôžeš. To by nebola pozvánka.',
  INVITE_ALREADY_USED: 'Kód od kamaráta sa dá uplatniť raz, a ty už jeden máš.',
  INVITE_TOO_LATE: 'Kód sa dá uplatniť do 14 dní od registrácie.',
  COULD_NOT_ALLOCATE_CODE: 'Kód sa nepodarilo vygenerovať. Skús to o chvíľu znova.',
  TOO_MANY_CAMPAIGNS: 'Tri rozposlania za deň stačia.',
  ORGANIZATION_NOT_FOUND: 'Takú organizáciu nemáme.',
  TOO_MANY_PENDING_ORDERS:
    'Na tento e-mail máš rozpracovaných priveľa objednávok naraz.',
  RESERVATION_EXPIRED: 'Rezervácia vypršala a vstupenky sa vrátili do predaja.',
  CHECKOUT_NOT_FOUND: 'Táto objednávka už neexistuje.',
  AUTH_REQUIRED: 'Na toto sa treba prihlásiť.',

  // payouts
  INSUFFICIENT_AVAILABLE_BALANCE: 'To je viac, než máš k dispozícii.',
  PAYOUTS_NOT_ENABLED: 'Pred výberom dokonči onboarding výplat.',

  // configuration
  PAYMENT_PROVIDER_NOT_CONFIGURED:
    'Platby zatiaľ nie sú na tomto nasadení nakonfigurované. Doplň Stripe kľúče a pokladňa sa zapne.',
  APPLE_IAP_NOT_CONFIGURED:
    'Nákupy Premium zatiaľ nie sú na tomto nasadení nakonfigurované.',
  AI_NOT_CONFIGURED:
    'Služba AI vysvetlení nie je nakonfigurovaná. Odporúčania fungujú ďalej — beží zabudovaný ranker.',
  SUPABASE_NOT_CONFIGURED: 'Backend nie je pre tento build nakonfigurovaný.',

  // generic
  NOT_AUTHORIZED: 'Na toto nemáš oprávnenie.',
  RATE_LIMITED: 'Priveľa pokusov. Chvíľu počkaj a skús znova.',
  CREW_FULL: 'Táto partia je už plná.',
  NETWORK: 'Bez pripojenia. Skontroluj internet a skús znova.',
};

/**
 * Codes whose database HINT is written for the person reading the screen.
 *
 * Most hints are notes to whoever is debugging — English, internal, and no help
 * to a buyer. These few carry the only detail that makes the message actionable
 * ("rad B má predané miesta"), and the sentence is worse without them, so they
 * are appended rather than thrown away. Everything else keeps the flat message.
 */
const HINTS_ARE_FOR_THE_READER = new Set([
  'SEATS_IN_USE',
  'TOO_MANY_PENDING_ORDERS',
]);

function withHint(code: string, message: string, error: unknown): string {
  if (!HINTS_ARE_FOR_THE_READER.has(code)) return message;

  const hint = (error as { hint?: unknown } | null)?.hint;
  return typeof hint === 'string' && hint.trim() ? `${message} ${hint.trim()}` : message;
}

export function messageFor(error: unknown): string {
  if (!error) return 'Niečo sa pokazilo.';

  if (error instanceof FunctionError) {
    // This one carries the function's name as its message, so the text can name
    // it rather than talking about "the Edge Function" in the abstract.
    if (error.code === 'FUNCTION_UNREACHABLE') {
      return `Serverová funkcia „${error.message}" neodpovedá — pravdepodobne nie je nasadená. `
        + 'Nasaď ju cez `./scripts/deploy-functions.sh` a skontroluj, že projekt v '
        + '`mobile/.env` je ten, do ktorého si ju nasadil.';
    }

    return MESSAGES[error.code] ?? error.message ?? 'Niečo sa pokazilo.';
  }

  const raw =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : ((error as { message?: string }).message ?? '');

  // Exact match first, then substring (Postgres wraps codes in a longer message).
  if (MESSAGES[raw]) return withHint(raw, MESSAGES[raw], error);

  for (const [code, message] of Object.entries(MESSAGES)) {
    if (raw.includes(code)) return withHint(code, message, error);
  }

  if (/network request failed|fetch failed/i.test(raw)) return MESSAGES.NETWORK;

  // supabase-js says this when a function is not deployed, is named differently
  // on the server, or died before answering. The raw English sentence tells the
  // person reading it nothing they can act on; the deployment step does.
  if (/failed to send a request to the edge function/i.test(raw)) {
    return 'Serverová funkcia nie je nasadená alebo neodpovedá. Nasaď ju cez '
      + '`./scripts/deploy-functions.sh` a skontroluj, či má nastavené kľúče.';
  }

  return raw || 'Niečo sa pokazilo.';
}

/** True when the failure is "this deployment has no credentials for that". */
export function isConfigurationError(error: unknown): boolean {
  const code = error instanceof FunctionError ? error.code : String((error as Error)?.message ?? '');
  return code.includes('NOT_CONFIGURED');
}
