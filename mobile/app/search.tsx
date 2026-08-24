import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { useLocation } from '@/hooks/useLocation';
import { searchEvents } from '@/api/events';
import { messageFor } from '@/lib/errors';
import { formatEventDate, formatPrice } from '@/lib/format';
import { GradientCover } from '@/components/GradientCover';
import { ErrorState, IconButton, Input, LoadingState, Screen } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';
import type { EventFeedItem } from '@/types/models';

/**
 * Hľadanie.
 *
 * The handoff's search screen: an input, five quick chips that prefill the
 * query, and rows with a 54px thumbnail. With no query it shows the first
 * events; with no hits, a dashed empty card.
 */

interface QuickFilter {
  label: string;
  query?: string;
  freeOnly?: boolean;
  maxKm?: number;
  today?: boolean;
  morning?: boolean;
}

const QUICK: QuickFilter[] = [
  { label: 'Dnes večer', today: true },
  { label: 'Zdarma', freeOnly: true },
  { label: 'Hudba', query: 'hudba' },
  { label: 'Do 2 km', maxKm: 2 },
  { label: 'Ráno', morning: true },
];

export default function SearchScreen() {
  const location = useLocation();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<QuickFilter | null>(null);

  const results = useQuery({
    queryKey: ['search', query, active?.label, location.coords],
    queryFn: () =>
      searchEvents({
        query,
        latitude: location.coords?.latitude,
        longitude: location.coords?.longitude,
        freeOnly: active?.freeOnly,
        from: new Date(),
        to: active?.today
          ? (() => {
              const end = new Date();
              end.setHours(23, 59, 59, 999);
              return end;
            })()
          : undefined,
        sort: active?.maxKm ? 'distance' : 'start_at',
        limit: 40,
      }),
  });

  // Distance and time-of-day are narrowed here rather than in the query,
  // because they are presentation filters over the same result set.
  const filtered = (results.data ?? []).filter((event) => {
    if (active?.maxKm && event.distance_m !== null && event.distance_m > active.maxKm * 1000) {
      return false;
    }
    if (active?.morning) {
      const hour = new Date(event.start_at).getHours();
      if (Number.isNaN(hour) || hour >= 12) return false;
    }
    return true;
  });

  return (
    <Screen contentStyle={styles.container}>
      <View style={styles.header}>
        <IconButton glyph="‹" size={40} onPress={() => router.back()} />
        <Input
          value={query}
          onChangeText={setQuery}
          placeholder="Hľadaj event, miesto, náladu…"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          autoFocus
          style={styles.input}
        />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View style={styles.chipRow}>
            {QUICK.map((filter) => {
              const isActive = active?.label === filter.label;
              return (
                <Pressable
                  key={filter.label}
                  onPress={() => {
                    setActive(isActive ? null : filter);
                    if (!isActive && filter.query) setQuery(filter.query);
                    if (isActive && filter.query) setQuery('');
                  }}
                  style={[styles.chip, isActive && styles.chipActive]}
                >
                  <Text style={[styles.chipLabel, isActive && styles.chipLabelActive]}>
                    {filter.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        }
        renderItem={({ item }) => <ResultRow event={item} />}
        ListEmptyComponent={
          results.isLoading ? (
            <LoadingState label="Hľadám…" />
          ) : results.isError ? (
            <ErrorState message={messageFor(results.error)} onRetry={() => void results.refetch()} />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>Nič také tu nie je. Skús inú náladu.</Text>
            </View>
          )
        }
      />
    </Screen>
  );
}

function ResultRow({ event }: { event: EventFeedItem }) {
  return (
    <Pressable
      onPress={() => router.push(`/event/${event.id}`)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <GradientCover
        uri={event.cover_image_url}
        category={event.category}
        height={54}
        style={styles.thumb}
        showPlaceholderLabel={false}
      />

      <View style={styles.flex}>
        <Text style={styles.rowTitle} numberOfLines={1}>{event.title}</Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {formatEventDate(event.start_at)}
          {event.venue_name ? ` · ${event.venue_name}` : ''}
        </Text>
      </View>

      <Text style={styles.rowPrice}>
        {event.is_free ? 'Zdarma' : formatPrice(event.price_cents, event.currency)}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { paddingTop: spacing.md },
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.gutter,
    marginBottom: spacing.lg,
  },
  input: { flex: 1, marginBottom: 0 },

  list: { paddingHorizontal: spacing.gutter, paddingBottom: spacing.xxxl, flexGrow: 1 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
  chip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radius.chip,
    backgroundColor: colors.surfaceElevated,
  },
  chipActive: { backgroundColor: colors.accent },
  chipLabel: { ...typography.chip, color: colors.textSecondary },
  chipLabelActive: { color: '#FFFFFF' },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowPressed: { opacity: 0.75 },
  thumb: { width: 54, borderRadius: radius.md },
  rowTitle: { ...typography.rowTitle, color: colors.text },
  rowMeta: { ...typography.metaSm, color: colors.textTertiary, marginTop: 2 },
  rowPrice: { ...typography.meta, color: colors.accentText },

  empty: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    borderRadius: radius.card,
    padding: spacing.xxl,
    alignItems: 'center',
  },
  emptyText: { ...typography.body, color: colors.textTertiary, textAlign: 'center' },
});
