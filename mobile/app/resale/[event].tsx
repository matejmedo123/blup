import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import {
  getEventResaleListings, getEventResaleSummary,
  type ResaleListing, type ResaleSort, type ResaleSource,
} from '@/api/resale';
import { getEvent } from '@/api/events';
import { AuthenticityBadge } from '@/components/AuthenticityBadge';
import {
  Avatar, Caption, EmptyState, ErrorState, LoadingState, Screen,
} from '@/components/ui';
import { useLayout, CONTENT_MAX } from '@/hooks/useLayout';
import { formatEventDate, formatMoney } from '@/lib/format';
import { colors, radius, shadow, spacing, typography } from '@/theme';

/**
 * Burza vstupeniek na jeden event.
 *
 * Ponuky od ľudí, ktorí na event nemôžu ísť. Dve veci, na ktorých obrazovka
 * stojí:
 *
 *   Cena je vidno celá. Pri každej ponuke je to, čo pýta predajca, a pod ňou
 *   pôvodná cena, ak ju poznáme. Poplatok sa doráta v checkoute a je tam
 *   rozpísaný zvlášť — človek musí vedieť, čo naozaj zaplatí, skôr než klikne.
 *
 *   Štítok pravosti je pri každej ponuke a berie sa zo servera. „Overená" smie
 *   byť len tam, kde vstupenku vydal BLUP a vieme ju previesť; všade inde je
 *   „chránená platba", čo je poctivejšie a menej.
 */
const SORTS: { key: ResaleSort; label: string }[] = [
  { key: 'price_asc', label: 'Najlacnejšie' },
  { key: 'price_desc', label: 'Najdrahšie' },
  { key: 'newest', label: 'Najnovšie' },
];

const SOURCES: { key: ResaleSource | null; label: string }[] = [
  { key: null, label: 'Všetky' },
  { key: 'blup', label: 'Len overené' },
];

export default function EventResaleScreen() {
  const { event: eventId } = useLocalSearchParams<{ event: string }>();
  const layout = useLayout();
  const [sort, setSort] = useState<ResaleSort>('price_asc');
  const [source, setSource] = useState<ResaleSource | null>(null);

  const event = useQuery({
    queryKey: ['event', eventId],
    queryFn: () => getEvent(eventId!),
    enabled: Boolean(eventId),
  });

  const summary = useQuery({
    queryKey: ['resale', 'summary', eventId],
    queryFn: () => getEventResaleSummary(eventId!),
    enabled: Boolean(eventId),
  });

  const listings = useQuery({
    queryKey: ['resale', 'listings', eventId, sort, source],
    queryFn: () => getEventResaleListings(eventId!, { sort, source }),
    enabled: Boolean(eventId),
  });

  if (listings.isLoading) return <Screen><LoadingState label="Načítavam ponuky…" /></Screen>;
  if (listings.error) {
    return (
      <Screen>
        <ErrorState
          title="Ponuky sa nenačítali"
          message="Skús to prosím znova."
          onRetry={() => void listings.refetch()}
        />
      </Screen>
    );
  }

  const rows = listings.data ?? [];
  const stats = summary.data;

  return (
    <Screen scroll={false}>
      {/* Hlavička hore hovorí „Burza vstupeniek"; tu už len to, ktorého
          eventu sa týka — zopakovaný nadpis by bol ten istý text dvakrát. */}
      {event.data ? (
        <View style={styles.header}>
          <Text style={styles.eventName} numberOfLines={1}>{event.data.title}</Text>
          <Caption>{formatEventDate(event.data.start_at)}</Caption>
        </View>
      ) : null}

      {stats && stats.listings > 0 ? (
        <View style={styles.summary}>
          <View style={styles.summaryCell}>
            <Text style={styles.summaryBig}>{stats.tickets}</Text>
            <Caption>
              {stats.tickets === 1 ? 'vstupenka' : stats.tickets < 5 ? 'vstupenky' : 'vstupeniek'}
            </Caption>
          </View>
          <View style={styles.summaryCell}>
            <Text style={styles.summaryBig}>
              {stats.from_cents != null
                ? formatMoney(stats.from_cents, stats.currency ?? 'EUR')
                : '—'}
            </Text>
            <Caption>od</Caption>
          </View>
          <View style={styles.summaryCell}>
            <Text style={styles.summaryBig}>{stats.verified_count}</Text>
            <Caption>overených</Caption>
          </View>
        </View>
      ) : null}

      <View style={styles.filters}>
        {SORTS.map((option) => (
          <Pressable
            key={option.key}
            onPress={() => setSort(option.key)}
            style={[styles.chip, sort === option.key && styles.chipOn]}
          >
            <Text style={[styles.chipLabel, sort === option.key && styles.chipLabelOn]}>
              {option.label}
            </Text>
          </Pressable>
        ))}
        <View style={styles.filterGap} />
        {SOURCES.map((option) => (
          <Pressable
            key={option.label}
            onPress={() => setSource(option.key)}
            style={[styles.chip, source === option.key && styles.chipOn]}
          >
            <Text style={[styles.chipLabel, source === option.key && styles.chipLabelOn]}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Na monitore sa ponuky ukladajú do mriežky. Jeden stĺpec kariet cez
          celú šírku znamená, že na obrazovku sa zmestia tri ponuky a
          porovnávať ceny sa dá len rolovaním hore-dole — pri burze, kde je
          porovnanie celý dôvod návštevy, je to to najhoršie rozloženie. */}
      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        numColumns={layout.columns}
        key={`cols-${layout.columns}`}
        columnWrapperStyle={layout.columns > 1 ? styles.columns : undefined}
        contentContainerStyle={[
          styles.list,
          layout.isWide && { maxWidth: CONTENT_MAX, alignSelf: 'center', width: '100%' },
        ]}
        ListEmptyComponent={
          <EmptyState
            emoji="🎟"
            title="Zatiaľ tu nikto nepredáva"
            body="Keď niekto nebude môcť ísť, jeho vstupenka sa objaví tu."
          />
        }
        renderItem={({ item }) => (
          <View style={layout.columns > 1 ? styles.cell : undefined}>
            <ListingRow listing={item} />
          </View>
        )}
      />
    </Screen>
  );
}

function ListingRow({ listing }: { listing: ResaleListing }) {
  const seat = [
    listing.section && `Sektor ${listing.section}`,
    listing.row_label && `rad ${listing.row_label}`,
    listing.seat_label && `miesto ${listing.seat_label}`,
  ].filter(Boolean).join(' · ');

  // Pôvodná cena sa ukáže len vtedy, keď je vyššia — inak je to buď rovnaké
  // číslo dvakrát, alebo zvýrazňovanie toho, že predajca pýta viac.
  const cheaper = listing.face_value_cents != null
    && listing.face_value_cents > listing.price_cents;

  return (
    <Pressable
      style={styles.card}
      onPress={() => router.push(`/resale/checkout/${listing.id}`)}
      accessibilityRole="button"
    >
      <View style={styles.cardTop}>
        <AuthenticityBadge authenticity={listing.authenticity} size="s" />
        <View style={styles.priceBlock}>
          <Text style={styles.price}>
            {formatMoney(listing.price_cents, listing.currency)}
          </Text>
          {cheaper ? (
            <Text style={styles.face}>
              {formatMoney(listing.face_value_cents!, listing.currency)}
            </Text>
          ) : null}
        </View>
      </View>

      {seat ? <Text style={styles.seat}>{seat}</Text> : null}
      {!seat && listing.ticket_label ? (
        <Text style={styles.seat}>{listing.ticket_label}</Text>
      ) : null}

      {listing.note ? (
        <Caption numberOfLines={2} style={styles.note}>{listing.note}</Caption>
      ) : null}

      <View style={styles.cardBottom}>
        <Avatar
          url={listing.seller_avatar}
          name={listing.seller_name}
          size={24}
          userId={listing.seller_id}
        />
        <Caption numberOfLines={1} style={styles.seller}>
          {listing.seller_name ?? listing.seller_username ?? 'Predajca'}
        </Caption>
        {listing.quantity > 1 ? (
          <Caption style={styles.qty}>{listing.quantity} ks</Caption>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: 2,
    maxWidth: CONTENT_MAX, alignSelf: 'center', width: '100%',
  },
  eventName: { ...typography.subheading, color: colors.text },

  summary: {
    flexDirection: 'row',
    marginHorizontal: spacing.lg,
    maxWidth: CONTENT_MAX, alignSelf: 'center', width: '100%',
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  summaryCell: { flex: 1, alignItems: 'center', gap: 2 },
  summaryBig: { ...typography.subheading, color: colors.text },

  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    maxWidth: CONTENT_MAX, alignSelf: 'center', width: '100%',
    paddingBottom: spacing.md,
    alignItems: 'center',
  },
  filterGap: { width: spacing.sm },
  chip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipLabel: { ...typography.metaSm, color: colors.textSecondary },
  chipLabelOn: { color: '#FFFFFF', fontWeight: '700' },

  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  columns: { gap: spacing.sm },
  cell: { flex: 1 },

  card: {
    padding: spacing.md,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
    ...shadow.cta,
  },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  priceBlock: { alignItems: 'flex-end' },
  price: { ...typography.subheading, color: colors.text },
  face: {
    ...typography.metaSm,
    color: colors.textQuaternary,
    textDecorationLine: 'line-through',
  },
  seat: { ...typography.body, color: colors.text },
  note: { color: colors.textTertiary },
  cardBottom: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  seller: { flex: 1 },
  qty: { color: colors.textSecondary },
});
