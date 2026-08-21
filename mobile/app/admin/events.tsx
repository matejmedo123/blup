import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getAdminEvents, setEventStatus, type AdminEvent } from '@/api/admin';
import { messageFor } from '@/lib/errors';
import { eventStatusLabel } from '@/lib/labels';
import { formatEventDate, formatPrice } from '@/lib/format';
import {
  Badge, Button, Caption, EmptyState, ErrorState, Input, LoadingState, Notice, Screen,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';
import type { EventStatus } from '@/types/models';

const FILTERS: { key: string | null; label: string }[] = [
  { key: null, label: 'Všetko' },
  { key: 'published', label: 'Zverejnené' },
  { key: 'draft', label: 'Koncepty' },
  { key: 'cancelled', label: 'Zrušené' },
];

/**
 * Admin → Eventy.
 *
 * The list an admin needs to answer "what is this event and who put it here".
 * Editing opens the ordinary edit screen, which knows it is being used by an
 * admin and asks for a reason before it saves.
 */
export default function AdminEventsScreen() {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const events = useQuery({
    queryKey: ['admin', 'events', query, status],
    queryFn: () => getAdminEvents({ query, status, limit: 60 }),
  });

  const flagged = useMemo(
    () => (events.data ?? []).filter((event) => event.reports_open > 0).length,
    [events.data],
  );

  const unpublish = async (event: AdminEvent) => {
    setError(null);
    try {
      await setEventStatus(event.id, 'cancelled', 'Zrušené moderátorom');
      await events.refetch();
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  return (
    <Screen>
      <Input
        label=""
        value={query}
        onChangeText={setQuery}
        placeholder="Hľadaj podľa názvu, mesta, organizátora"
        autoCapitalize="none"
      />

      <View style={styles.filters}>
        {FILTERS.map((filter) => (
          <Pressable
            key={filter.label}
            onPress={() => setStatus(filter.key)}
            style={[styles.filter, status === filter.key && styles.filterOn]}
          >
            <Text style={[styles.filterLabel, status === filter.key && styles.filterLabelOn]}>
              {filter.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {error ? <Notice tone="danger" title="Toto sa nepodarilo" body={error} /> : null}

      {flagged > 0 ? (
        <Caption style={styles.flagged}>
          {flagged} z týchto eventov má otvorené nahlásenie.
        </Caption>
      ) : null}

      {events.isLoading ? (
        <LoadingState />
      ) : events.isError ? (
        <ErrorState message={messageFor(events.error)} onRetry={() => void events.refetch()} />
      ) : (
        <FlatList
          data={events.data ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <EmptyState
              emoji="🔎"
              title="Nič sa nenašlo"
              body="Skús iný názov, mesto alebo meno organizátora."
            />
          }
          renderItem={({ item }) => (
            <View style={styles.row}>
              <View style={styles.flex}>
                <View style={styles.titleRow}>
                  <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
                  {item.reports_open > 0 ? (
                    <Badge tone="danger" label={`${item.reports_open} nahlásení`} />
                  ) : null}
                  {item.status !== 'published' ? (
                    <Badge tone="neutral" label={eventStatusLabel[item.status as EventStatus] ?? item.status} />
                  ) : null}
                </View>

                <Caption>
                  {formatEventDate(item.start_at)}
                  {item.city ? ` · ${item.city}` : ''}
                  {' · '}
                  {item.organization_name ?? item.creator_name ?? 'neznámy'}
                </Caption>

                <Caption>
                  {item.is_free ? 'Zadarmo' : formatPrice(item.price_cents)} ·{' '}
                  {item.tickets_sold} predaných · {item.attendee_count} ide
                </Caption>
              </View>

              <View style={styles.actions}>
                <Button
                  title="Otvoriť"
                  variant="ghost"
                  compact
                  onPress={() => router.push(`/event/${item.id}`)}
                />
                <Button
                  title="Upraviť"
                  variant="secondary"
                  compact
                  onPress={() => router.push(`/event/edit/${item.id}`)}
                />
                {item.status === 'published' ? (
                  <Button
                    title="Zrušiť"
                    variant="ghost"
                    compact
                    onPress={() => void unpublish(item)}
                  />
                ) : null}
              </View>
            </View>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },

  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  filter: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.chip,
    backgroundColor: colors.surfaceElevated,
  },
  filterOn: { backgroundColor: colors.accent },
  filterLabel: { ...typography.chip, fontSize: 12, color: colors.textSecondary },
  filterLabelOn: { color: '#FFFFFF' },

  flagged: { color: colors.danger, marginBottom: spacing.sm },

  list: { paddingBottom: spacing.xxxl },
  row: {
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  title: { ...typography.rowTitle, color: colors.text, flexShrink: 1 },
  actions: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
});
