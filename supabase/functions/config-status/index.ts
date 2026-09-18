/**
 * GET /functions/v1/config-status
 *
 * Tells the app which external integrations this deployment actually has
 * credentials for. The UI uses it to render honest states ("Payments not
 * configured") instead of buttons that silently do nothing (spec §42).
 *
 * Returns booleans only — never a key, never a fragment of one.
 */
import { errorResponse, handleOptions, json } from '../_shared/http.ts';
import { configured, env, optionalEnv } from '../_shared/env.ts';
import { stripe } from '../_shared/stripe.ts';

/**
 * The web build shows a price before it sends anyone to Checkout, and the price
 * it shows has to be the price that will be charged — so it is read from the
 * same Stripe Price objects the session is built from, not from a constant that
 * can drift.
 *
 * Cached for the lifetime of the function instance: prices change about never,
 * and this endpoint is public and unauthenticated.
 */
let pricingCache: { at: number; value: unknown } | null = null;
const PRICING_TTL_MS = 10 * 60 * 1000;

async function premiumPricing(): Promise<unknown> {
  if (!configured.webPremium()) return null;
  if (pricingCache && Date.now() - pricingCache.at < PRICING_TTL_MS) return pricingCache.value;

  try {
    const [monthly, yearly] = await Promise.all([
      stripe.retrievePrice(env.stripePremiumMonthly()),
      stripe.retrievePrice(env.stripePremiumYearly()).catch(() => null),
    ]);

    const shape = (price: Awaited<ReturnType<typeof stripe.retrievePrice>> | null) =>
      price
        ? {
            amount_cents: price.unit_amount,
            currency: price.currency?.toUpperCase() ?? 'EUR',
            interval: price.recurring?.interval ?? 'month',
          }
        : null;

    const value = { monthly: shape(monthly), yearly: shape(yearly) };
    pricingCache = { at: Date.now(), value };
    return value;
  } catch (error) {
    // A health endpoint that 500s because Stripe is slow is worse than one that
    // says "prices unknown" — the app falls back to hiding the amount.
    console.error('premium pricing lookup failed:', error);
    return null;
  }
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    return json({
      payments: {
        stripe_configured: configured.stripe(),
        webhook_configured: configured.stripeWebhook(),
        connect_payouts: configured.stripe(),
      },
      premium: {
        apple_iap_configured: configured.appleIap(),
        bundle_id: optionalEnv('APPLE_BUNDLE_ID') ?? null,
        // Web subscriptions: same product, no App Store commission.
        web_configured: configured.webPremium(),
        web_pricing: await premiumPricing(),
      },
      ai: {
        llm_configured: configured.ai(),
        provider: optionalEnv('AI_PROVIDER') ?? 'anthropic',
        // The ranker is pure SQL, so recommendations work with no key at all.
        ranker: 'sql_ranker_v1',
        ranker_available: true,
      },
      push: {
        expo_access_token: Boolean(optionalEnv('EXPO_ACCESS_TOKEN')),
        // The public half is safe to publish — that is what it is for.
        web_push_configured: configured.webPush(),
        vapid_public_key: configured.webPush() ? optionalEnv('VAPID_PUBLIC_KEY') : null,
      },
      email: {
        configured: configured.email(),
        from: configured.email() ? (optionalEnv('EMAIL_FROM') ?? 'Blup <tickets@blup.sk>') : null,
        // Without this, bounces are never recorded and the sending domain's
        // reputation degrades silently until mail starts landing in spam.
        bounce_webhook: configured.emailWebhook(),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
});
