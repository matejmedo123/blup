import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { listVerificationRequests, reviewOrganization } from '@/api/admin';
import { messageFor } from '@/lib/errors';
import { formatRelative } from '@/lib/format';
import {
  Body, Button, Caption, EmptyState, ErrorState, LoadingState, Notice, Screen,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/** Verification queue — approving here is what unlocks ticket selling. */
export default function AdminVerificationsScreen() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requests = useQuery({
    queryKey: ['admin', 'verifications'],
    queryFn: () => listVerificationRequests('pending'),
  });

  const review = async (id: string, approve: boolean) => {
    setError(null);
    setBusy(id);
    try {
      await reviewOrganization(id, approve);
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  if (requests.isLoading) return <Screen><LoadingState /></Screen>;

  if (requests.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(requests.error)} onRetry={() => void requests.refetch()} />
      </Screen>
    );
  }

  if ((requests.data ?? []).length === 0) {
    return (
      <Screen>
        <EmptyState emoji="✅" title="Fronta je prázdna" body="Žiadna organizácia nečaká na posúdenie." />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Nepodarilo sa posúdiť" body={error} /> : null}

      {(requests.data ?? []).map((request) => {
        const organization = request.organization as { name?: string; slug?: string } | null;

        return (
          <View key={request.id as string} style={styles.card}>
            <Text style={styles.name}>{organization?.name ?? 'Organizácia'}</Text>
            <Caption>@{organization?.slug}</Caption>

            <View style={styles.details}>
              <Detail label="Právny názov" value={String(request.legal_name)} />
              <Detail label="IČO" value={String(request.registration_number ?? '—')} />
              <Detail label="IČ DPH" value={String(request.vat_number ?? '—')} />
              <Detail label="Kontakt" value={String(request.contact_email)} />
              <Detail label="Adresa" value={String(request.address ?? '—')} />
              <Detail label="Odoslané" value={formatRelative(request.created_at as string)} />
            </View>

            <View style={styles.actions}>
              <Button
                title="Schváliť"
                onPress={() => review(request.id as string, true)}
                loading={busy === request.id}
                style={styles.flex}
              />
              <Button
                title="Zamietnuť"
                variant="danger"
                onPress={() => review(request.id as string, false)}
                disabled={busy !== null}
                style={styles.flex}
              />
            </View>
          </View>
        );
      })}
    </Screen>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Caption>{label}</Caption>
      <Body style={styles.flex}>{value}</Body>
    </View>
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
  name: { ...typography.subheading, color: colors.text },
  details: { marginVertical: spacing.md, gap: spacing.sm },
  detailRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  actions: { flexDirection: 'row', gap: spacing.sm },
});
