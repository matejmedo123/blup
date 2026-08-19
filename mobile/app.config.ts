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
  // The web build is a convenience target: it runs the whole app in a browser
  // so it can be tried without a device. react-native-maps and the payment
  // SDKs are native-only, and those screens say so explicitly on web.
  web: { bundler: 'metro', output: 'single', favicon: './assets/favicon.png' },
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
    eas: { projectId: process.env.EAS_PROJECT_ID },
  },
});
