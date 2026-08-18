import React from 'react';
import { Stack } from 'expo-router';

import { colors } from '@/theme';

export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      <Stack.Screen name="sign-up" options={{ title: 'Vytvoriť účet' }} />
      <Stack.Screen name="forgot-password" options={{ title: 'Obnova hesla' }} />
      <Stack.Screen name="reset-password" options={{ title: 'Nové heslo' }} />
      <Stack.Screen name="verify-email" options={{ title: 'Potvrdenie e-mailu' }} />
    </Stack>
  );
}
