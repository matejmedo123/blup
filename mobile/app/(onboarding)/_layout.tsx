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
      <Stack.Screen name="profile" options={{ title: 'Your profile' }} />
      <Stack.Screen name="interests" options={{ title: 'What are you into?' }} />
      <Stack.Screen name="location" options={{ title: 'Find what is near you' }} />
    </Stack>
  );
}
