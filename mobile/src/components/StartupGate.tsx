import React from 'react';
import { Redirect, useSegments } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { MISSING_SUPABASE_MESSAGE } from '@/lib/env';
import { Wordmark } from '@/components/Wordmark';
import { colors, spacing, typography } from '@/theme';

/**
 * Decides whether a launch may proceed into the app.
 *
 * This used to live in `app/index.tsx`, which was a mistake on web: that file
 * and `app/(tabs)/index.tsx` both claim `/`, so its `<Redirect href="/(tabs)"/>`
 * resolved straight back to `/` — groups are invisible in a URL — and the
 * router gave up with a blank screen. The gate belongs in the layout, where it
 * can run for every route without owning one.
 *
 * Not being signed in is deliberately *not* a redirect. Somebody who opens
 * blup.sk should see what is happening in the city tonight, not a login form.
 */

/** Screens that must render even when the gate would otherwise redirect. */
const ALWAYS_ALLOWED = new Set(['(auth)', '(onboarding)', 'auth']);

export function StartupGate({ children }: { children: React.ReactNode }) {
  const { initializing, isAuthenticated, needsOnboarding, profile, loadingProfile, backendConfigured } =
    useAuth();
  const segments = useSegments();
  const first = String(segments[0] ?? '');

  if (!backendConfigured) {
    return (
      <View style={styles.container}>
        <Wordmark size={44} />
        <Text style={styles.title}>Ešte kúsok</Text>
        <Text style={styles.body}>{MISSING_SUPABASE_MESSAGE}</Text>
      </View>
    );
  }

  if (initializing || (isAuthenticated && loadingProfile && !profile)) {
    return (
      <View style={styles.container}>
        <Wordmark size={44} />
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  // Onboarding and auth screens are exactly where an unfinished profile is
  // supposed to be, so redirecting away from them would loop forever.
  if (needsOnboarding && !ALWAYS_ALLOWED.has(first)) {
    return <Redirect href="/(onboarding)/profile" />;
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.lg,
  },
  title: { ...typography.heading, color: colors.text },
  body: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    maxWidth: 340,
  },
});
