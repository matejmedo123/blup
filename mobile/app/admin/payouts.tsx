import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { listPayouts, updatePayoutStatus } from '@/api/admin';
import { messageFor } from '@/lib/errors';
import { formatMoney, formatRelative } from '@/lib/format';
import {
  Badge, Button, Caption, EmptyState, LoadingState, Notice, Screen,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Payout queue. Marking one failed writes a reversing ledger entry, so the
 * organizer's balance always reflects reality.
 */
export default function AdminPayoutsScreen() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const payouts = useQuery({ queryKey: ['admin', 'payouts'], queryFn: () => listPayouts() });

  const update = async (id: string, status: 'paid' | 'failed') => {
    setError(null);
    setBusy(id);
    try {
      await updatePayoutStatus(id, status, {
        failureReason: status === 'failed' ? 'Označené adminom ako zlyhané' : undefined,
      });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'payouts'] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  if (payouts.isLoading) return <Screen><LoadingState /></Screen>;

  if ((payouts.data ?? []).length === 0) {
    return (
      <Screen>
        <EmptyState emoji="💸" title="Žiadne výplaty" body="Zatiaľ nikto o nič nepožiadal." />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Nepodarilo sa upraviť" body={error} /> : null}

      {(payouts.data ?? []).map((payout) => {
        const organization = payout.organization as { name?: string } | null;
        const status = String(payout.status);

        return (
          <View key={payout.id as string} style={styles.card}>
            <View style={styles.headerRow}>
              <Text style={styles.amount}>
                {formatMoney(payout.amount_cents as number, payout.currency as string)}
              </Text>
              <Badge
                tone={status === 'paid' ? 'success' : status === 'failed' ? 'danger' : 'warning'}
                label={status}
              />
            </View>

            <Caption>{organization?.name ?? 'Organizácia'}</Caption>
            <Caption>Requested {formatRelative(payout.requested_at as string)}</Caption>
            {payout.provider_transfer_id ? (
              <Caption>Transfer {String(payout.provider_transfer_id)}</Caption>
            ) : null}

            {status === 'pending' || status === 'processing' ? (
              <View style={styles.actions}>
                <Button
                  title="Označiť ako vyplatené"
                  loading={busy === payout.id}
                  onPress={() => update(payout.id as string, 'paid')}
                  style={styles.flex}
                />
                <Button
                  title="Označiť ako zlyhané"
                  variant="danger"
                  disabled={busy !== null}
                  onPress={() => update(payout.id as string, 'failed')}
                  style={styles.flex}
                />
              </View>
            ) : null}
          </View>
        );
      })}
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
    gap: spacing.xs,
  },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  amount: { ...typography.subheading, color: colors.text },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
});
