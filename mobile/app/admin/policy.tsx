import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { listDisputes, listPayoutTiers, setPayoutTier } from '@/api/admin';
import { messageFor } from '@/lib/errors';
import { formatMoney, formatRelative } from '@/lib/format';
import {
  Badge, Body, Button, Caption, Divider, EmptyState, LoadingState, Notice, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Payout policy and disputes.
 *
 * Two things live here because they are the same decision seen from two sides:
 * how long we hold an organizer's money, and what happened when holding it
 * turned out to matter. An open dispute freezes every payout for that
 * organizer — so this screen is where somebody notices that a person has
 * stopped being paid, and why.
 */
export default function AdminPolicyScreen() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const tiers = useQuery({ queryKey: ['admin', 'payout-tiers'], queryFn: listPayoutTiers });
  const disputes = useQuery({ queryKey: ['admin', 'disputes'], queryFn: () => listDisputes('all') });

  const pin = async (organizationId: string, tier: 0 | 1 | 2 | null) => {
    setError(null);
    setBusy(organizationId);
    try {
      await setPayoutTier(organizationId, tier, tier === null ? null : 'Nastavené adminom');
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  if (tiers.isLoading) return <Screen><LoadingState /></Screen>;

  const open = (disputes.data ?? []).filter((d) => d.status === 'open');
  const closed = (disputes.data ?? []).filter((d) => d.status !== 'open');

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Nepodarilo sa uložiť" body={error} /> : null}

      <SectionHeader title="Úrovne výplat" />
      <Body muted>
        Peniaze sa uvoľňujú podľa dátumu konania podujatia, nie podľa dátumu predaja.
        Spor o „služba nebola poskytnutá“ beží 120 dní od dňa, kedy mal zákazník
        službu dostať — preto časť sumy prežíva samotnú akciu ako rezerva.
      </Body>

      {(tiers.data ?? []).map((tier) => (
        <View key={tier.tier} style={styles.card}>
          <View style={styles.headerRow}>
            <Text style={styles.title}>{tier.label}</Text>
            <Badge tone="neutral" label={`Tier ${tier.tier}`} />
          </View>
          <Row label="Hlavná výplata" value={`T+${tier.payout_delay_days} dní`} />
          <Row label="Rezerva" value={`${(tier.reserve_bps / 100).toFixed(0)} %`} />
          <Row label="Uvoľnenie rezervy" value={`T+${tier.reserve_release_days} dní`} />
          <Row
            label="Záloha pred akciou"
            value={
              tier.advance_max_bps === 0
                ? 'nie'
                : `max ${(tier.advance_max_bps / 100).toFixed(0)} %, najskôr T−${tier.advance_earliest_days}`
            }
          />
        </View>
      ))}

      <Caption>
        Hodnoty sa dajú meniť priamo v tabuľke `payout_tiers` — patria do prílohy zmluvy,
        nie do kódu, aby sa dali upraviť bez dodatku.
      </Caption>

      <SectionHeader title={`Otvorené spory${open.length ? ` (${open.length})` : ''}`} />
      {open.length === 0 ? (
        <Body muted>Žiadny otvorený spor. Nikomu nie sú pozastavené výplaty.</Body>
      ) : (
        open.map((dispute) => {
          const organization = (dispute as unknown as {
            organization?: { id: string; name: string };
          }).organization;
          const event = (dispute as unknown as { event?: { title: string } }).event;

          return (
            <View key={dispute.id} style={[styles.card, styles.alert]}>
              <View style={styles.headerRow}>
                <Text style={styles.title}>
                  {formatMoney(dispute.amount_cents, dispute.currency)}
                </Text>
                <Badge tone="danger" label="Otvorený" />
              </View>
              <Caption>{organization?.name ?? 'Organizácia'}</Caption>
              {event?.title ? <Caption>{event.title}</Caption> : null}
              {dispute.reason ? <Caption>Dôvod: {dispute.reason}</Caption> : null}
              <Caption>Otvorený {formatRelative(dispute.opened_at)}</Caption>
              <Divider />
              <Caption>
                Výplaty tejto organizácie sú pozastavené, kým banka nerozhodne.
                Spor sa uzatvára na strane Stripe — BLUP ho len zapisuje.
              </Caption>
              {organization?.id ? (
                <View style={styles.actions}>
                  <Button
                    title="Vrátiť na Tier 0"
                    variant="secondary"
                    loading={busy === organization.id}
                    onPress={() => void pin(organization.id, 0)}
                  />
                </View>
              ) : null}
            </View>
          );
        })
      )}

      {closed.length > 0 ? (
        <>
          <SectionHeader title="Uzavreté spory" />
          {closed.map((dispute) => {
            const organization = (dispute as unknown as {
              organization?: { name: string };
            }).organization;

            return (
              <View key={dispute.id} style={styles.card}>
                <View style={styles.headerRow}>
                  <Text style={styles.title}>
                    {formatMoney(dispute.amount_cents, dispute.currency)}
                  </Text>
                  <Badge
                    tone={dispute.status === 'lost' ? 'danger' : 'success'}
                    label={
                      dispute.status === 'lost' ? 'Prehratý'
                        : dispute.status === 'won' ? 'Vyhratý' : 'Stiahnutý'
                    }
                  />
                </View>
                <Caption>{organization?.name ?? 'Organizácia'}</Caption>
                <Caption>
                  {dispute.closed_at ? `Uzavretý ${formatRelative(dispute.closed_at)}` : null}
                </Caption>
              </View>
            );
          })}
        </>
      ) : null}
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Caption>{label}</Caption>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
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
  alert: { borderColor: colors.danger },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { ...typography.subheading, color: colors.text },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowValue: { ...typography.body, color: colors.text },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
});
