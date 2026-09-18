import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import {
  getPlanQueue, setPlanRequest, PLAN_STATUS_LABEL, type PlanRequestStatus,
} from '@/api/venuePlans';
import { messageFor } from '@/lib/errors';
import { formatEventDateLong, formatRelative } from '@/lib/format';
import { useDialog } from '@/components/Dialog';
import {
  Badge, Body, Button, Caption, EmptyState, ErrorState, LoadingState, Notice, Screen,
  SectionHeader, Segmented,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Žiadosti o plán sály.
 *
 * Seating plans are ours to draw, which means this queue is a promise: on the
 * other end of every row is an organizer whose event cannot go on sale the way
 * they want it to until somebody here opens the editor. So the list is ordered
 * by when the event is, not by when the request came in — a request for
 * Saturday outranks one for November however long it has been sitting.
 */
const FILTERS: { value: PlanRequestStatus | 'all'; label: string }[] = [
  { value: 'open', label: 'Nové' },
  { value: 'in_progress', label: 'Kreslím' },
  { value: 'all', label: 'Všetky' },
];

export default function AdminVenuesScreen() {
  const dialog = useDialog();
  const [filter, setFilter] = useState<PlanRequestStatus | 'all'>('open');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queue = useQuery({
    queryKey: ['admin', 'venue-plans', filter],
    queryFn: () => getPlanQueue(filter === 'all' ? undefined : filter),
  });

  if (queue.isLoading) return <Screen><LoadingState /></Screen>;
  if (queue.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(queue.error)} onRetry={() => void queue.refetch()} />
      </Screen>
    );
  }

  const move = async (id: string, status: PlanRequestStatus, ask: boolean) => {
    setError(null);

    let note: string | null = null;
    if (ask) {
      note = await dialog.prompt({
        title: status === 'rejected' ? 'Prečo nie?' : 'Odkaz organizátorovi',
        body: status === 'rejected'
          ? 'Toto uvidí organizátor. Napíš, čo by museli doplniť, alebo prečo to nejde.'
          : 'Uvidí to organizátor spolu s oznámením, že je hotovo.',
        placeholder: status === 'rejected' ? 'Napr. Potrebujeme plán sály ako obrázok.' : 'Hotovo, pozri sa.',
        multiline: true,
        required: status === 'rejected',
      });
      if (note === null) return;
    }

    setBusy(true);
    try {
      await setPlanRequest(id, status, note ?? undefined);
      await queue.refetch();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const rows = queue.data ?? [];

  return (
    <Screen scroll>
      <Text style={styles.title}>Plány sál</Text>
      <Body muted style={styles.intro}>
        Zoradené podľa toho, kedy je event — nie podľa toho, kedy prišla žiadosť.
        Na druhom konci každého riadku je niekto, kto zatiaľ nemôže spustiť predaj.
      </Body>

      {error ? <Notice tone="danger" title="Nedá sa" body={error} /> : null}

      <Segmented options={FILTERS} value={filter} onChange={setFilter} style={styles.filters} />

      {rows.length === 0 ? (
        <EmptyState
          emoji="🪑"
          title={filter === 'open' ? 'Nič nové' : 'Nič tu nie je'}
          body="Keď niekto požiada o plán sály, objaví sa tu."
        />
      ) : null}

      {rows.map((row) => (
        <View key={row.id} style={styles.card}>
          <View style={styles.head}>
            <View style={styles.flex}>
              <Text style={styles.name}>{row.event_title}</Text>
              <Caption>{formatEventDateLong(row.start_at)}</Caption>
              <Caption>
                {[row.organization, row.requested_by].filter(Boolean).join(' · ')}
                {` · požiadané ${formatRelative(row.created_at)}`}
              </Caption>
            </View>
            <Badge
              label={PLAN_STATUS_LABEL[row.status].toUpperCase()}
              tone={
                row.status === 'done' ? 'success'
                  : row.status === 'rejected' ? 'danger'
                    : row.status === 'in_progress' ? 'teal'
                      : 'warning'
              }
            />
          </View>

          <Body style={styles.note}>{row.note}</Body>

          {row.admin_note ? <Caption>Naša poznámka: {row.admin_note}</Caption> : null}

          {/* The one fact that says whether this is really finished. A request
              marked done on an event with no plan on it is the failure mode
              this whole queue exists to prevent. */}
          <Caption style={row.has_plan ? styles.ok : styles.missing}>
            {row.has_plan ? 'Event už plán má.' : 'Event zatiaľ plán nemá.'}
          </Caption>

          <View style={styles.actions}>
            <Button
              title="Otvoriť editor"
              variant="secondary"
              compact
              onPress={() => router.push(`/organizer/plan/${row.event_id}`)}
            />
            {row.status === 'open' ? (
              <Button title="Beriem si to" variant="secondary" compact disabled={busy}
                      onPress={() => move(row.id, 'in_progress', false)} />
            ) : null}
            {row.status !== 'done' ? (
              <Button title="Hotovo" compact disabled={busy}
                      onPress={() => move(row.id, 'done', true)} />
            ) : null}
            {row.status !== 'rejected' ? (
              <Button title="Nejde" variant="ghost" compact disabled={busy}
                      onPress={() => move(row.id, 'rejected', true)} />
            ) : null}
          </View>
        </View>
      ))}

      <SectionHeader title="Prečo to robíme my" />
      <Caption>
        Sektor o pár pixelov vedľa predá iné miesto, než na ktoré sa kupujúci pozeral.
        Sektor napojený na zlý typ vstupenky predá inú cenu. A prekreslenie tribúny
        počas predaja vedelo zmazať miesto z už zaplatených vstupeniek — to už databáza
        odmieta, ale zvyšok je stále presná práca s plánom sály otvoreným vedľa.
      </Caption>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text },
  intro: { marginTop: spacing.xs, marginBottom: spacing.lg },
  flex: { flex: 1, minWidth: 0 },
  filters: { marginBottom: spacing.md },

  card: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
    gap: spacing.xs,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  name: { ...typography.bodyStrong, color: colors.text },
  note: { marginTop: spacing.xs },
  ok: { color: colors.success },
  missing: { color: colors.warning },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
});
