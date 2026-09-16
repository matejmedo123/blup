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
  webUrl: string;
  /** 'off' = no digital purchases in the iOS app at all. */
  premiumIos: 'iap' | 'off';
  vapidPublicKey: string;
  mapTilesUrl: string;
  mapAttribution: string;
  cartoKey: string;
};

/**
 * Configuration the *served files* carry, rather than the build.
 *
 * `public/blup-config.js` sets `window.__BLUP_CONFIG__` and is loaded before the
 * bundle. It exists because a web export bakes in whatever EXPO_PUBLIC_* values
 * were set the moment it was made: an archive built against a local backend
 * loads perfectly on a real domain and talks to nothing at all. This lets the
 * same archive be pointed at a project by editing one file on the hosting.
 *
 * Only non-empty strings count, so an untouched file with empty placeholders
 * never shadows a build that was configured correctly. Nothing secret belongs
 * here — every value is downloaded by every visitor either way.
 */
function servedConfig(): Partial<Extra> {
  const candidate = (globalThis as { __BLUP_CONFIG__?: unknown }).__BLUP_CONFIG__;
  if (!candidate || typeof candidate !== 'object') return {};

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed !== '') out[key] = trimmed;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out as Partial<Extra>;
}

const extra = {
  ...((Constants.expoConfig?.extra ?? {}) as Partial<Extra>),
  ...servedConfig(),
} as Partial<Extra>;

export const env = {
  /**
   * Everything comes through `extra`, which app.config.ts fills in from
   * EXPO_PUBLIC_* at build time.
   *
   * Reading `process.env` here instead looks identical and does not work: Expo
   * inlines those variables into the config, and the config is what reaches the
   * bundle. A value read directly from process.env is undefined at runtime and
   * quietly falls back to its default — a setting that appears to be ignored,
   * with a clean build and no warning. The `process.env` fallbacks below are
   * for `expo start`, where both paths are live.
   */
  /** Origin the web build is served from; used for shareable links. */
  webUrl: extra.webUrl || process.env.EXPO_PUBLIC_WEB_URL || 'https://blup.sk',
  premiumIos: extra.premiumIos === 'iap' ? 'iap' : 'off',
  /** VAPID public key for Web Push. Public by design — it identifies us to the
   *  push service and cannot be used to send anything. */
  vapidPublicKey: extra.vapidPublicKey || process.env.EXPO_PUBLIC_VAPID_PUBLIC_KEY || '',

  /**
   * Where the web map gets its tiles.
   *
   * A template with `{z}`, `{x}` and `{y}`. Left empty the map uses CARTO's
   * dark basemap with `cartoKey`; set it to point at a provider of your own.
   */
  mapTilesUrl: extra.mapTilesUrl || process.env.EXPO_PUBLIC_MAP_TILES_URL || '',
  mapAttribution: extra.mapAttribution || process.env.EXPO_PUBLIC_MAP_ATTRIBUTION || '',
  /** CARTO basemap key. Public by construction — restrict it by domain. */
  cartoKey: extra.cartoKey || process.env.EXPO_PUBLIC_CARTO_KEY || '',

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
  'Na nahratom webe: otvor blup-config.js vedľa index.html a doplň supabaseUrl a ' +
  'supabaseAnonKey zo Supabase → Project Settings → API.\n\n' +
  'Pri vývoji: skopíruj mobile/.env.example do mobile/.env, doplň ' +
  'EXPO_PUBLIC_SUPABASE_URL a EXPO_PUBLIC_SUPABASE_ANON_KEY a reštartuj cez ' +
  '`npx expo start --clear`.';
