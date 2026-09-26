import React from 'react';
import { Redirect, Stack } from 'expo-router';

import { useAuth } from '@/auth/AuthProvider';
import { colors } from '@/theme';

/**
 * Admin section. Hiding it is not the security control — every admin RPC
 * re-checks is_admin() in the database — but there is no reason to show it.
 */
export default function AdminLayout() {
  const { isAdmin, initializing, loadingProfile } = useAuth();

  if (initializing || loadingProfile) return null;
  if (!isAdmin) return <Redirect href="/(tabs)/profile" />;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Admin' }} />
      <Stack.Screen name="users" options={{ title: 'Používatelia' }} />
      <Stack.Screen name="verifications" options={{ title: 'Overenia' }} />
      <Stack.Screen name="reports" options={{ title: 'Nahlásenia' }} />
      <Stack.Screen name="payouts" options={{ title: 'Výplaty' }} />
      <Stack.Screen name="swap" options={{ title: 'BLUP SWAP' }} />
      <Stack.Screen name="accounting" options={{ title: 'Účtovníctvo platformy' }} />
      <Stack.Screen name="fees" options={{ title: 'Poplatky' }} />
      <Stack.Screen name="marketing" options={{ title: 'Marketing' }} />
      <Stack.Screen name="events" options={{ title: 'Eventy' }} />
      <Stack.Screen name="venues" options={{ title: 'Plány sál' }} />
      <Stack.Screen name="claims" options={{ title: 'Nároky na eventy' }} />
      <Stack.Screen name="policy" options={{ title: 'Výplatná politika' }} />
      <Stack.Screen name="emails" options={{ title: 'E-maily' }} />
      <Stack.Screen name="deployment" options={{ title: 'Stav nasadenia' }} />
    </Stack>
  );
}
