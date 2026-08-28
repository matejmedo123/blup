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
  vapidPublicKey: string;
  mapTilesUrl: string;
  mapLabelsUrl: string;
  mapAttribution: string;
  mapTilesDarken: string;
  cartoKey: string;
};

const extra = (Constants.expoConfig?.extra ?? {}) as Partial<Extra>;

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
  webUrl: extra.webUrl || process.env.EXPO_PUBLIC_WEB_URL || '',
  /** VAPID public key for Web Push. Public by design — it identifies us to the
   *  push service and cannot be used to send anything. */
  vapidPublicKey: extra.vapidPublicKey || process.env.EXPO_PUBLIC_VAPID_PUBLIC_KEY || '',

  /**
   * Where the web map gets its tiles.
   *
   * Templates with `{z}`, `{x}` and `{y}`. Left empty, the map uses a keyless
   * dark basemap that works out of the box. Set these to use a provider you
   * have an account with — e.g. CARTO, whose dark basemap now stamps
   * "API KEY REQUIRED" across every tile unless the key is in the URL:
   *
   *   EXPO_PUBLIC_MAP_TILES_URL=https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?api_key=YOUR_KEY
   *   EXPO_PUBLIC_MAP_ATTRIBUTION=© OpenStreetMap · CARTO
   *
   * A full basemap already has its labels, so `MAP_LABELS_URL` stays empty for
   * those; it exists for providers that ship labels as a separate overlay.
   */
  mapTilesUrl: extra.mapTilesUrl || process.env.EXPO_PUBLIC_MAP_TILES_URL || '',
  mapLabelsUrl: extra.mapLabelsUrl || process.env.EXPO_PUBLIC_MAP_LABELS_URL || '',
  mapAttribution: extra.mapAttribution || process.env.EXPO_PUBLIC_MAP_ATTRIBUTION || '',
  /** '1' inverts the tiles for a dark app, '0' leaves them alone. */
  mapTilesDarken: extra.mapTilesDarken || process.env.EXPO_PUBLIC_MAP_TILES_DARKEN || '',
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
  'Skopíruj mobile/.env.example do mobile/.env a doplň EXPO_PUBLIC_SUPABASE_URL a ' +
  'EXPO_PUBLIC_SUPABASE_ANON_KEY zo svojho Supabase projektu, potom reštartuj cez ' +
  '`npx expo start --clear`.';
