import React from 'react';
import { Platform, Text } from 'react-native';
import { Stack } from 'expo-router';

import { useLayout } from '@/hooks/useLayout';
import { AUTH_FORM_MAX } from '@/components/authForm';
import { colors, typography } from '@/theme';

export default function AuthLayout() {
  const layout = useLayout();

  /**
   * Nadpis nad formulárom, nie v rohu monitora.
   *
   * Prihlasovacie obrazovky nemajú bočné menu, takže hlavička ide cez celú
   * šírku okna — a na 1920 px stálo „Vytvoriť účet" v ľavom hornom rohu,
   * skoro pol metra od formulára, ku ktorému patrí.
   */
  const gutter = layout.isWide
    ? Math.max(0, (layout.width - AUTH_FORM_MAX) / 2)
    : 0;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.background },
        ...(Platform.OS === 'web' && gutter
          ? {
              headerTitle: ({ children }: { children?: string }) => (
                <Text
                  numberOfLines={1}
                  style={{ ...typography.subheading, color: colors.text, marginLeft: gutter }}
                >
                  {children}
                </Text>
              ),
            }
          : {}),
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
