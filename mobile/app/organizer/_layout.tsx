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
      <Stack.Screen name="promo/[id]" options={{ title: 'Propagácia a promo kódy' }} />
      {/* Registered HERE, not in the root layout. A screen belongs to the
          nearest Stack above it, and a title set on the wrong one is simply
          ignored — the header then falls back to the route name, which is how
          "plan/[id]" ended up written across the top of the seating editor. */}
      <Stack.Screen name="create" options={{ title: 'Nový event' }} />
      <Stack.Screen name="profile" options={{ title: 'Verejný profil a logo' }} />
      <Stack.Screen name="plan/[id]" options={{ title: 'Plán sály' }} />
      <Stack.Screen name="seating/[id]" options={{ title: 'Sedenie' }} />
      <Stack.Screen name="announce/[id]" options={{ title: 'Napísať ľuďom' }} />
    </Stack>
  );
}
