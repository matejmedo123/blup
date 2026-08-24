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
      <SectionHeader title="Účet" />
      <Row label="Upraviť profil" onPress={() => router.push('/settings/profile')} />
      <Row label="Záujmy" onPress={() => router.push('/settings/interests')} />
      <Row label="Súkromie" onPress={() => router.push('/settings/privacy')} />
      <Row label="Notifikácie" onPress={() => router.push('/settings/notifications')} />

      <SectionHeader title="Tvoje veci" />
      <Row label="Uložené eventy" onPress={() => router.push('/settings/saved')} />
      <Row label="Idem na" onPress={() => router.push('/settings/attending')} />
      <Row label="Vstupenky" onPress={() => router.push('/tickets')} />
      <Row label="BLUP Premium" onPress={() => router.push('/premium')} />

      <SectionHeader title="Organizovanie" />
      <Row label="Nástenka organizátora" onPress={() => router.push('/organizer')} />

      {isAdmin ? (
        <>
          <SectionHeader title="Správa" />
          <Row label="Admin" onPress={() => router.push('/admin')} />
        </>
      ) : null}

      {env.debugAi ? (
        <>
          <SectionHeader title="Vývojár" />
          <Row label="AI debug" onPress={() => router.push('/debug/ai')} />
        </>
      ) : null}

      <Divider />

      <Button title="Odhlásiť sa" variant="danger" onPress={() => void signOut()} />

      <Caption style={styles.footer}>
        Prihlásený ako {profile?.email ?? profile?.username ?? '—'}
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
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
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
