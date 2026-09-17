import React from 'react';
import { Stack } from 'expo-router';

import { useAuth } from '@/auth/AuthProvider';
import { SignInInvite } from '@/components/SignInInvite';
import { colors } from '@/theme';

export default function SettingsLayout() {
  const { isGuest, initializing } = useAuth();

  if (initializing) return null;

  // Every row here settles on an account: saved events, interests, privacy,
  // notifications. There is nothing to configure for somebody who has none.
  if (isGuest) {
    return (
      <SignInInvite
        glyph="⚙"
        title="Nastavenia patria k účtu"
        body="Záujmy, súkromie, notifikácie aj uložené eventy sa viažu na účet."
      />
    );
  }

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
      <Stack.Screen name="emails" options={{ title: 'E-maily' }} />
      <Stack.Screen name="privacy" options={{ title: 'Súkromie' }} />
      <Stack.Screen name="look" options={{ title: 'Vzhľad' }} />
      <Stack.Screen name="saved" options={{ title: 'Uložené eventy' }} />
      <Stack.Screen name="attending" options={{ title: 'Idem na' }} />
    </Stack>
  );
}
