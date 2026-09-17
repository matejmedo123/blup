import React from 'react';
import { Stack } from 'expo-router';

import { useAuth } from '@/auth/AuthProvider';
import { SignInInvite } from '@/components/SignInInvite';
import { colors } from '@/theme';

export default function OrganizerLayout() {
  const { isGuest, initializing } = useAuth();

  if (initializing) return null;

  // A dashboard of zeroes reads as "you have an organizer account and it is
  // empty", which is not true of somebody who has no account at all.
  if (isGuest) {
    return (
      <SignInInvite
        glyph="◆"
        title="Organizátor potrebuje účet"
        body="Vytvor si účet a za pár minút máš event vonku — aj s predajom vstupeniek."
        perks={[
          'Vytvor event a zverejni ho na mape',
          'Predávaj vstupenky s 4 % províziou a 1 € archívnym poplatkom',
          'Sleduj predaj v čase, odbavuj ľudí QR skenerom',
          'Výplaty na účet a export pre účtovníka',
        ]}
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
      <Stack.Screen name="index" options={{ title: 'Organizátor' }} />
      <Stack.Screen name="new" options={{ title: 'Nová organizácia' }} />
      <Stack.Screen name="verification" options={{ title: 'Overenie' }} />
      <Stack.Screen name="payouts" options={{ title: 'Zostatok a výplaty' }} />
      <Stack.Screen name="accounting" options={{ title: 'Účtovníctvo' }} />
      <Stack.Screen name="stats" options={{ title: 'Predaj' }} />
      <Stack.Screen name="scan" options={{ title: 'Skenovanie vstupeniek' }} />
      <Stack.Screen name="analytics/[id]" options={{ title: 'Štatistiky eventu' }} />
      <Stack.Screen name="tickets/[id]" options={{ title: 'Typy vstupeniek' }} />
      <Stack.Screen name="attendees/[id]" options={{ title: 'Kto príde' }} />
      <Stack.Screen name="promo/[id]" options={{ title: 'Promo kódy' }} />
    </Stack>
  );
}
