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
import { configured, optionalEnv } from '../_shared/env.ts';

Deno.serve((req) => {
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
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
});
