import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { decideEventClaim, listEventClaims } from '@/api/admin';
import { messageFor } from '@/lib/errors';
import { openExternal } from '@/lib/external';
import { formatEventDate, formatRelative } from '@/lib/format';
import {
  Badge, Body, Button, Caption, EmptyState, LoadingState, Notice, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Organizers claiming events BLUP typed in for them.
 *
 * Approving hands the event over and clears the "added by BLUP" attribution, so
 * it is a real transfer of something somebody will then sell tickets under.
 * Check the source link against who is asking before pressing it.
 */
export default function AdminClaimsScreen() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const claims = useQuery({
    queryKey: ['admin', 'claims'],
    queryFn: () => listEventClaims('pending'),
  });

  const decide = async (id: string, approve: boolean) => {
    setError(null);
    setBusy(id);
    try {
      await decideEventClaim(id, approve, approve ? null : 'Nepodarilo sa overiť');
      await queryClient.invalidateQueries({ queryKey: ['admin', 'claims'] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  if (claims.isLoading) return <Screen><LoadingState /></Screen>;

  if ((claims.data ?? []).length === 0) {
    return (
      <Screen>
        <EmptyState
          emoji="🪪"
          title="Žiadne nároky"
          body="Keď sa organizátor prihlási o event, ktorý sme pridali my, objaví sa tu."
        />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Nepodarilo sa rozhodnúť" body={error} /> : null}

      <SectionHeader title="Nároky na eventy" />
      <Body muted>
        Schválením event prejde pod danú organizáciu a prestane byť označený ako
        pridaný BLUPom. Over si zdroj — pod týmto eventom bude niekto predávať
        vstupenky.
      </Body>

      {(claims.data ?? []).map((claim) => {
        const event = (claim as unknown as {
          event?: { title: string; start_at: string; external_organizer_name: string | null; external_source_url: string | null };
        }).event;
        const organization = (claim as unknown as {
          organization?: { name: string; slug: string; verification_status: string };
        }).organization;

        return (
          <View key={claim.id} style={styles.card}>
            <View style={styles.headerRow}>
              <Text style={styles.title} numberOfLines={2}>{event?.title ?? 'Event'}</Text>
              <Badge
                tone={organization?.verification_status === 'verified' ? 'success' : 'warning'}
                label={organization?.verification_status === 'verified' ? 'Overená' : 'Neoverená'}
              />
            </View>

            {event?.start_at ? <Caption>{formatEventDate(event.start_at)}</Caption> : null}
            <Caption>Uvedený organizátor: {event?.external_organizer_name ?? '—'}</Caption>
            <Caption>Hlási sa: {organization?.name ?? 'organizácia'}</Caption>
            {claim.note ? <Caption>„{claim.note}“</Caption> : null}
            <Caption>Podané {formatRelative(claim.created_at)}</Caption>

            {event?.external_source_url ? (
              <Button
                title="Otvoriť zdroj"
                variant="ghost"
                compact
                onPress={() => void openExternal(event.external_source_url!)}
              />
            ) : null}

            <View style={styles.actions}>
              <Button
                title="Prideliť"
                loading={busy === claim.id}
                onPress={() => void decide(claim.id, true)}
              />
              <Button
                title="Zamietnuť"
                variant="secondary"
                disabled={busy === claim.id}
                onPress={() => void decide(claim.id, false)}
              />
            </View>
          </View>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.xs,
  },
  headerRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    justifyContent: 'space-between', gap: spacing.sm,
  },
  title: { ...typography.subheading, color: colors.text, flex: 1, minWidth: 0 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
});
