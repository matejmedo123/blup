import React, { useEffect } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, router, type ErrorBoundaryProps } from 'expo-router';
import { StoryRingsProvider, useStoryRings } from '@/components/storyRings';
import { StoryViewer } from '@/components/Stories';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QUERY_CACHE_KEY, queryClient } from '@/lib/queryClient';
import * as Linking from 'expo-linking';
import * as SplashScreen from 'expo-splash-screen';
import { StripeBridge } from '@/payments/stripe';
import { ToastProvider } from '@/components/Toast';

import { AuthProvider } from '@/auth/AuthProvider';
import { AuthGateProvider } from '@/auth/useRequireAuth';
import { AppFrame } from '@/components/AppFrame';
import { CartFab } from '@/components/CartFab';
import { BottomInsetProvider } from '@/components/BottomInset';
import { ImageCropProvider } from '@/components/ImageCrop';
import { DialogProvider } from '@/components/Dialog';
import { AccentProvider } from '@/theme/accent';
import { SponsoredSpotlight } from '@/components/SponsoredSpotlight';
import { RouteProgress } from '@/components/RouteProgress';
import { StartupGate } from '@/components/StartupGate';
import { MarketingTags } from '@/marketing/tags';
import { handleAuthDeepLink } from '@/auth/api';
import { env, isConfigured } from '@/lib/env';
import { registerServiceWorker } from '@/lib/pwa';
import { Wordmark } from '@/components/Wordmark';
import { colors, radius, spacing, typography } from '@/theme';
import { useAppFonts } from '@/theme/fonts';

/**
 * Offline mode ("offline režim – event agenda aj bez netu").
 *
 * The query cache is written to device storage, so tickets, the events you are
 * going to and the last feed you loaded are still readable on a festival field
 * with no signal. Only cacheable reads are persisted — nothing that needs a
 * fresh authorization decision, and no write ever replays from here.
 */
const persister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: QUERY_CACHE_KEY,
  throttleTime: 2000,
});

void SplashScreen.preventAutoHideAsync();

/**
 * The story the app is currently showing, wherever it was opened from.
 *
 * One viewer for the whole app rather than one per list: tapping a ringed face
 * in the inbox and tapping one in the feed have to land in the same place, and
 * a modal that belongs to a row disappears the moment that row scrolls out.
 */
function GlobalStoryViewer() {
  const { opened, close } = useStoryRings();
  return <StoryViewer ring={opened} onClose={close} />;
}

export default function RootLayout() {
  const fontsReady = useAppFonts();

  // Web only: the service worker gives the browser offline support and lets it
  // receive push while no tab is open. A no-op everywhere else.
  useEffect(() => {
    void registerServiceWorker();
  }, []);

  useEffect(() => {
    // Nunito carries the Slovak diacritics; showing the UI before it loads
    // would flash a system fallback and reflow every heading.
    if (fontsReady) void SplashScreen.hideAsync();
  }, [fontsReady]);

  // Email confirmation / password reset links come back into the app here.
  useEffect(() => {
    const handle = (url: string) => {
      if (!url.includes('code=') && !url.includes('access_token=')) return;
      handleAuthDeepLink(url).catch((error) => {
        if (__DEV__) console.warn('Auth deep link failed:', error);
      });
    };

    Linking.getInitialURL().then((url) => url && handle(url));
    const subscription = Linking.addEventListener('url', ({ url }) => handle(url));

    return () => subscription.remove();
  }, []);

  if (!fontsReady) return null;

  const content = (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '700' },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.background },
        // Without this the navigator cuts straight from one screen to the next,
        // which reads as a slide deck rather than an app — and made a fast
        // connection feel exactly as abrupt as a slow one. A phone slides,
        // because that is the direction the gesture goes; the web fades, where
        // there is no gesture and a slide only draws attention to itself.
        animation: Platform.OS === 'web' ? 'fade' : 'slide_from_right',
        animationDuration: 220,
      }}
    >
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="(onboarding)" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="event/[id]" options={{ headerTransparent: true, title: '' }} />
      <Stack.Screen name="event/checkout/[id]" options={{ title: 'Pokladňa' }} />
      <Stack.Screen name="event/edit/[id]" options={{ title: 'Upraviť event' }} />
      <Stack.Screen name="event/attendees/[id]" options={{ title: 'Kto ide' }} />
      <Stack.Screen name="user/[id]" options={{ title: '' }} />
      <Stack.Screen name="org/[id]" options={{ title: '' }} />
      <Stack.Screen name="connect/[id]" options={{ title: 'Blup Connect' }} />
      <Stack.Screen name="legal/[kind]" options={{ title: '' }} />
      <Stack.Screen name="event/seats/[id]" options={{ title: 'Výber miesta' }} />
      <Stack.Screen name="invite" options={{ title: 'Pozvi kamarátov' }} />
      <Stack.Screen name="pozvanka/[code]" options={{ title: 'Pozvánka' }} />
      <Stack.Screen name="cart" options={{ title: 'Košík' }} />
      <Stack.Screen name="tickets/index" options={{ title: 'Moje vstupenky' }} />
      {/* Burza. Bez týchto riadkov ukazuje hlavička surový názov trasy —
          na obrazovke o peniazoch svieti "resale/[event]", čo vyzerá ako
          nedokončená appka práve tam, kde treba vzbudiť dôveru. */}
      <Stack.Screen name="resale/[event]" options={{ title: 'Burza vstupeniek' }} />
      <Stack.Screen name="resale/checkout/[listing]" options={{ title: 'Pokladňa' }} />
      <Stack.Screen name="resale/sell" options={{ title: 'Predať vstupenku' }} />
      <Stack.Screen name="resale/deliver/[order]" options={{ title: 'Doručiť vstupenku' }} />
      <Stack.Screen name="seller/index" options={{ title: 'Predávam' }} />
      <Stack.Screen name="tickets/[id]" options={{ title: 'Vstupenka' }} />
      {/* Both of these are landed on from outside — one after paying, one from
          a link in a ticket e-mail. The header is the first thing that says
          where you are, and it said "checkout/return". */}
      <Stack.Screen name="checkout/return" options={{ title: 'Platba' }} />
      <Stack.Screen name="tickets/claim/[token]" options={{ title: 'Uložiť vstupenku' }} />
      <Stack.Screen name="premium" options={{ title: 'BLUP Premium' }} />
      <Stack.Screen name="activity" options={{ title: 'Notifikácie' }} />
      <Stack.Screen name="search" options={{ headerShown: false }} />
      <Stack.Screen name="badges" options={{ title: 'Odznaky' }} />
      <Stack.Screen name="chat/[id]" options={{ title: '' }} />
      <Stack.Screen name="event/photos/[id]" options={{ title: 'Fotky eventu' }} />
      <Stack.Screen name="people/index" options={{ headerShown: false }} />
      <Stack.Screen name="community/index" options={{ headerShown: false }} />
      <Stack.Screen name="community/new" options={{ title: 'Nová komunita' }} />
      <Stack.Screen name="community/micro" options={{ title: 'Micro-eventy' }} />
      <Stack.Screen name="community/[id]" options={{ title: '' }} />
      <Stack.Screen name="organizer" options={{ headerShown: false }} />
      <Stack.Screen name="admin" options={{ headerShown: false }} />
      <Stack.Screen name="settings" options={{ headerShown: false }} />
      <Stack.Screen name="debug/ai" options={{ title: 'AI debug' }} />
      <Stack.Screen name="auth/callback" options={{ headerShown: false }} />
      <Stack.Screen name="auth/reset-password" options={{ headerShown: false }} />
    </Stack>
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{
            persister,
            maxAge: 24 * 60 * 60 * 1000,
            dehydrateOptions: {
              // Persist only successful reads of things that are useful without
              // a connection; anything else is refetched when the net is back.
              shouldDehydrateQuery: (query) => {
                if (query.state.status !== 'success') return false;
                const root = String(query.queryKey[0] ?? '');
                return ['tickets', 'events', 'event', 'profile', 'interests', 'conversations',
                        'messages', 'gamification'].includes(root);
              },
            },
          }}
        >
          <ToastProvider>
          <AuthProvider>
            <StatusBar style="light" />
            {/* StripeBridge is a passthrough when the key or the native
                module is missing (e.g. Expo Go), so the app always renders. */}
            <StripeBridge
              publishableKey={isConfigured.stripe ? env.stripePublishableKey : ''}
              merchantIdentifier={env.appleMerchantId || undefined}
            >
              {/* Guests browse freely; the gate only appears when they try to
                  do something an account is actually needed for. */}
              {/* On a desktop the sidebar frames every screen, not only the
                  five tabs; AppFrame is a passthrough on phones. */}
              <AuthGateProvider>
                <RouteProgress />
                <StartupGate>
                  {/* Screens say how much of the bottom corner they use, so the
                      basket bubble sits above it instead of on top of it. */}
                  <BottomInsetProvider>
                    {/* The crop sheet renders here so any screen can ask for a
                        picture in a fixed shape without owning a modal. On
                        native it is a pass-through: the OS picker crops. */}
                    {/* The colour of BLUP, per person. Inside the auth gate
                        because it asks the server what applies; outside every
                        screen because it repaints all of them. */}
                    <AccentProvider>
                    <ImageCropProvider>
                      {/* Confirmations and prompts. Ours rather than
                          Alert.alert, which react-native-web implements as an
                          empty function — every "are you sure?" written with it
                          silently did nothing in a browser. */}
                      <DialogProvider>
                        {/* Who has a live story, asked once for the whole app.
                            Every Avatar reads from it, so the ring appears
                            wherever somebody's face does — and the viewer it
                            opens hangs here, over every screen, rather than
                            being re-mounted by each list that draws a face. */}
                        <StoryRingsProvider>
                        <AppFrame>{content}</AppFrame>
                        <GlobalStoryViewer />
                        {/* Floats over every screen so a basket with a ticket in
                            it cannot go unnoticed until the reservation expires. */}
                        <CartFab />
                        {/* At most one sponsored card a day, and only to
                            somebody it fits. Every one of those words is a rule
                            in the database, not a habit of this component. */}
                        <SponsoredSpotlight />
                        </StoryRingsProvider>
                      </DialogProvider>
                    </ImageCropProvider>
                    </AccentProvider>
                  </BottomInsetProvider>
                </StartupGate>
              </AuthGateProvider>
              {/* Ad platform tags, and the consent bar they wait behind.
                  A no-op on native, where there is no pixel to load. */}
              <MarketingTags />
            </StripeBridge>
            </AuthProvider>
        </ToastProvider>
        </PersistQueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * The screen that a crash lands on.
 *
 * Expo Router looks for an `ErrorBoundary` export on a layout route and uses it
 * when anything below throws while rendering. Without one, a single bad render
 * unmounts the tree and leaves a blank white page — which is exactly what a
 * reload appeared to "fix", because a reload is the only way out of it.
 *
 * `retry()` re-renders the failed route rather than reloading the app, so the
 * basket, the session and everything else survive a hiccup.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={errorStyles.container}>
      <Wordmark size={40} />
      <Text style={errorStyles.title}>Toto sa nám nepodarilo zobraziť</Text>
      <Text style={errorStyles.body}>
        Niečo v tejto obrazovke spadlo. Skús to znova — ak to bude pokračovať, napíš nám a
        priloz, čo si robil.
      </Text>
      <Text style={errorStyles.detail} numberOfLines={4}>
        {error.message}
      </Text>

      <Pressable
        accessibilityRole="button"
        onPress={() => retry()}
        style={({ pressed }) => [errorStyles.button, pressed && errorStyles.pressed]}
      >
        <Text style={errorStyles.buttonLabel}>Skúsiť znova</Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        onPress={() => router.replace('/')}
        style={({ pressed }) => [errorStyles.ghost, pressed && errorStyles.pressed]}
      >
        <Text style={errorStyles.ghostLabel}>Späť na domovskú</Text>
      </Pressable>
    </View>
  );
}

const errorStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
  },
  title: { ...typography.heading, color: colors.text, textAlign: 'center' },
  body: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    maxWidth: 360,
    lineHeight: 22,
  },
  detail: {
    ...typography.monoSm,
    color: colors.textTertiary,
    textAlign: 'center',
    maxWidth: 360,
  },
  button: {
    marginTop: spacing.lg,
    height: 48,
    minWidth: 220,
    borderRadius: radius.block,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: { ...typography.captionStrong, color: '#FFFFFF' },
  ghost: { height: 44, alignItems: 'center', justifyContent: 'center' },
  ghostLabel: { ...typography.captionStrong, color: colors.textSecondary },
  pressed: { opacity: 0.9 },
});
