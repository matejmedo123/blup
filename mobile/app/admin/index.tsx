import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getPlatformStats } from '@/api/admin';
import { messageFor } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import { Caption, ErrorState, LoadingState, Screen, SectionHeader } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

export default function AdminDashboard() {
  const stats = useQuery({ queryKey: ['admin', 'stats'], queryFn: getPlatformStats });

  if (stats.isLoading) return <Screen><LoadingState /></Screen>;

  if (stats.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(stats.error)} onRetry={() => void stats.refetch()} />
      </Screen>
    );
  }

  const data = stats.data!;

  return (
    <Screen scroll>
      <SectionHeader title="Platforma" />
      <View style={styles.grid}>
        <Tile label="Používatelia" value={String(data.users)} />
        <Tile label="Eventy" value={String(data.events)} />
        <Tile label="Organizácie" value={String(data.organizations)} />
        <Tile label="Vstupenky" value={String(data.tickets)} />
        <Tile label="Premium používatelia" value={String(data.premium_users)} />
        <Tile label="Pozastavení" value={String(data.suspended_users)} />
      </View>

      <SectionHeader title="Tržby" />
      <View style={styles.grid}>
        <Tile label="Hrubý predaj" value={formatMoney(data.gross_sales_cents)} />
        <Tile label="Príjem BLUPu" value={formatMoney(data.platform_revenue_cents)} />
      </View>

      <SectionHeader title="Fronty" />
      <Row
        label="Žiadosti o overenie"
        badge={data.pending_verifications}
        onPress={() => router.push('/admin/verifications')}
      />
      <Row label="Otvorené nahlásenia" badge={data.open_reports} onPress={() => router.push('/admin/reports')} />
      <Row label="Čakajúce výplaty" badge={data.pending_payouts} onPress={() => router.push('/admin/payouts')} />
      <Row label="Používatelia" onPress={() => router.push('/admin/users')} />
    </Screen>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileValue}>{value}</Text>
      <Caption>{label}</Caption>
    </View>
  );
}

function Row({ label, badge, onPress }: { label: string; badge?: number; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.flex} />
      {badge !== undefined && badge > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : null}
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  tile: {
    flexGrow: 1,
    minWidth: '45%',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: 2,
  },
  tileValue: { ...typography.title, color: colors.text },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
  },
  rowPressed: { backgroundColor: colors.surfacePressed },
  rowLabel: { ...typography.body, color: colors.text },
  badge: {
    minWidth: 24,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 12,
    backgroundColor: colors.accent,
    alignItems: 'center',
  },
  badgeText: { ...typography.label, color: colors.textInverse },
  chevron: { ...typography.heading, color: colors.textTertiary },
});
