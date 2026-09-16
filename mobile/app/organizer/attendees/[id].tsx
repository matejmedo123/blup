import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getTicketHolders, getTicketSummary, setTicketActive, type TicketHolder,
} from '@/api/organizations';
import { messageFor } from '@/lib/errors';
import { formatRelative } from '@/lib/format';
import {
  Badge, Body, Button, Caption, EmptyState, ErrorState, Input, LoadingState, Notice,
  Screen, SectionHeader, Segmented,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

type Filter = 'all' | 'valid' | 'used' | 'cancelled';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Všetky' },
  { value: 'valid', label: 'Platné' },
  { value: 'used', label: 'Použité' },
  { value: 'cancelled', label: 'Neplatné' },
];

/**
 * The list behind the numbers.
 *
 * The statistics screen says how many tickets were sold; this says to whom —
 * the name on the ticket, the address it was sent to, and the code — and lets
 * whoever runs the event switch a single ticket off when it has to stop
 * working, and back on when it was a mistake.
 *
 * Switching one off is not cosmetic: the scanner refuses anything that is not
 * valid, so the person is turned away at the door.
 */
export default function AttendeesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const holders = useQuery({
    queryKey: ['attendees', id, filter],
    queryFn: () => getTicketHolders(id!, { status: filter === 'all' ? null : filter }),
    enabled: Boolean(id),
  });

  const summary = useQuery({
    queryKey: ['attendees', id, 'summary'],
    queryFn: () => getTicketSummary(id!),
    enabled: Boolean(id),
  });

  // Filtering in the browser rather than round-tripping on every keystroke; the
  // server search is there for lists too long to have been fetched whole.
  const needle = search.trim().toLowerCase();
  const rows = useMemo(() => {
    const all = holders.data ?? [];
    if (!needle) return all;
    return all.filter((row) => (
      (row.holder_name ?? '').toLowerCase().includes(needle)
      || (row.email ?? '').toLowerCase().includes(needle)
      || (row.username ?? '').toLowerCase().includes(needle)
      || row.code.toLowerCase().includes(needle)
    ));
  }, [holders.data, needle]);

  const toggle = async (row: TicketHolder, active: boolean) => {
    setError(null);
    setBusy(row.ticket_id);
    try {
      await setTicketActive(row.ticket_id, active, active ? null : reason);
      setConfirming(null);
      setReason('');
      await queryClient.invalidateQueries({ queryKey: ['attendees', id] });
      await queryClient.invalidateQueries({ queryKey: ['analytics', id] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  if (holders.isLoading) return <Screen><LoadingState /></Screen>;

  if (holders.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(holders.error)} onRetry={() => void holders.refetch()} />
      </Screen>
    );
  }

  const stats = summary.data;

  return (
    <Screen scroll>
      <SectionHeader title="Kto príde" />
      <Caption style={styles.intro}>
        Meno, adresa, na ktorú vstupenka odišla, a kód. Vidíš to len ty a tvoj tím.
      </Caption>

      {stats ? (
        <View style={styles.tiles}>
          <Tile label="Vstupeniek" value={stats.total} />
          <Tile label="Platných" value={stats.valid} />
          <Tile label="Použitých" value={stats.used} />
          <Tile label="Neplatných" value={stats.cancelled} />
        </View>
      ) : null}

      {error ? <Notice tone="danger" title="Nepodarilo sa" body={error} /> : null}

      <Input
        placeholder="Hľadaj meno, e-mail alebo kód"
        value={search}
        onChangeText={setSearch}
        autoCapitalize="none"
      />
      <Segmented options={FILTERS} value={filter} onChange={setFilter} style={styles.filters} />

      {rows.length === 0 ? (
        <EmptyState
          emoji="🎟️"
          title={needle ? 'Nič sa nenašlo' : 'Zatiaľ žiadne vstupenky'}
          body={
            needle
              ? 'Skús iné meno, e-mail alebo kód.'
              : 'Keď niekto kúpi alebo dostane vstupenku, objaví sa tu s menom aj kódom.'
          }
        />
      ) : (
        rows.map((row) => {
          const off = row.status === 'cancelled';
          const refunded = row.status === 'refunded';
          return (
            <View key={row.ticket_id} style={styles.row}>
              <View style={styles.rowHead}>
                <View style={styles.flex}>
                  <Text style={styles.name}>{row.holder_name ?? 'Bez mena'}</Text>
                  {row.email ? <Caption>{row.email}</Caption> : null}
                </View>
                <Badge
                  label={
                    row.status === 'valid' ? 'PLATNÁ'
                      : row.status === 'used' ? 'POUŽITÁ'
                      : row.status === 'refunded' ? 'VRÁTENÁ'
                      : 'NEPLATNÁ'
                  }
                  tone={
                    row.status === 'valid' ? 'success'
                      : row.status === 'used' ? 'teal'
                      : row.status === 'refunded' ? 'warning'
                      : 'danger'
                  }
                />
              </View>

              <View style={styles.metaRow}>
                <Text style={styles.code}>{row.code}</Text>
                {row.ticket_type ? <Caption>{row.ticket_type}</Caption> : null}
                {row.is_complimentary ? <Badge label="ZDARMA" tone="accent" /> : null}
                {row.is_guest ? <Badge label="HOSŤ" tone="neutral" /> : null}
              </View>

              {row.checked_in_at ? (
                <Caption>Odbavená {formatRelative(row.checked_in_at)}</Caption>
              ) : null}
              {off && row.deactivation_reason ? (
                <Caption>Dôvod: {row.deactivation_reason}</Caption>
              ) : null}

              {refunded ? (
                <Caption>Vrátená platba — znovu aktivovať sa nedá.</Caption>
              ) : confirming === row.ticket_id ? (
                <View style={styles.confirm}>
                  <Body>Vstupenka prestane platiť a pri vstupe neprejde.</Body>
                  <Input
                    placeholder="Dôvod (uvidí ho aj držiteľ)"
                    value={reason}
                    onChangeText={setReason}
                  />
                  <View style={styles.actions}>
                    <Button
                      title="Deaktivovať"
                      variant="danger"
                      loading={busy === row.ticket_id}
                      onPress={() => void toggle(row, false)}
                      style={styles.flex}
                    />
                    <Button
                      title="Späť"
                      variant="ghost"
                      onPress={() => { setConfirming(null); setReason(''); }}
                      style={styles.flex}
                    />
                  </View>
                </View>
              ) : off ? (
                <Button
                  title="Aktivovať"
                  variant="secondary"
                  loading={busy === row.ticket_id}
                  onPress={() => void toggle(row, true)}
                />
              ) : (
                <Pressable
                  onPress={() => { setConfirming(row.ticket_id); setReason(''); }}
                  accessibilityRole="button"
                >
                  <Text style={styles.deactivate}>Deaktivovať vstupenku</Text>
                </Pressable>
              )}
            </View>
          );
        })
      )}
    </Screen>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileValue}>{value}</Text>
      <Caption>{label}</Caption>
    </View>
  );
}

const styles = StyleSheet.create({
  // minWidth 0 so a long name can shrink inside a row instead of pushing the
  // badge out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },

  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
  tile: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 76,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 2,
  },
  tileValue: { ...typography.heading, color: colors.text },

  filters: { marginBottom: spacing.md },

  row: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  rowHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  name: { ...typography.bodyStrong, color: colors.text },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  code: { ...typography.monoStrong, color: colors.textSecondary },
  intro: { marginBottom: spacing.md },

  confirm: { gap: spacing.sm, marginTop: spacing.xs },
  actions: { flexDirection: 'row', gap: spacing.sm },
  deactivate: { ...typography.caption, color: colors.danger },
});
