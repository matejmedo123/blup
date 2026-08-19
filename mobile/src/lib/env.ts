import Constants from 'expo-constants';

/**
 * Runtime configuration, read from app.config.ts `extra` (which reads
 * EXPO_PUBLIC_* variables at build time).
 *
 * Everything here is PUBLIC by definition — it ships inside the app bundle.
 * Secrets (Stripe secret key, AI key, service-role key, Apple shared secret)
 * live only in the Supabase Edge Function environment.
 */
type Extra = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  stripePublishableKey: string;
  appleMerchantId: string;
  mapsApiKeyAndroid: string;
  mapsApiKeyIos: string;
  routingApiKey: string;
  deeplinkDomain: string;
  premiumProductIdMonthly: string;
  premiumProductIdYearly: string;
  debugAi: boolean;
};

const extra = (Constants.expoConfig?.extra ?? {}) as Partial<Extra>;

export const env = {
  /** Origin the web build is served from; used for shareable links. */
  webUrl: process.env.EXPO_PUBLIC_WEB_URL ?? '',
  /** VAPID public key for Web Push. Public by design — it identifies us to the
   *  push service and cannot be used to send anything. */
  vapidPublicKey: process.env.EXPO_PUBLIC_VAPID_PUBLIC_KEY ?? '',

  supabaseUrl: extra.supabaseUrl ?? '',
  supabaseAnonKey: extra.supabaseAnonKey ?? '',
  stripePublishableKey: extra.stripePublishableKey ?? '',
  appleMerchantId: extra.appleMerchantId ?? '',
  mapsApiKeyAndroid: extra.mapsApiKeyAndroid ?? '',
  mapsApiKeyIos: extra.mapsApiKeyIos ?? '',
  routingApiKey: extra.routingApiKey ?? '',
  deeplinkDomain: extra.deeplinkDomain ?? '',
  premiumProductIdMonthly: extra.premiumProductIdMonthly ?? 'com.blup.app.premium.monthly',
  premiumProductIdYearly: extra.premiumProductIdYearly ?? 'com.blup.app.premium.yearly',
  debugAi: Boolean(extra.debugAi) || __DEV__,
};

/**
 * Which integrations this build can actually reach. The UI uses these to show
 * an honest "not configured" state instead of a button that does nothing.
 */
export const isConfigured = {
  supabase: Boolean(env.supabaseUrl && env.supabaseAnonKey),
  stripe: Boolean(env.stripePublishableKey),
  routing: Boolean(env.routingApiKey),
};

export const MISSING_SUPABASE_MESSAGE =
  'BLUP zatiaľ nie je pripojený na backend.\n\n' +
  'Skopíruj mobile/.env.example do mobile/.env a doplň EXPO_PUBLIC_SUPABASE_URL a ' +
  'EXPO_PUBLIC_SUPABASE_ANON_KEY zo svojho Supabase projektu, potom reštartuj cez ' +
  '`npx expo start --clear`.';
