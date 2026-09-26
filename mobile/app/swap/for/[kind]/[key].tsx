import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { swapEventsFor, type SwapEvent, type SwapHitKind } from '@/api/swap';
import { Caption, EmptyState, LoadingState, Screen } from '@/components/ui';
import { useLayout, CONTENT_MAX } from '@/hooks/useLayout';
import { formatEventDate, formatMoney } from '@/lib/format';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Ponuky za jedným interpretom, mestom alebo miestom.
 *
 * Vlastná obrazovka SWAPu a nie `/browse` z BLUPu: tam sa ukazujú všetky
 * eventy, tu len tie, na ktoré niekto naozaj niečo ponúka. Karta preto nesie
 * cenu a počet vstupeniek, nie vzdialenosť a to, kto z tvojich kruhov ide —
 * to sú otázky BLUPu, nie SWAPu.
 */
export default function SwapForScreen() {
  const params = useLocalSearchParams<{ kind: string; key: string }>();
  const kind = (params.kind ?? 'city') as SwapHitKind;
  const key = decodeURIComponent(params.key ?? '');
  const layout = useLayout();

  const events = useQuery({
    queryKey: ['swap', 'for', kind, key],
    queryFn: () => swapEventsFor(kind, key, 60),
    enabled: Boolean(key),
  });

  if (events.isLoading) return <Screen><LoadingState label="Načítavam ponuky…" /></Screen>;

  const rows = events.data ?? [];
  const total = rows.reduce((sum, row) => sum + row.ticket_count, 0);

  return (
    <Screen scroll={false}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={2}>{key}</Text>
        <Caption>
          {rows.length === 0
            ? 'Zatiaľ nič v ponuke'
            : `${total} ${total === 1 ? 'vstupenka' : total < 5 ? 'vstupenky' : 'vstupeniek'} `
              + `na ${rows.length} ${rows.length === 1 ? 'evente' : 'eventoch'}`}
        </Caption>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(item) => item.event_id}
        numColumns={layout.columns}
        key={`cols-${layout.columns}`}
        columnWrapperStyle={layout.columns > 1 ? styles.columns : undefined}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <EmptyState
            emoji="🎟"
            title="Nič v ponuke"
            body="Na toto momentálne nikto nič nepredáva."
          />
        }
        renderItem={({ item }) => (
          <View style={layout.columns > 1 ? styles.cell : undefined}>
            <EventRow event={item} />
          </View>
        )}
      />
    </Screen>
  );
}

function EventRow({ event }: { event: SwapEvent }) {
  return (
    <Pressable
      style={styles.card}
      accessibilityRole="button"
      onPress={() => router.push(`/swap/${event.event_id}`)}
    >
      {event.cover_image_url ? (
        <Image source={{ uri: event.cover_image_url }} style={styles.cover} contentFit="cover" />
      ) : (
        <View style={[styles.cover, styles.coverEmpty]} />
      )}

      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>{event.title}</Text>
        <Caption numberOfLines={1}>
          {[formatEventDate(event.start_at), event.venue_name, event.city]
            .filter(Boolean).join(' · ')}
        </Caption>

        <View style={styles.numbers}>
          <Text style={styles.price}>
            {event.from_cents != null
              ? `od ${formatMoney(event.from_cents, event.currency ?? 'EUR')}`
              : '—'}
          </Text>
          <Caption>
            {event.ticket_count === 1 ? '1 vstupenka' : `${event.ticket_count} vstupeniek`}
            {event.verified_count > 0 ? ` · ${event.verified_count} overených` : ''}
          </Caption>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: 2,
    maxWidth: CONTENT_MAX, width: '100%', alignSelf: 'center',
  },
  title: { ...typography.heading, color: colors.text },
  list: {
    paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm,
    maxWidth: CONTENT_MAX, width: '100%', alignSelf: 'center',
  },
  columns: { gap: spacing.sm },
  cell: { flex: 1 },

  card: {
    borderRadius: radius.card, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface, overflow: 'hidden',
  },
  cover: { width: '100%', height: 110, backgroundColor: colors.surfaceElevated },
  coverEmpty: {},
  body: { padding: spacing.md, gap: 2 },
  name: { ...typography.bodyStrong, color: colors.text },
  numbers: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, marginTop: spacing.xs },
  price: { ...typography.subheading, color: colors.text },
});
