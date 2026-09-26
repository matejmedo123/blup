/**
 * POST /functions/v1/seller-connect
 *
 * Výplatný účet pre predajcu na burze. Vráti odkaz, na ktorom si človek
 * overí totožnosť a zadá číslo účtu u poskytovateľa platieb.
 *
 * Číslo účtu ani doklady cez nás neprechádzajú a v našej databáze nie sú.
 * Držíme len identifikátor účtu a to, či je pripravený prijať peniaze —
 * a aj to druhé sa berie od poskytovateľa, nie od človeka.
 *
 * Oddelené od `organizer-connect` zámerne: organizátor je firma a Stripe od
 * neho pýta firemné údaje. Predajca na burze je fyzická osoba, ktorá žiadne
 * IČO nemá, a poslať ju cez firemné onboardovanie znamená pýtať si doklady,
 * ktoré neexistujú.
 */
import {
  ApiError, adminClient, errorResponse, handleOptions, json, rateLimit, requireUser,
} from '../_shared/http.ts';
import { stripe } from '../_shared/stripe.ts';

/** Krajiny, v ktorých vieme vyplácať. Mimo nich by onboardovanie zlyhalo. */
const DEFAULT_COUNTRY = 'SK';

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    if (req.method !== 'POST') {
      throw new ApiError('METHOD_NOT_ALLOWED', 'Use POST', 405);
    }

    const user = await requireUser(req);
    rateLimit(`seller-connect:${user.id}`, 5, 60_000);

    const db = adminClient();

    const { data: existing } = await db
      .from('seller_accounts')
      .select('provider_account_id, payouts_enabled, country')
      .eq('user_id', user.id)
      .maybeSingle();

    let accountId = existing?.provider_account_id ?? null;

    if (!accountId) {
      const account = await stripe.createSellerAccount({
        email: user.email,
        country: existing?.country ?? DEFAULT_COUNTRY,
        userId: user.id,
      });
      accountId = account.id;

      await db.from('seller_accounts').upsert({
        user_id: user.id,
        provider: 'stripe',
        provider_account_id: accountId,
        country: existing?.country ?? DEFAULT_COUNTRY,
        payouts_enabled: false,
      });
    } else {
      // Účty založené skôr, než sme ručné výplaty vynucovali, sú stále na
      // automatickom rozvrhu — peniaze by si samy odtiekli do banky spod
      // nášho zadržania. Onboardovanie je jediná chvíľa, keď sme spoľahlivo
      // volaní, tak sa to pri ňom prepne znova.
      await stripe.setManualPayouts(accountId);
    }

    // Stav sa berie od poskytovateľa, nie od človeka. Keby si `payouts_enabled`
    // vedel prepnúť sám, obišiel by overenie totožnosti.
    const account = await stripe.retrieveAccount(accountId);
    const ready = Boolean(account.payouts_enabled);

    await db
      .from('seller_accounts')
      .update({ payouts_enabled: ready })
      .eq('user_id', user.id);

    if (ready) {
      return json({ account_id: accountId, payouts_enabled: true, onboarding_url: null });
    }

    const link = await stripe.createAccountLink(accountId);
    return json({
      account_id: accountId,
      payouts_enabled: false,
      onboarding_url: link.url,
      expires_at: link.expires_at,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
