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
      <Stack.Screen name="index" options={{ title: 'Organizer' }} />
      <Stack.Screen name="new" options={{ title: 'New organization' }} />
      <Stack.Screen name="verification" options={{ title: 'Get verified' }} />
      <Stack.Screen name="payouts" options={{ title: 'Balance & payouts' }} />
      <Stack.Screen name="scan" options={{ title: 'Scan tickets' }} />
      <Stack.Screen name="analytics/[id]" options={{ title: 'Event analytics' }} />
      <Stack.Screen name="tickets/[id]" options={{ title: 'Ticket types' }} />
    </Stack>
  );
}
