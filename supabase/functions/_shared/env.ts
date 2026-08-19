/**
 * Typed access to Edge Function secrets.
 *
 * Nothing here is ever bundled into the mobile app — these values live only in
 * the Supabase Edge Function environment (`supabase secrets set ...`).
 *
 * A missing credential is a first-class state, not a crash: the caller gets a
 * `*_NOT_CONFIGURED` error it can render, so the app stays honest about what is
 * wired up. See ENVIRONMENT.md.
 */

export function optionalEnv(name: string): string | undefined {
  const value = Deno.env.get(name);
  return value && value.length > 0 ? value : undefined;
}

export function requireEnv(name: string, errorCode: string): string {
  const value = optionalEnv(name);
  if (!value) {
    throw new ConfigurationError(errorCode, `Missing environment variable ${name}`);
  }
  return value;
}

export class ConfigurationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export const env = {
  supabaseUrl: () => requireEnv('SUPABASE_URL', 'SUPABASE_NOT_CONFIGURED'),
  serviceRoleKey: () => requireEnv('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_NOT_CONFIGURED'),
  anonKey: () => requireEnv('SUPABASE_ANON_KEY', 'SUPABASE_NOT_CONFIGURED'),

  stripeSecretKey: () => requireEnv('STRIPE_SECRET_KEY', 'PAYMENT_PROVIDER_NOT_CONFIGURED'),
  stripeWebhookSecret: () => requireEnv('STRIPE_WEBHOOK_SECRET', 'PAYMENT_PROVIDER_NOT_CONFIGURED'),
  stripeConnectReturnUrl: () => optionalEnv('STRIPE_CONNECT_RETURN_URL') ?? 'blup://organizer/payouts',
  stripeConnectRefreshUrl: () => optionalEnv('STRIPE_CONNECT_REFRESH_URL') ?? 'blup://organizer/payouts',

  appleSharedSecret: () => requireEnv('APPLE_SHARED_SECRET', 'APPLE_IAP_NOT_CONFIGURED'),
  appleBundleId: () => optionalEnv('APPLE_BUNDLE_ID') ?? 'com.blup.app',
  appleEnvironment: () => optionalEnv('APPLE_IAP_ENVIRONMENT') ?? 'production',

  aiProvider: () => optionalEnv('AI_PROVIDER') ?? 'anthropic',
  aiApiKey: () => requireEnv('AI_API_KEY', 'AI_NOT_CONFIGURED'),
  aiModel: () => optionalEnv('AI_MODEL') ?? 'claude-sonnet-5',

  expoAccessToken: () => optionalEnv('EXPO_ACCESS_TOKEN'),

  resendApiKey: () => requireEnv('RESEND_API_KEY', 'EMAIL_NOT_CONFIGURED'),
  emailFrom: () => optionalEnv('EMAIL_FROM') ?? 'Blup <tickets@blup.app>',
  emailReplyTo: () => optionalEnv('EMAIL_REPLY_TO'),
  appUrl: () => optionalEnv('APP_PUBLIC_URL') ?? 'https://blup.app',

  // Web subscriptions. Apple's cut does not apply outside the App Store, so the
  // web build sells Premium through Stripe at the same shelf price.
  stripePremiumMonthly: () => requireEnv('STRIPE_PRICE_PREMIUM_MONTHLY', 'PREMIUM_PRICING_NOT_CONFIGURED'),
  stripePremiumYearly: () => requireEnv('STRIPE_PRICE_PREMIUM_YEARLY', 'PREMIUM_PRICING_NOT_CONFIGURED'),
};

/** True when a provider has everything it needs — used for health reporting. */
export const configured = {
  stripe: () => Boolean(optionalEnv('STRIPE_SECRET_KEY')),
  stripeWebhook: () => Boolean(optionalEnv('STRIPE_WEBHOOK_SECRET')),
  appleIap: () => Boolean(optionalEnv('APPLE_SHARED_SECRET')),
  ai: () => Boolean(optionalEnv('AI_API_KEY')),
  email: () => Boolean(optionalEnv('RESEND_API_KEY')),
  webPremium: () =>
    Boolean(optionalEnv('STRIPE_SECRET_KEY')) &&
    Boolean(optionalEnv('STRIPE_PRICE_PREMIUM_MONTHLY')),
};
