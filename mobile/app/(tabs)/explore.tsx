import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { useLocation } from '@/hooks/useLocation';
import { searchEvents } from '@/api/events';
import { searchProfiles } from '@/api/profiles';
import { getPeopleRecommendations, describeMatch } from '@/api/ai';
import { getCommunities } from '@/api/communities';
import { supabase } from '@/lib/supabase';
import { messageFor } from '@/lib/errors';
import { formatDistance } from '@/lib/format';
import { EventCard } from '@/components/EventCard';
import {
  Avatar, Badge, Chip, EmptyState, ErrorState, Input, LoadingState, Mono, Screen, Segmented,
} from '@/components/ui';
import { colors, labelFor, radius, spacing, typography } from '@/theme';

type Tab = 'events' | 'people' | 'communities' | 'organizations';

const TABS: { value: Tab; label: string }[] = [
  { value: 'events', label: 'Eventy' },
  { value: 'people', label: 'Ľudia' },
  { value: 'communities', label: 'Komunity' },
  { value: 'organizations', label: 'Organizátori' },
];

const CATEGORIES = [
  'techno', 'house', 'indie', 'jazz', 'running', 'climbing', 'yoga', 'hiking',
  'food', 'coffee', 'wine', 'art', 'cinema', 'startups', 'tech', 'design',
  'board-games', 'nightlife', 'volunteering',
];

const DATE_FILTERS = [
  { key: 'any', label: 'Kedykoľvek' },
  { key: 'today', label: 'Dnes' },
  { key: 'weekend', label: 'Cez víkend' },
  { key: 'week', label: 'Najbližších 7 dní' },
] as const;

const SORTS = [
  { key: 'start_at', label: 'Najskôr' },
  { key: 'distance', label: 'Najbližšie' },
  { key: 'popularity', label: 'Populárne' },
] as const;

/** Komunita — search and filters across events, people and organizations. */
export default function ExploreScreen() {
  const location = useLocation();
  const [tab, setTab] = useState<Tab>('events');
  const [query, setQuery] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [freeOnly, setFreeOnly] = useState(false);
  const [dateFilter, setDateFilter] = useState<(typeof DATE_FILTERS)[number]['key']>('any');
  const [sort, setSort] = useState<(typeof SORTS)[number]['key']>('start_at');

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

  const communitiesQuery = useQuery({
    queryKey: ['communities', query],
    queryFn: () => getCommunities({ query }),
    enabled: tab === 'communities',
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

  const placeholder = tab === 'people'
    ? 'Hľadaj ľudí podľa mena'
    : tab === 'organizations'
      ? 'Hľadaj organizátorov'
      : tab === 'communities'
        ? 'Hľadaj komunitu'
        : 'Hľadaj eventy, miesta, žánre';

  return (
    <Screen contentStyle={styles.container}>
      <View style={styles.header}>
        <Mono accent>◈ komunita</Mono>
        <Text style={styles.title}>Nájdi si svojich</Text>

        <Input
          value={query}
          onChangeText={setQuery}
          placeholder={placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={styles.searchInput}
        />

        <Segmented options={TABS} value={tab} onChange={setTab} style={styles.tabs} />
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
                    label={labelFor(item)}
                    selected={categories.includes(item)}
                    onPress={() => toggleCategory(item)}
                  />
                )}
              />

              <View style={styles.filterRow}>
                <Chip label="Iba zdarma" selected={freeOnly} onPress={() => setFreeOnly((v) => !v)} />
                {SORTS.map((option) => (
                  <Chip
                    key={option.key}
                    label={option.label}
                    selected={sort === option.key}
                    onPress={() => setSort(option.key)}
                  />
                ))}
              </View>

              {eventsQuery.data && eventsQuery.data.length > 0 ? (
                <Mono style={styles.resultCount}>
                  {eventsQuery.data.length}{' '}
                  {eventsQuery.data.length === 1
                    ? 'event'
                    : eventsQuery.data.length < 5
                      ? 'eventy'
                      : 'eventov'}
                </Mono>
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
              <LoadingState label="Hľadám…" />
            ) : eventsQuery.isError ? (
              <ErrorState message={messageFor(eventsQuery.error)} onRetry={() => void eventsQuery.refetch()} />
            ) : (
              <EmptyState
                emoji="🔍"
                title={query ? 'Nič sa nezhoduje' : 'Zatiaľ sa tu nič nedeje'}
                body={
                  query
                    ? 'Skús iné slovo, rozšír dátum alebo zruš niektorý filter.'
                    : 'Keď ľudia okolo teba vytvoria event, objaví sa tu. Môžeš byť prvý.'
                }
                actionLabel="Vytvor prvý BLUP"
                onAction={() => router.push('/(tabs)/create')}
              />
            )
          }
        />
      ) : null}

      {tab === 'people' ? (
        peopleQuery.isLoading ? (
          <LoadingState label="Hľadám ľudí…" />
        ) : peopleQuery.isError ? (
          <ErrorState message={messageFor(peopleQuery.error)} onRetry={() => void peopleQuery.refetch()} />
        ) : peopleQuery.data?.mode === 'suggested' ? (
          <FlatList
            data={peopleQuery.data.results}
            keyExtractor={(item) => item.user_id}
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
            ListHeaderComponent={<Mono style={styles.resultCount}>ľudia ako ty</Mono>}
            renderItem={({ item }) => (
              <PersonRow
                name={item.display_name ?? item.username}
                username={item.username}
                avatarUrl={item.avatar_url}
                detail={describeMatch(item)}
                tags={item.shared_interest_names.slice(0, 3)}
                trailing={item.distance_m ? formatDistance(item.distance_m) : null}
                onPress={() => router.push(`/user/${item.user_id}`)}
              />
            )}
            ListEmptyComponent={
              <EmptyState
                emoji="👥"
                title="Zatiaľ žiadne zhody"
                body="Vyber si viac záujmov a označ pár eventov — čím viac BLUP vie, tým lepšie ťa spára."
              />
            }
          />
        ) : (
          <FlatList
            data={peopleQuery.data?.results ?? []}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
            renderItem={({ item }) => (
              <PersonRow
                name={item.display_name ?? item.username}
                username={item.username}
                avatarUrl={item.avatar_url}
                detail={item.bio ?? `@${item.username}`}
                onPress={() => router.push(`/user/${item.id}`)}
              />
            )}
            ListEmptyComponent={
              <EmptyState emoji="👥" title="Nikto sa nezhoduje" body="Skús iné meno alebo username." />
            }
          />
        )
      ) : null}

      {tab === 'communities' ? (
        <FlatList
          data={communitiesQuery.data ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            <Pressable style={styles.newCommunity} onPress={() => router.push('/community/new')}>
              <Text style={styles.newCommunityGlyph}>＋</Text>
              <Text style={styles.newCommunityLabel}>Založiť komunitu</Text>
            </Pressable>
          }
          renderItem={({ item }) => (
            <PersonRow
              name={item.name}
              username={item.slug}
              avatarUrl={item.cover_url}
              detail={item.description ?? `${item.member_count} členov`}
              trailing={`${item.member_count}`}
              square
              onPress={() => router.push(`/community/${item.id}`)}
            />
          )}
          ListEmptyComponent={
            communitiesQuery.isLoading ? (
              <LoadingState label="Načítavam komunity…" />
            ) : (
              <EmptyState
                emoji="👥"
                title="Zatiaľ žiadne komunity"
                body="Komunita je tematická skupina — techno, startupy, lezenie. Založ prvú."
                actionLabel="Založiť komunitu"
                onAction={() => router.push('/community/new')}
              />
            )
          }
        />
      ) : null}

      {tab === 'organizations' ? (
        <FlatList
          data={organizationsQuery.data ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <PersonRow
              name={item.name}
              username={item.slug}
              avatarUrl={item.logo_url}
              detail={item.description ?? `@${item.slug}`}
              verified={item.verification_status === 'verified'}
              square
              onPress={() => router.push(`/user/${item.created_by}`)}
            />
          )}
          ListEmptyComponent={
            organizationsQuery.isLoading ? (
              <LoadingState label="Načítavam organizátorov…" />
            ) : (
              <EmptyState
                emoji="🏢"
                title="Zatiaľ žiadni organizátori"
                body="Overení organizátori môžu na BLUPe predávať vstupenky. Prihlás sa zo svojho profilu."
              />
            )
          }
        />
      ) : null}
    </Screen>
  );
}

/** One community row — a person or an organizer, same card shape. */
function PersonRow({
  name, username, avatarUrl, detail, tags, trailing, verified, square, onPress,
}: {
  name: string | null;
  username?: string | null;
  avatarUrl?: string | null;
  detail: string;
  tags?: string[];
  trailing?: string | null;
  verified?: boolean;
  square?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.personRow, pressed && styles.personRowPressed]}
    >
      <Avatar url={avatarUrl} name={name} size={52} ring={!square} />

      <View style={styles.flex}>
        <View style={styles.personNameRow}>
          <Text style={styles.personName} numberOfLines={1}>{name ?? 'Bez mena'}</Text>
          {verified ? <Badge tone="success" label="✓ OVERENÝ" /> : null}
        </View>
        {username ? <Mono style={styles.personHandle}>@{username}</Mono> : null}
        <Text style={styles.personDetail} numberOfLines={2}>{detail}</Text>

        {tags && tags.length > 0 ? (
          <View style={styles.personTags}>
            {tags.map((tag) => (
              <View key={tag} style={styles.tag}>
                <Text style={styles.tagLabel}>{tag}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {trailing ? <Mono style={styles.personTrailing}>{trailing}</Mono> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { paddingTop: spacing.md },
  flex: { flex: 1 },

  header: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  title: { ...typography.title, color: colors.text, marginBottom: spacing.sm },
  searchInput: { marginBottom: 0 },
  tabs: { marginTop: spacing.sm, marginBottom: spacing.sm },

  list: { padding: spacing.lg, paddingBottom: spacing.xxxl, flexGrow: 1 },
  listItem: { marginBottom: spacing.lg },
  filterRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  resultCount: { color: colors.textTertiary, marginBottom: spacing.md },

  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  personRowPressed: { backgroundColor: colors.surfacePressed },
  personNameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  personName: { ...typography.subheading, color: colors.text, flexShrink: 1 },
  personHandle: { color: colors.textTertiary },
  personDetail: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  personTrailing: { color: colors.textTertiary },

  personTags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  tag: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
  },
  tagLabel: { ...typography.chip, fontSize: 11, color: colors.accentText },

  newCommunity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  newCommunityGlyph: { fontSize: 20, color: colors.accentText },
  newCommunityLabel: { ...typography.bodyStrong, color: colors.accentText },
});
