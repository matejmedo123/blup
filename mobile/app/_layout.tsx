import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import * as SplashScreen from 'expo-splash-screen';
import { StripeBridge } from '@/payments/stripe';
import { ToastProvider } from '@/components/Toast';

import { AuthProvider } from '@/auth/AuthProvider';
import { AuthGateProvider } from '@/auth/useRequireAuth';
import { AppFrame } from '@/components/AppFrame';
import { RouteProgress } from '@/components/RouteProgress';
import { StartupGate } from '@/components/StartupGate';
import { MarketingTags } from '@/marketing/tags';
import { handleAuthDeepLink } from '@/auth/api';
import { env, isConfigured } from '@/lib/env';
import { registerServiceWorker } from '@/lib/pwa';
import { colors } from '@/theme';
import { useAppFonts } from '@/theme/fonts';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Keep answers for a day so the offline agenda has something to show.
      gcTime: 24 * 60 * 60 * 1000,
      retry: (failureCount, error) => {
        // Never retry an authorization failure — it will never succeed.
        const message = (error as Error)?.message ?? '';
        if (message.includes('NOT_AUTHORIZED') || message.includes('UNAUTHENTICATED')) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
  },
});

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
  key: 'blup-query-cache',
  throttleTime: 2000,
});

void SplashScreen.preventAutoHideAsync();

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
      <Stack.Screen name="organizer/plan/[id]" options={{ title: 'Plán sály' }} />
      <Stack.Screen name="cart" options={{ title: 'Košík' }} />
      <Stack.Screen name="tickets/index" options={{ title: 'Moje vstupenky' }} />
      <Stack.Screen name="tickets/[id]" options={{ title: 'Vstupenka' }} />
      <Stack.Screen name="premium" options={{ title: 'BLUP Premium' }} />
      <Stack.Screen name="activity" options={{ title: 'Notifikácie' }} />
      <Stack.Screen name="search" options={{ headerShown: false }} />
      <Stack.Screen name="badges" options={{ title: 'Odznaky' }} />
      <Stack.Screen name="chat/[id]" options={{ title: '' }} />
      <Stack.Screen name="event/photos/[id]" options={{ title: 'Fotky eventu' }} />
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
                  <AppFrame>{content}</AppFrame>
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
