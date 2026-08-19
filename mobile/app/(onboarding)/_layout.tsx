import React from 'react';
import { Stack } from 'expo-router';

import { colors } from '@/theme';

export default function OnboardingLayout() {
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
