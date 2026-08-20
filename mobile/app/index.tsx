import React from 'react';
import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { MISSING_SUPABASE_MESSAGE } from '@/lib/env';
import { Wordmark } from '@/components/Wordmark';
import { colors, spacing, typography } from '@/theme';

/**
 * Entry point: decides where a launch lands.
 *   no backend  → setup instructions
 *   no profile  → onboarding (signed in, but never finished setting up)
 *   otherwise   → the app
 *
 * Not being signed in is deliberately *not* a redirect. Somebody who opens
 * blup.app should see what is happening in the city tonight, not a login form:
 * an events app that demands an account before showing a single event has
 * nothing to show for itself. The account is asked for at the moment it is
 * needed — going, buying, writing — and not a second earlier.
 */
export default function Index() {
  const { initializing, isAuthenticated, needsOnboarding, profile, loadingProfile, backendConfigured } =
    useAuth();

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

  if (needsOnboarding) return <Redirect href="/(onboarding)/profile" />;

  return <Redirect href="/(tabs)" />;
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
