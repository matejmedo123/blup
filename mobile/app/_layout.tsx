import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import { StripeProvider } from '@stripe/stripe-react-native';

import { AuthProvider } from '@/auth/AuthProvider';
import { handleAuthDeepLink } from '@/auth/api';
import { env, isConfigured } from '@/lib/env';
import { colors } from '@/theme';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
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

export default function RootLayout() {
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

  const content = (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '700' },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="(onboarding)" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="event/[id]" options={{ headerTransparent: true, title: '' }} />
      <Stack.Screen name="event/checkout/[id]" options={{ title: 'Checkout' }} />
      <Stack.Screen name="event/edit/[id]" options={{ title: 'Edit event' }} />
      <Stack.Screen name="event/attendees/[id]" options={{ title: 'Who is going' }} />
      <Stack.Screen name="user/[id]" options={{ title: '' }} />
      <Stack.Screen name="tickets/index" options={{ title: 'My tickets' }} />
      <Stack.Screen name="tickets/[id]" options={{ title: 'Ticket' }} />
      <Stack.Screen name="premium" options={{ title: 'BLUP Premium' }} />
      <Stack.Screen name="organizer" options={{ headerShown: false }} />
      <Stack.Screen name="admin" options={{ headerShown: false }} />
      <Stack.Screen name="settings" options={{ headerShown: false }} />
      <Stack.Screen name="debug/ai" options={{ title: 'AI debug' }} />
    </Stack>
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <StatusBar style="light" />
            {isConfigured.stripe ? (
              <StripeProvider
                publishableKey={env.stripePublishableKey}
                merchantIdentifier={env.appleMerchantId || undefined}
              >
                {content}
              </StripeProvider>
            ) : (
              // No Stripe key on this build: the app still runs completely,
              // and the checkout screen explains what is missing.
              content
            )}
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
