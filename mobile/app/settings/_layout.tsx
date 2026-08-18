import React from 'react';
import { Stack } from 'expo-router';

import { colors } from '@/theme';

export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Nastavenia' }} />
      <Stack.Screen name="profile" options={{ title: 'Upraviť profil' }} />
      <Stack.Screen name="interests" options={{ title: 'Záujmy' }} />
      <Stack.Screen name="notifications" options={{ title: 'Notifikácie' }} />
      <Stack.Screen name="privacy" options={{ title: 'Súkromie' }} />
      <Stack.Screen name="saved" options={{ title: 'Uložené eventy' }} />
      <Stack.Screen name="attending" options={{ title: 'Idem na' }} />
    </Stack>
  );
}
