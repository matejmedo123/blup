import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { listReports, resolveReport, setEventStatus } from '@/api/admin';
import { messageFor } from '@/lib/errors';
import { formatRelative } from '@/lib/format';
import {
  Badge, Body, Button, Caption, EmptyState, LoadingState, Notice, Screen,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

export default function AdminReportsScreen() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reports = useQuery({ queryKey: ['admin', 'reports'], queryFn: () => listReports('open') });

  const resolve = async (id: string, status: 'actioned' | 'dismissed', targetType?: string, targetId?: string) => {
    setError(null);
    setBusy(id);
    try {
      // Actioning a reported event also takes it down.
      if (status === 'actioned' && targetType === 'event' && targetId) {
        await setEventStatus(targetId, 'cancelled', 'Odstránené po nahlásení');
      }
      await resolveReport(id, status);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'reports'] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  if (reports.isLoading) return <Screen><LoadingState /></Screen>;

  if ((reports.data ?? []).length === 0) {
    return (
      <Screen>
        <EmptyState emoji="🛡️" title="Žiadne nahlásenia" body="Momentálne nie sú otvorené žiadne nahlásenia." />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Nepodarilo sa vyriešiť" body={error} /> : null}

      {(reports.data ?? []).map((report) => (
        <View key={report.id as string} style={styles.card}>
          <View style={styles.headerRow}>
            <Badge tone="warning" label={String(report.target_type)} />
            <Caption>{formatRelative(report.created_at as string)}</Caption>
          </View>

          <Text style={styles.reason}>{String(report.reason)}</Text>
          {report.details ? <Body muted>{String(report.details)}</Body> : null}

          <Button
            title="Otvoriť nahlásený obsah"
            variant="ghost"
            compact
            onPress={() => {
              const type = String(report.target_type);
              const id = String(report.target_id);
              if (type === 'event') router.push(`/event/${id}`);
              else if (type === 'user') router.push(`/user/${id}`);
            }}
          />

          <View style={styles.actions}>
            <Button
              title="Stiahnuť"
              variant="danger"
              loading={busy === report.id}
              onPress={() =>
                resolve(report.id as string, 'actioned', String(report.target_type), String(report.target_id))
              }
              style={styles.flex}
            />
            <Button
              title="Zamietnuť"
              variant="secondary"
              disabled={busy !== null}
              onPress={() => resolve(report.id as string, 'dismissed')}
              style={styles.flex}
            />
          </View>
        </View>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    gap: spacing.sm,
  },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  reason: { ...typography.bodyStrong, color: colors.text },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
});
