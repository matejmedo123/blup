import React from 'react';
import { Redirect, Stack } from 'expo-router';

import { useAuth } from '@/auth/AuthProvider';
import { colors } from '@/theme';

export default function OnboardingLayout() {
  const { isGuest, initializing } = useAuth();

  if (initializing) return null;

  // Onboarding is meaningless without an account to onboard. It also shares the
  // `/profile` path with the "Ja" tab — groups are invisible in the URL — so a
  // visitor who types blup.sk/profile would otherwise cold-load into "Kto si?".
  if (isGuest) return <Redirect href="/(tabs)/profile" />;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        headerBackVisible: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      {/* The shell draws its own header, so the navigator adds none. */}
      <Stack.Screen name="profile" options={{ headerShown: false }} />
      <Stack.Screen name="interests" options={{ headerShown: false }} />
      <Stack.Screen name="location" options={{ headerShown: false }} />
    </Stack>
  );
}
