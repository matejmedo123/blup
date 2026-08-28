import type { ExpoConfig, ConfigContext } from 'expo/config';

/**
 * BLUP – dynamic Expo config.
 *
 * Public (non-secret) configuration is injected through `extra` and read at
 * runtime via `src/lib/env.ts`. Secrets (Stripe secret key, AI key, Apple
 * shared secret, service-role key) are NEVER referenced here — they only ever
 * live in the Supabase Edge Function environment.
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'BLUP',
  slug: 'blup',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: 'blup',
  userInterfaceStyle: 'dark',
  icon: './assets/icon.png',
  assetBundlePatterns: ['**/*'],
  ios: {
    supportsTablet: false,
    bundleIdentifier: process.env.EXPO_PUBLIC_IOS_BUNDLE_ID ?? 'com.blup.app',
    config: {
      // Apple Maps is used by default on iOS; a Google key is only needed if
      // you switch the provider in src/maps/provider.ts.
      googleMapsApiKey: process.env.EXPO_PUBLIC_MAPS_API_KEY_IOS,
    },
    infoPlist: {
      NSLocationWhenInUseUsageDescription:
        'BLUP uses your location to show events happening around you and how far away they are.',
      NSLocationAlwaysAndWhenInUseUsageDescription:
        'BLUP uses your location to show events happening around you and how far away they are.',
      NSPhotoLibraryUsageDescription:
        'BLUP needs access to your photos so you can set a profile picture and event cover images.',
      NSCameraUsageDescription:
        'BLUP uses the camera to take profile/event photos and to scan ticket QR codes at the door.',
      NSCalendarsUsageDescription:
        'BLUP can add events you are attending to your calendar.',
      ITSAppUsesNonExemptEncryption: false,
    },
    entitlements: {
      'com.apple.developer.in-app-payments': ['merchant.com.blup.app'],
    },
    associatedDomains: process.env.EXPO_PUBLIC_DEEPLINK_DOMAIN
      ? [`applinks:${process.env.EXPO_PUBLIC_DEEPLINK_DOMAIN}`]
      : undefined,
  },
  android: {
    package: process.env.EXPO_PUBLIC_ANDROID_PACKAGE ?? 'com.blup.app',
    adaptiveIcon: {
      backgroundColor: '#2B6BFF',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
    permissions: [
      'ACCESS_COARSE_LOCATION',
      'ACCESS_FINE_LOCATION',
      'CAMERA',
      'READ_CALENDAR',
      'WRITE_CALENDAR',
      'POST_NOTIFICATIONS',
      'VIBRATE',
    ],
    config: {
      googleMaps: {
        apiKey: process.env.EXPO_PUBLIC_MAPS_API_KEY_ANDROID,
      },
    },
    intentFilters: process.env.EXPO_PUBLIC_DEEPLINK_DOMAIN
      ? [
          {
            action: 'VIEW',
            autoVerify: true,
            data: [{ scheme: 'https', host: process.env.EXPO_PUBLIC_DEEPLINK_DOMAIN }],
            category: ['BROWSABLE', 'DEFAULT'],
          },
        ]
      : undefined,
  },
  /**
   * The web build is a first-class target, not a preview — it is the one BLUP
   * launches on, because outside the App Store there is no 15–30 % commission
   * on Premium.
   *
   * Everything native-only has a web sibling: hosted Stripe Checkout instead of
   * the payment sheet, the browser's BarcodeDetector instead of expo-camera,
   * an .ics download instead of the OS calendar, a Blob download instead of the
   * share sheet. Nothing renders a button that does nothing.
   */
  web: {
    bundler: 'metro',
    // 'static' rather than 'single': every route is pre-rendered to its own
    // HTML file, so an event link pasted into a chat shows a real card and a
    // search engine sees a page instead of an empty <div>. The app still
    // hydrates into the same SPA afterwards.
    output: 'static',
    favicon: './assets/favicon.png',
    name: 'Blup — eventy okolo teba',
    shortName: 'Blup',
    lang: 'sk',
    themeColor: '#0A0D12',
    backgroundColor: '#0A0D12',
    description:
      'Nájdi, čo sa dnes deje okolo teba, kúp si lístok na jednom mieste a choď tam s ľuďmi, ktorých poznáš.',
  },
  plugins: [
    'expo-router',
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        resizeMode: 'contain',
        backgroundColor: '#08090D',
      },
    ],
    'expo-secure-store',
    'expo-web-browser',
    'expo-image',
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'BLUP uses your location to show events happening around you.',
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission:
          'BLUP needs access to your photos so you can set a profile picture and event covers.',
        cameraPermission: 'BLUP uses the camera to take profile and event photos.',
      },
    ],
    [
      'expo-camera',
      { cameraPermission: 'BLUP uses the camera to scan ticket QR codes at the door.' },
    ],
    [
      'expo-calendar',
      { calendarPermission: 'BLUP can add events you are attending to your calendar.' },
    ],
    [
      'expo-notifications',
      { color: '#5B8CFF', defaultChannel: 'default' },
    ],
    [
      '@stripe/stripe-react-native',
      {
        merchantIdentifier: process.env.EXPO_PUBLIC_APPLE_MERCHANT_ID ?? 'merchant.com.blup.app',
        enableGooglePay: true,
      },
    ],
  ],
  experiments: { typedRoutes: false },
  extra: {
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
    supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
    stripePublishableKey: process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '',
    appleMerchantId: process.env.EXPO_PUBLIC_APPLE_MERCHANT_ID ?? '',
    mapsApiKeyAndroid: process.env.EXPO_PUBLIC_MAPS_API_KEY_ANDROID ?? '',
    mapsApiKeyIos: process.env.EXPO_PUBLIC_MAPS_API_KEY_IOS ?? '',
    routingApiKey: process.env.EXPO_PUBLIC_ROUTING_API_KEY ?? '',
    deeplinkDomain: process.env.EXPO_PUBLIC_DEEPLINK_DOMAIN ?? '',
    premiumProductIdMonthly:
      process.env.EXPO_PUBLIC_PREMIUM_PRODUCT_ID_MONTHLY ?? 'com.blup.app.premium.monthly',
    premiumProductIdYearly:
      process.env.EXPO_PUBLIC_PREMIUM_PRODUCT_ID_YEARLY ?? 'com.blup.app.premium.yearly',
    debugAi: process.env.EXPO_PUBLIC_DEBUG_AI === 'true',

    // Read here, not from process.env inside the app. Expo inlines
    // EXPO_PUBLIC_* into the *config*, and `extra` is what reaches the bundle —
    // a component reading process.env directly gets undefined at runtime and
    // silently falls back to its default, which is exactly what happened to the
    // map: the tiles URL was set, the build was clean, and nothing changed.
    webUrl: process.env.EXPO_PUBLIC_WEB_URL ?? '',
    vapidPublicKey: process.env.EXPO_PUBLIC_VAPID_PUBLIC_KEY ?? '',

    mapTilesUrl: process.env.EXPO_PUBLIC_MAP_TILES_URL ?? '',
    mapAttribution: process.env.EXPO_PUBLIC_MAP_ATTRIBUTION ?? '',
    // CARTO basemap key. Not a secret and cannot be made into one: it ends up
    // in the JavaScript every visitor downloads, which is true of any tile key.
    // What protects it is the domain restriction in CARTO's dashboard, so keep
    // this one limited to blup.sk. EXPO_PUBLIC_CARTO_KEY overrides it.
    cartoKey:
      process.env.EXPO_PUBLIC_CARTO_KEY || 'cb1_2fbx_1_94af91e6bc014253ab48e733',
    eas: { projectId: process.env.EAS_PROJECT_ID },
  },
});
