import React from 'react';
import { Stack } from 'expo-router';

import { colors } from '@/theme';

export default function OrganizerLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Organizátor' }} />
      <Stack.Screen name="new" options={{ title: 'Nová organizácia' }} />
      <Stack.Screen name="verification" options={{ title: 'Overenie' }} />
      <Stack.Screen name="payouts" options={{ title: 'Zostatok a výplaty' }} />
      <Stack.Screen name="scan" options={{ title: 'Skenovanie vstupeniek' }} />
      <Stack.Screen name="analytics/[id]" options={{ title: 'Štatistiky eventu' }} />
      <Stack.Screen name="tickets/[id]" options={{ title: 'Typy vstupeniek' }} />
      <Stack.Screen name="promo/[id]" options={{ title: 'Promo kódy' }} />
    </Stack>
  );
}
