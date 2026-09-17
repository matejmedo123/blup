import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getSeatManifest, SEAT_KIND_LABEL, type ManifestRow, type SeatKind } from '@/api/seating';
import { messageFor } from '@/lib/errors';
import { toCsv } from '@/lib/csv';
import { saveTextFile } from '@/lib/download';
import {
  Badge, Body, Button, Caption, EmptyState, ErrorState, Input, LoadingState, Notice,
  Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Who sits where.
 *
 * The attendee list is ordered by when the ticket was bought, which is the
 * right order for almost everything and useless for the one job this screen
 * has: somebody is standing in the aisle saying "rad D, štrnástka", and the
 * person with the tablet has to find them. So this list is walked the way the
 * room is — sector, row, seat — with the empty seats left in, because an empty
 * seat is information too: it is the one the latecomer can be put in.
 */
export default function SeatingManifestScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [search, setSearch] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const manifest = useQuery({
    queryKey: ['event', id, 'manifest'],
    queryFn: () => getSeatManifest(id!),
    enabled: Boolean(id),
  });

  const needle = search.trim().toLowerCase();
  const rows = useMemo(() => {
    const all = manifest.data ?? [];
    if (!needle) return all;
    const flat = needle.replace(/[^a-z0-9]+/g, '');
    return all.filter((row) => (
      (row.holder_name ?? '').toLowerCase().includes(needle)
      || (row.code ?? '').toLowerCase().includes(needle)
      || `${row.row_label}${row.seat_number}`.toLowerCase().includes(flat)
      || row.section.toLowerCase().includes(needle)
    ));
  }, [manifest.data, needle]);

  const sold = (manifest.data ?? []).filter((row) => row.code).length;
  const total = (manifest.data ?? []).length;

  const exportCsv = async () => {
    setError(null);
    setNote(null);
    try {
      const csv = toCsv(
        [
          { key: 'section', label: 'Sektor' },
          { key: 'row_label', label: 'Rad' },
          { key: 'seat_number', label: 'Miesto' },
          { key: 'kind', label: 'Typ miesta' },
          { key: 'seat_note', label: 'Poznámka' },
          { key: 'holder_name', label: 'Meno' },
          { key: 'code', label: 'Kód vstupenky' },
          { key: 'status', label: 'Stav' },
          { key: 'checked_in_at', label: 'Odbavená' },
        ],
        (manifest.data ?? []).map((row) => ({
          ...row,
          kind: SEAT_KIND_LABEL[row.kind] ?? row.kind,
          status: row.code ? row.status : 'voľné',
        })),
      );

      const saved = await saveTextFile(`blup-sedenie-${id}.csv`, csv);
      setNote(saved.shared ? 'Zoznam sedenia je uložený.' : `Uložené: ${saved.uri}`);
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  if (manifest.isLoading) return <Screen><LoadingState label="Načítavam sedenie…" /></Screen>;
  if (manifest.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(manifest.error)} onRetry={() => void manifest.refetch()} />
      </Screen>
    );
  }

  if (total === 0) {
    return (
      <Screen>
        <EmptyState
          emoji="🪑"
          title="Tento event nemá sedenie"
          body="Vstupenky sa naň predávajú bez konkrétnych miest. Plán sály vieš pridať v úprave eventu."
          actionLabel="Plán sály"
          onAction={() => router.push(`/organizer/plan/${id}`)}
        />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Text style={styles.title}>Sedenie</Text>
      <Body muted style={styles.intro}>
        {`${sold} z ${total} miest je predaných. Zoznam je zoradený tak, ako sa prechádza sála.`}
      </Body>

      {error ? <Notice tone="danger" title="Nedá sa" body={error} /> : null}
      {note ? <Notice tone="success" title="Hotovo" body={note} /> : null}

      <Input
        value={search}
        onChangeText={setSearch}
        placeholder="Hľadaj miesto, meno alebo kód"
        autoCapitalize="none"
      />

      <Button title="Stiahnuť ako CSV" variant="secondary" onPress={exportCsv} />

      {groupBySection(rows).map(([section, inSection]) => (
        <View key={section}>
          <SectionHeader title={section} />
          {inSection.map((row) => (
            <SeatLine key={`${row.section}-${row.row_label}-${row.seat_number}`} row={row} />
          ))}
        </View>
      ))}

      {rows.length === 0 ? (
        <Caption style={styles.none}>Nič také tu nesedí.</Caption>
      ) : null}

      <Button
        title="Upraviť plán sály"
        variant="ghost"
        onPress={() => router.push(`/organizer/plan/${id}`)}
      />
    </Screen>
  );
}

function SeatLine({ row }: { row: ManifestRow }) {
  const empty = !row.code;

  // A line, not a button: there is nothing further to open from a seat, and a
  // control that navigates nowhere is worse than plain text.
  return (
    <View
      style={[styles.row, empty && styles.rowEmpty]}
      accessibilityLabel={
        `Rad ${row.row_label}, miesto ${row.seat_number}, `
        + (empty ? 'voľné' : row.holder_name ?? 'bez mena')
      }
    >
      <Text style={styles.seat}>{`${row.row_label}${row.seat_number}`}</Text>
      <View style={styles.flex}>
        <Text style={[styles.name, empty && styles.nameEmpty]}>
          {empty ? 'voľné' : row.holder_name ?? 'Bez mena'}
        </Text>
        {row.kind !== 'standard' || row.seat_note ? (
          <Caption>
            {[SEAT_KIND_LABEL[row.kind as SeatKind], row.seat_note].filter(Boolean).join(' · ')}
          </Caption>
        ) : null}
        {row.code ? <Caption>{row.code}</Caption> : null}
      </View>
      {row.checked_in_at ? <Badge label="NA MIESTE" tone="teal" /> : null}
    </View>
  );
}

/** The rows of one sector, kept in the order the database walked them. */
function groupBySection(rows: ManifestRow[]): [string, ManifestRow[]][] {
  const out: [string, ManifestRow[]][] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last[0] === row.section) last[1].push(row);
    else out.push([row.section, [row]]);
  }
  return out;
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text },
  intro: { marginTop: spacing.xs, marginBottom: spacing.lg },
  flex: { flex: 1, minWidth: 0 },
  none: { marginTop: spacing.lg, textAlign: 'center' },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    padding: spacing.md, borderRadius: radius.md,
    backgroundColor: colors.surface, marginBottom: spacing.xs,
  },
  rowEmpty: { backgroundColor: 'transparent', opacity: 0.55 },
  seat: {
    ...typography.bodyStrong, color: colors.text, minWidth: 44,
    fontVariant: ['tabular-nums'],
  },
  name: { ...typography.body, color: colors.text },
  nameEmpty: { color: colors.textSecondary, fontStyle: 'italic' },
});
