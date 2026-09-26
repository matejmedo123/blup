import React from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { eventsMatching, type SearchHitKind } from '@/api/events';
import { getEventResaleSummary } from '@/api/resale';
import { EventCard } from '@/components/EventCard';
import {
  Button, Caption, EmptyState, LoadingState, Screen,
} from '@/components/ui';
import { useLayout, CARD_MAX } from '@/hooks/useLayout';
import { formatMoney } from '@/lib/format';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Všetko od jedného interpreta, v jednom meste alebo na jednom mieste.
 *
 * Kam vedie kliknutie vo výsledkoch hľadania. Bez tejto obrazovky by hľadanie
 * „Don Toliver" skončilo zoznamom, v ktorom treba hľadať znova.
 *
 * Hore je zhrnutie burzy, keď je na čo pozerať: pri vypredanom koncerte je
 * ďalší predaj jediná cesta dnu a je to prvé, čo človek chce vedieť.
 */
const TITLE: Record<SearchHitKind, (key: string) => string> = {
  artist: (key) => key,
  city: (key) => `Čo sa deje v meste ${key}`,
  venue: (key) => key,
  event: (key) => key,
};

const SUBTITLE: Record<SearchHitKind, string> = {
  artist: 'Všetky termíny',
  city: 'Nadchádzajúce eventy',
  venue: 'Nadchádzajúce eventy',
  event: '',
};

export default function BrowseScreen() {
  const params = useLocalSearchParams<{ kind: string; key: string }>();
  const kind = (params.kind ?? 'city') as SearchHitKind;
  const key = decodeURIComponent(params.key ?? '');
  const layout = useLayout();

  const events = useQuery({
    queryKey: ['browse', kind, key],
    queryFn: () => eventsMatching(kind, key, 60),
    enabled: Boolean(key),
  });

  if (events.isLoading) return <Screen><LoadingState label="Načítavam…" /></Screen>;

  const rows = events.data ?? [];

  return (
    <Screen scroll={false}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={2}>{TITLE[kind](key)}</Text>
        <Caption>
          {SUBTITLE[kind]}
          {rows.length > 0 ? ` · ${rows.length}` : ''}
        </Caption>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        numColumns={layout.columns}
        // `key` musí prejsť zmenou, keď sa zmení počet stĺpcov — FlatList to
        // inak odmietne prepnúť a zoznam zostane v starom rozložení.
        key={`cols-${layout.columns}`}
        columnWrapperStyle={layout.columns > 1 ? styles.columns : undefined}
        contentContainerStyle={[
          styles.list,
          layout.columns === 1 && { maxWidth: CARD_MAX, alignSelf: 'center', width: '100%' },
        ]}
        ListEmptyComponent={
          <EmptyState
            emoji="🔍"
            title="Nič sa nenašlo"
            body="Skús iné meno alebo mesto."
            actionLabel="Späť na hľadanie"
            onAction={() => router.replace('/search')}
          />
        }
        renderItem={({ item }) => (
          <View style={layout.columns > 1 ? styles.cell : undefined}>
            <EventCard event={item} onPress={() => router.push(`/event/${item.id}`)} />
            <ResaleLine eventId={item.id} />
          </View>
        )}
      />
    </Screen>
  );
}

/**
 * Riadok o burze pod kartou eventu.
 *
 * Zámerne vlastný dotaz na kartu a nie jedno číslo pre celú obrazovku: pri
 * vypredanom koncerte je toto to jediné tlačidlo, ktoré niekam vedie, a musí
 * byť pri tom správnom termíne.
 */
function ResaleLine({ eventId }: { eventId: string }) {
  const summary = useQuery({
    queryKey: ['resale', 'summary', eventId],
    queryFn: () => getEventResaleSummary(eventId),
    staleTime: 60_000,
  });

  const data = summary.data;
  if (!data || data.listings === 0) return null;

  return (
    <View style={styles.resale}>
      <View style={styles.resaleText}>
        <Text style={styles.resaleTitle}>
          {data.tickets === 1
            ? '1 vstupenka na burze'
            : `${data.tickets} vstupeniek na burze`}
        </Text>
        <Caption>
          {data.from_cents != null ? `od ${formatMoney(data.from_cents, data.currency ?? 'EUR')}` : ''}
          {data.verified_count > 0 ? ` · ${data.verified_count} overených` : ''}
        </Caption>
      </View>
      <Button
        title="Pozrieť"
        variant="secondary"
        onPress={() => router.push(`/resale/${eventId}`)}
        style={styles.resaleButton}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: 2 },
  title: { ...typography.heading, color: colors.text },

  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  columns: { gap: spacing.md },
  cell: { flex: 1 },

  resale: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
    padding: spacing.sm,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSoft,
  },
  resaleText: { flex: 1 },
  resaleTitle: { ...typography.metaSm, color: colors.text, fontWeight: '700' },
  resaleButton: { minWidth: 110 },
});
