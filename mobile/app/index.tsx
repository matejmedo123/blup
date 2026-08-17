import React from 'react';
import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { MISSING_SUPABASE_MESSAGE } from '@/lib/env';
import { colors, spacing, typography } from '@/theme';

/**
 * Entry point: decides where a launch lands.
 *   no backend  → setup instructions
 *   no session  → sign in
 *   no profile  → onboarding
 *   otherwise   → the app
 */
export default function Index() {
  const { initializing, isAuthenticated, needsOnboarding, profile, loadingProfile, backendConfigured } =
    useAuth();

  if (!backendConfigured) {
    return (
      <View style={styles.container}>
        <Text style={styles.logo}>BLUP</Text>
        <Text style={styles.title}>Almost there</Text>
        <Text style={styles.body}>{MISSING_SUPABASE_MESSAGE}</Text>
      </View>
    );
  }

  if (initializing || (isAuthenticated && loadingProfile && !profile)) {
    return (
      <View style={styles.container}>
        <Text style={styles.logo}>BLUP</Text>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!isAuthenticated) return <Redirect href="/(auth)/sign-in" />;
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
  logo: { ...typography.display, color: colors.accent, letterSpacing: 4 },
  title: { ...typography.heading, color: colors.text },
  body: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    maxWidth: 340,
  },
});
