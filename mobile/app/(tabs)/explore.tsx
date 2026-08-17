import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { useLocation } from '@/hooks/useLocation';
import { searchEvents } from '@/api/events';
import { searchProfiles } from '@/api/profiles';
import { getPeopleRecommendations, describeMatch } from '@/api/ai';
import { supabase } from '@/lib/supabase';
import { messageFor } from '@/lib/errors';
import { formatDistance } from '@/lib/format';
import { EventCard } from '@/components/EventCard';
import {
  Avatar, Badge, Body, Caption, Chip, EmptyState, ErrorState, Input, LoadingState, Screen,
} from '@/components/ui';
import { colors, spacing, typography } from '@/theme';

type Tab = 'events' | 'people' | 'organizations';

const CATEGORIES = [
  'techno', 'house', 'indie', 'jazz', 'running', 'climbing', 'yoga', 'hiking',
  'food', 'coffee', 'wine', 'art', 'cinema', 'startups', 'tech', 'design',
  'board-games', 'nightlife', 'volunteering',
];

const DATE_FILTERS = [
  { key: 'any', label: 'Any time' },
  { key: 'today', label: 'Today' },
  { key: 'weekend', label: 'This weekend' },
  { key: 'week', label: 'Next 7 days' },
] as const;

/** Explore — search and filters across events, people and organizations. */
export default function ExploreScreen() {
  const location = useLocation();
  const [tab, setTab] = useState<Tab>('events');
  const [query, setQuery] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [freeOnly, setFreeOnly] = useState(false);
  const [dateFilter, setDateFilter] = useState<(typeof DATE_FILTERS)[number]['key']>('any');
  const [sort, setSort] = useState<'start_at' | 'distance' | 'popularity'>('start_at');

  const dateRange = useMemo(() => {
    const from = new Date();
    if (dateFilter === 'any') return { from, to: undefined };

    const to = new Date();
    if (dateFilter === 'today') {
      to.setHours(23, 59, 59, 999);
    } else if (dateFilter === 'week') {
      to.setDate(to.getDate() + 7);
    } else {
      // this weekend: from Friday 18:00 to Sunday 23:59
      const day = from.getDay();
      const daysUntilFriday = (5 - day + 7) % 7;
      const friday = new Date(from);
      friday.setDate(from.getDate() + daysUntilFriday);
      friday.setHours(18, 0, 0, 0);
      const sunday = new Date(friday);
      sunday.setDate(friday.getDate() + 2);
      sunday.setHours(23, 59, 59, 999);
      return { from: daysUntilFriday === 0 ? from : friday, to: sunday };
    }
    return { from, to };
  }, [dateFilter]);

  const eventsQuery = useQuery({
    queryKey: ['search', 'events', query, categories, freeOnly, dateFilter, sort, location.coords],
    queryFn: () =>
      searchEvents({
        query,
        latitude: location.coords?.latitude,
        longitude: location.coords?.longitude,
        categories,
        freeOnly,
        from: dateRange.from,
        to: dateRange.to,
        sort,
        limit: 50,
      }),
    enabled: tab === 'events',
  });

  const peopleQuery = useQuery({
    queryKey: ['search', 'people', query],
    queryFn: async () => {
      if (query.trim().length >= 2) return { mode: 'search' as const, results: await searchProfiles(query) };
      return { mode: 'suggested' as const, results: await getPeopleRecommendations({ limit: 20 }) };
    },
    enabled: tab === 'people',
  });

  const organizationsQuery = useQuery({
    queryKey: ['search', 'organizations', query],
    queryFn: async () => {
      let request = supabase.from('organizations').select('*').limit(30);
      if (query.trim().length >= 2) request = request.ilike('name', `%${query.trim()}%`);

      const { data, error } = await request;
      if (error) throw error;
      return data ?? [];
    },
    enabled: tab === 'organizations',
  });

  const toggleCategory = (category: string) => {
    setCategories((previous) =>
      previous.includes(category)
        ? previous.filter((item) => item !== category)
        : [...previous, category],
    );
  };

  return (
    <Screen contentStyle={styles.container}>
      <View style={styles.header}>
        <Input
          value={query}
          onChangeText={setQuery}
          placeholder="Search events, people, organizers"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={styles.searchInput}
        />

        <View style={styles.tabs}>
          {(['events', 'people', 'organizations'] as Tab[]).map((option) => (
            <Pressable
              key={option}
              onPress={() => setTab(option)}
              style={[styles.tab, tab === option && styles.tabActive]}
            >
              <Text style={[styles.tabLabel, tab === option && styles.tabLabelActive]}>
                {option === 'organizations' ? 'Organizers' : option}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {tab === 'events' ? (
        <FlatList
          data={eventsQuery.data ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            <View>
              <FlatList
                horizontal
                data={DATE_FILTERS}
                keyExtractor={(item) => item.key}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.filterRow}
                renderItem={({ item }) => (
                  <Chip
                    label={item.label}
                    selected={dateFilter === item.key}
                    onPress={() => setDateFilter(item.key)}
                  />
                )}
              />

              <FlatList
                horizontal
                data={CATEGORIES}
                keyExtractor={(item) => item}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.filterRow}
                renderItem={({ item }) => (
                  <Chip
                    label={item}
                    selected={categories.includes(item)}
                    onPress={() => toggleCategory(item)}
                  />
                )}
              />

              <View style={styles.filterRow}>
                <Chip label="Free only" selected={freeOnly} onPress={() => setFreeOnly((v) => !v)} />
                <Chip
                  label="Soonest"
                  selected={sort === 'start_at'}
                  onPress={() => setSort('start_at')}
                />
                <Chip
                  label="Closest"
                  selected={sort === 'distance'}
                  onPress={() => setSort('distance')}
                />
                <Chip
                  label="Popular"
                  selected={sort === 'popularity'}
                  onPress={() => setSort('popularity')}
                />
              </View>

              {eventsQuery.data && eventsQuery.data.length > 0 ? (
                <Caption style={styles.resultCount}>
                  {eventsQuery.data.length} {eventsQuery.data.length === 1 ? 'event' : 'events'}
                </Caption>
              ) : null}
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.listItem}>
              <EventCard event={item} onPress={() => router.push(`/event/${item.id}`)} />
            </View>
          )}
          ListEmptyComponent={
            eventsQuery.isLoading ? (
              <LoadingState label="Searching…" />
            ) : eventsQuery.isError ? (
              <ErrorState message={messageFor(eventsQuery.error)} onRetry={() => void eventsQuery.refetch()} />
            ) : (
              <EmptyState
                emoji="🔍"
                title={query ? 'No events match that' : 'Nothing scheduled yet'}
                body={
                  query
                    ? 'Try a different word, widen the date range or drop a filter.'
                    : 'When people around you create events, they land here. You could go first.'
                }
                actionLabel="Create an event"
                onAction={() => router.push('/(tabs)/create')}
              />
            )
          }
        />
      ) : null}

      {tab === 'people' ? (
        peopleQuery.isLoading ? (
          <LoadingState label="Looking for people…" />
        ) : peopleQuery.data?.mode === 'suggested' ? (
          <FlatList
            data={peopleQuery.data.results}
            keyExtractor={(item) => item.user_id}
            contentContainerStyle={styles.list}
            ListHeaderComponent={<Caption style={styles.resultCount}>People like you</Caption>}
            renderItem={({ item }) => (
              <Pressable style={styles.personRow} onPress={() => router.push(`/user/${item.user_id}`)}>
                <Avatar url={item.avatar_url} name={item.display_name} size={48} />
                <View style={styles.flex}>
                  <Text style={styles.personName}>{item.display_name ?? item.username}</Text>
                  <Caption numberOfLines={1}>{describeMatch(item)}</Caption>
                  {item.shared_interest_names.length > 0 ? (
                    <Caption numberOfLines={1} style={styles.sharedInterests}>
                      {item.shared_interest_names.slice(0, 3).join(' · ')}
                    </Caption>
                  ) : null}
                </View>
                {item.distance_m ? <Badge label={formatDistance(item.distance_m) ?? ''} /> : null}
              </Pressable>
            )}
            ListEmptyComponent={
              <EmptyState
                emoji="👥"
                title="No matches yet"
                body="Pick more interests and RSVP to a few events — matching gets better the more BLUP knows about what you like."
              />
            }
          />
        ) : (
          <FlatList
            data={peopleQuery.data?.results ?? []}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.list}
            renderItem={({ item }) => (
              <Pressable style={styles.personRow} onPress={() => router.push(`/user/${item.id}`)}>
                <Avatar url={item.avatar_url} name={item.display_name} size={48} />
                <View style={styles.flex}>
                  <Text style={styles.personName}>{item.display_name ?? item.username}</Text>
                  <Caption numberOfLines={1}>{item.bio ?? `@${item.username}`}</Caption>
                </View>
              </Pressable>
            )}
            ListEmptyComponent={
              <EmptyState emoji="👥" title="Nobody matches that" body="Try another name or username." />
            }
          />
        )
      ) : null}

      {tab === 'organizations' ? (
        <FlatList
          data={organizationsQuery.data ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable style={styles.personRow} onPress={() => router.push(`/user/${item.created_by}`)}>
              <Avatar url={item.logo_url} name={item.name} size={48} />
              <View style={styles.flex}>
                <Text style={styles.personName}>{item.name}</Text>
                <Caption numberOfLines={1}>{item.description ?? `@${item.slug}`}</Caption>
              </View>
              {item.verification_status === 'verified' ? (
                <Badge tone="success" label="✓ Verified" />
              ) : null}
            </Pressable>
          )}
          ListEmptyComponent={
            organizationsQuery.isLoading ? (
              <LoadingState label="Loading organizers…" />
            ) : (
              <EmptyState
                emoji="🏢"
                title="No organizers yet"
                body="Verified organizers can sell tickets on BLUP. Apply from your profile."
              />
            )
          }
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { paddingTop: spacing.md },
  flex: { flex: 1 },

  header: { paddingHorizontal: spacing.lg },
  searchInput: { marginBottom: 0 },

  tabs: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, marginBottom: spacing.sm },
  tab: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: colors.surface,
  },
  tabActive: { backgroundColor: colors.accent },
  tabLabel: { ...typography.caption, color: colors.textSecondary, textTransform: 'capitalize' },
  tabLabelActive: { color: colors.textInverse },

  list: { padding: spacing.lg, paddingBottom: spacing.xxxl, flexGrow: 1 },
  listItem: { marginBottom: spacing.lg },
  filterRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  resultCount: { marginBottom: spacing.md },

  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  personName: { ...typography.bodyStrong, color: colors.text },
  sharedInterests: { color: colors.accent, marginTop: 2 },
});
