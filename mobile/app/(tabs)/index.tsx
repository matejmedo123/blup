import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/auth/AuthProvider';
import { useLocation } from '@/hooks/useLocation';
import { getNearbyEvents, saveEvent, unsaveEvent } from '@/api/events';
import { getFollowing } from '@/api/profiles';
import { getAIRecommendations } from '@/api/ai';
import { recordSignal, queueImpression } from '@/api/signals';
import { supabase } from '@/lib/supabase';
import { messageFor } from '@/lib/errors';
import { EventCard } from '@/components/EventCard';
import { EventMap } from '@/components/EventMap';
import { SwipeDeck, type SwipeDirection } from '@/components/SwipeDeck';
import {
  AvatarStack, Badge, Body, Button, Caption, Chip, EmptyState, ErrorState, IconButton,
  LoadingState, Mono, Notice, SectionHeader, Segmented,
} from '@/components/ui';
import { colors, labelFor, radius, spacing, typography } from '@/theme';
import type { EventFeedItem } from '@/types/models';

type Mode = 'map' | 'feed' | 'swipe';
const RADIUS_OPTIONS = [2000, 5000, 25000, 100000];

/** The quick filters from the design; the full list lives in Explore. */
const QUICK_CATEGORIES = ['techno', 'startups', 'hiking', 'art', 'food', 'running'];

/**
 * Home — the map, "Today near me", the AI "For you" rail and the swipe deck.
 * Everything on this screen comes from the database; nothing is hardcoded.
 */
export default function HomeScreen() {
  const { profile } = useAuth();
  const location = useLocation({ watch: true });
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<Mode>('map');
  const [radiusM, setRadiusM] = useState(25000);
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const coords = location.coords;

  const nearby = useQuery({
    queryKey: ['events', 'nearby', coords?.latitude, coords?.longitude, radiusM, categories],
    queryFn: () =>
      getNearbyEvents({
        latitude: coords?.latitude,
        longitude: coords?.longitude,
        radiusM,
        categories,
        limit: 60,
      }),
    enabled: Boolean(coords),
  });

  const following = useQuery({
    queryKey: ['profile', 'following', profile?.id],
    queryFn: () => getFollowing(profile!.id),
    enabled: Boolean(profile?.id),
  });

  const recommendations = useQuery({
    queryKey: ['events', 'recommended', coords?.latitude, coords?.longitude],
    queryFn: () => getAIRecommendations({ coords, radiusM: Math.max(radiusM, 50000), limit: 20 }),
    enabled: Boolean(profile),
  });

  // Realtime: a new event created by anyone shows up here without a refresh.
  useEffect(() => {
    const channel = supabase
      .channel('home-events')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'events' },
        () => {
          void queryClient.invalidateQueries({ queryKey: ['events'] });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const events = nearby.data ?? [];
  const circles = (following.data ?? []).map((person) => ({
    id: person.id,
    avatar_url: person.avatar_url,
    name: person.display_name ?? person.username,
  }));
  const recommended = recommendations.data?.events ?? [];

  const todayEvents = useMemo(() => {
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    return events.filter((event) => new Date(event.start_at) <= endOfDay);
  }, [events]);

  const toggleSave = useCallback(
    async (event: EventFeedItem) => {
      setActionError(null);
      try {
        if (event.is_saved) await unsaveEvent(event.id);
        else await saveEvent(event.id);
        await queryClient.invalidateQueries({ queryKey: ['events'] });
      } catch (caught) {
        setActionError(messageFor(caught));
      }
    },
    [queryClient],
  );

  const handleSwipe = useCallback(
    async (event: EventFeedItem, direction: SwipeDirection) => {
      if (direction === 'up') {
        router.push(`/event/${event.id}`);
        return;
      }

      if (direction === 'right') {
        await recordSignal(event.id, 'swipe_right');
        try {
          await saveEvent(event.id);
        } catch (caught) {
          setActionError(messageFor(caught));
        }
      } else {
        await recordSignal(event.id, 'swipe_left');
      }
    },
    [],
  );

  const openEvent = (event: EventFeedItem) => router.push(`/event/${event.id}`);

  // --- location gates -------------------------------------------------------
  const needsLocation = !coords && location.status !== 'requesting';

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.flex}>
          <Mono accent>◎ {location.city ?? 'Zisťujem polohu'}</Mono>
          <Text style={styles.greeting}>Dnes okolo teba</Text>
        </View>

        <View style={styles.headerActions}>
          <IconButton
            glyph="◔"
            onPress={() => {
              const index = RADIUS_OPTIONS.indexOf(radiusM);
              setRadiusM(RADIUS_OPTIONS[(index + 1) % RADIUS_OPTIONS.length]);
            }}
          />
          <IconButton glyph="⌕" onPress={() => router.push('/(tabs)/explore')} />
        </View>
      </View>

      <View style={styles.controls}>
        <Segmented
          options={[
            { value: 'feed' as Mode, label: 'Zoznam' },
            { value: 'map' as Mode, label: 'Mapa' },
          ]}
          value={mode === 'swipe' ? 'feed' : mode}
          onChange={setMode}
        />

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.categoryRow}
        >
          <Chip label="Všetko" selected={categories.length === 0} onPress={() => setCategories([])} />
          {QUICK_CATEGORIES.map((item) => (
            <Chip
              key={item}
              label={labelFor(item)}
              selected={categories.includes(item)}
              onPress={() =>
                setCategories((previous) =>
                  previous.includes(item)
                    ? previous.filter((value) => value !== item)
                    : [...previous, item],
                )
              }
            />
          ))}
        </ScrollView>

        {circles.length > 0 ? (
          <View style={styles.circlesRow}>
            <AvatarStack people={circles} size={30} max={5} />
            <Caption style={styles.circlesLabel}>Tvoje kruhy dnes niekam idú</Caption>
          </View>
        ) : null}

        <Pressable style={styles.swipeCta} onPress={() => setMode('swipe')}>
          <Text style={styles.swipeCtaLabel}>◈  Blupni si program</Text>
          <Mono accent>{recommended.length} eventov</Mono>
        </Pressable>
      </View>

      {actionError ? (
        <View style={styles.noticeWrapper}>
          <Notice tone="danger" title="Toto sa nepodarilo" body={actionError} />
        </View>
      ) : null}

      {needsLocation ? (
        <View style={styles.noticeWrapper}>
          <Notice
            tone="warning"
            title={location.status === 'denied' ? 'Poloha je vypnutá' : 'Zapni polohu'}
            body={
              location.error ??
              'BLUP potrebuje tvoju polohu, aby ti ukázal, čo sa deje okolo teba a ako ďaleko to je.'
            }
            actionLabel={location.status === 'denied' ? 'Otvoriť nastavenia' : 'Zapnúť polohu'}
            onAction={location.status === 'denied' ? location.openSettings : () => void location.request()}
          />
        </View>
      ) : null}

      {mode === 'map' ? (
        <MapMode
          events={events}
          coords={coords}
          radiusM={radiusM}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onOpen={openEvent}
          loading={nearby.isLoading}
          error={nearby.isError ? messageFor(nearby.error) : null}
          onRetry={() => void nearby.refetch()}
        />
      ) : null}

      {mode === 'feed' ? (
        <FeedMode
          today={todayEvents}
          recommended={recommended}
          all={events}
          loading={nearby.isLoading || recommendations.isLoading}
          error={nearby.isError ? messageFor(nearby.error) : null}
          refreshing={nearby.isRefetching}
          onRefresh={() => {
            void nearby.refetch();
            void recommendations.refetch();
          }}
          onOpen={openEvent}
          onSave={toggleSave}
          explanationSource={recommendations.data?.explanations_by}
        />
      ) : null}

      {mode === 'swipe' ? (
        recommendations.isLoading ? (
          <LoadingState label="Hľadám pre teba eventy…" />
        ) : recommended.length === 0 ? (
          <EmptyState
            emoji="🫧"
            title="Zatiaľ nie je čo blupnúť"
            body="V tomto okolí ti nič nesedí. Rozšír okruh alebo buď prvý, kto sem niečo dá."
            actionLabel="Vytvor prvý BLUP"
            onAction={() => router.push('/(tabs)/create')}
          />
        ) : (
          <SwipeDeck
            events={recommended}
            onSwipe={handleSwipe}
            onReset={() => void recommendations.refetch()}
            onExhausted={() => void recommendations.refetch()}
          />
        )
      ) : null}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------

function MapMode({
  events, coords, radiusM, selectedId, onSelect, onOpen, loading, error, onRetry,
}: {
  events: EventFeedItem[];
  coords: { latitude: number; longitude: number } | null;
  radiusM: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (event: EventFeedItem) => void;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const selected = events.find((event) => event.id === selectedId);

  if (error) return <ErrorState message={error} onRetry={onRetry} />;

  return (
    <View style={styles.flex}>
      <EventMap
        events={events}
        userLocation={coords}
        selectedId={selectedId}
        radiusM={radiusM}
        onSelect={(event) => onSelect(event.id)}
        style={styles.flex}
      />

      {loading ? (
        <View style={styles.mapLoading}>
          <Text style={styles.mapLoadingText}>Načítavam eventy…</Text>
        </View>
      ) : null}

      {selected ? (
        <View style={styles.mapCard}>
          <EventCard event={selected} size="compact" onPress={() => onOpen(selected)} />
        </View>
      ) : events.length === 0 && !loading ? (
        <View style={styles.mapEmpty}>
          <Text style={styles.mapEmptyTitle}>Tu sa zatiaľ nič nedeje</Text>
          <Body muted style={styles.mapEmptyBody}>
            Buď prvý — daj svoj event na mapu a ľudia v okolí ho uvidia.
          </Body>
          <Button title="Vytvor prvý BLUP" onPress={() => router.push('/(tabs)/create')} />
        </View>
      ) : null}
    </View>
  );
}

function FeedMode({
  today, recommended, all, loading, error, refreshing, onRefresh, onOpen, onSave, explanationSource,
}: {
  today: EventFeedItem[];
  recommended: EventFeedItem[];
  all: EventFeedItem[];
  loading: boolean;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onOpen: (event: EventFeedItem) => void;
  onSave: (event: EventFeedItem) => void;
  explanationSource?: string;
}) {
  useEffect(() => {
    for (const event of recommended.slice(0, 8)) queueImpression(event.id);
  }, [recommended]);

  if (loading && all.length === 0 && recommended.length === 0) {
    return <LoadingState label="Rozhliadam sa okolo teba…" />;
  }

  if (error && all.length === 0) return <ErrorState message={error} onRetry={onRefresh} />;

  if (all.length === 0 && recommended.length === 0) {
    return (
      <EmptyState
        emoji="🫧"
        title="Tu sa zatiaľ nič nedeje"
        body="Vo tvojom okolí teraz nič nie je. Vytvor prvý BLUP a hneď sa objaví každému na mape."
        actionLabel="Vytvor prvý BLUP"
        onAction={() => router.push('/(tabs)/create')}
      />
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.feedContent}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
      }
    >
      {today.length > 0 ? (
        <>
          <SectionHeader title="Dnes v okolí" />
          <FlatList
            horizontal
            data={today}
            keyExtractor={(item) => item.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.rail}
            renderItem={({ item }) => (
              <EventCard
                event={item}
                size="compact"
                onPress={() => onOpen(item)}
                onSave={() => onSave(item)}
              />
            )}
          />
        </>
      ) : null}

      {recommended.length > 0 ? (
        <>
          <View style={styles.forYouHeader}>
            <SectionHeader title="Pre teba" />
            {explanationSource && explanationSource !== 'none' ? (
              <Badge
                tone="accent"
                label={explanationSource.startsWith('local') || explanationSource.startsWith('fallback')
                  ? 'Zoradil BLUP'
                  : 'Vysvetlené AI'}
              />
            ) : null}
          </View>

          {recommended.slice(0, 10).map((event) => (
            <View key={event.id} style={styles.feedItem}>
              <EventCard
                event={event}
                onPress={() => onOpen(event)}
                onSave={() => onSave(event)}
                showScore
              />
            </View>
          ))}
        </>
      ) : null}

      <SectionHeader title="Všetko v okolí" />
      {all.map((event) => (
        <View key={event.id} style={styles.feedItem}>
          <EventCard event={event} onPress={() => onOpen(event)} onSave={() => onSave(event)} />
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  headerActions: { flexDirection: 'row', gap: spacing.sm },
  greeting: { ...typography.title, color: colors.text, marginTop: 2 },

  controls: { paddingHorizontal: spacing.lg, gap: spacing.md, paddingBottom: spacing.md },
  categoryRow: { flexDirection: 'row', gap: spacing.sm, paddingRight: spacing.lg },
  circlesRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  circlesLabel: { flex: 1 },
  swipeCta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  swipeCtaLabel: { ...typography.bodyStrong, color: colors.text },


  noticeWrapper: { paddingHorizontal: spacing.lg },

  mapLoading: {
    position: 'absolute',
    top: spacing.lg,
    alignSelf: 'center',
    backgroundColor: colors.overlay,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  mapLoadingText: { ...typography.caption, color: colors.text },

  mapCard: { position: 'absolute', bottom: spacing.lg, left: spacing.lg, right: spacing.lg },
  mapEmpty: {
    position: 'absolute',
    bottom: spacing.lg,
    left: spacing.lg,
    right: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  mapEmptyTitle: { ...typography.heading, color: colors.text },
  mapEmptyBody: { marginBottom: spacing.md },

  feedContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl },
  rail: { gap: spacing.md, paddingRight: spacing.lg },
  feedItem: { marginBottom: spacing.lg },
  forYouHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
