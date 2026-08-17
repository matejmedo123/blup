import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import { useAuth } from '@/auth/AuthProvider';
import { env } from '@/lib/env';
import { Button, Caption, Divider, Screen, SectionHeader } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

export default function SettingsScreen() {
  const { profile, signOut, isAdmin } = useAuth();

  return (
    <Screen scroll>
      <SectionHeader title="Account" />
      <Row label="Edit profile" onPress={() => router.push('/settings/profile')} />
      <Row label="Interests" onPress={() => router.push('/settings/interests')} />
      <Row label="Privacy" onPress={() => router.push('/settings/privacy')} />
      <Row label="Notifications" onPress={() => router.push('/settings/notifications')} />

      <SectionHeader title="Your stuff" />
      <Row label="Saved events" onPress={() => router.push('/settings/saved')} />
      <Row label="Going to" onPress={() => router.push('/settings/attending')} />
      <Row label="Tickets" onPress={() => router.push('/tickets')} />
      <Row label="BLUP Premium" onPress={() => router.push('/premium')} />

      <SectionHeader title="Organizing" />
      <Row label="Organizer dashboard" onPress={() => router.push('/organizer')} />

      {isAdmin ? (
        <>
          <SectionHeader title="Staff" />
          <Row label="Admin" onPress={() => router.push('/admin')} />
        </>
      ) : null}

      {env.debugAi ? (
        <>
          <SectionHeader title="Developer" />
          <Row label="AI debug" onPress={() => router.push('/debug/ai')} />
        </>
      ) : null}

      <Divider />

      <Button title="Sign out" variant="danger" onPress={() => void signOut()} />

      <Caption style={styles.footer}>
        Signed in as {profile?.email ?? profile?.username ?? '—'}
      </Caption>
    </Screen>
  );
}

function Row({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.flex} />
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
  },
  rowPressed: { backgroundColor: colors.surfacePressed },
  rowLabel: { ...typography.body, color: colors.text },
  chevron: { ...typography.heading, color: colors.textTertiary },
  footer: { textAlign: 'center', marginTop: spacing.xl },
});
