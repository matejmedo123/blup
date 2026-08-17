import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/auth/AuthProvider';
import { useLocation } from '@/hooks/useLocation';
import { getNearbyEvents, saveEvent, unsaveEvent } from '@/api/events';
import { getAIRecommendations } from '@/api/ai';
import { recordSignal, queueImpression } from '@/api/signals';
import { supabase } from '@/lib/supabase';
import { messageFor } from '@/lib/errors';
import { EventCard } from '@/components/EventCard';
import { EventMap } from '@/components/EventMap';
import { SwipeDeck, type SwipeDirection } from '@/components/SwipeDeck';
import { Badge, Body, Button, EmptyState, ErrorState, LoadingState, Notice, SectionHeader } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';
import type { EventFeedItem } from '@/types/models';

type Mode = 'map' | 'feed' | 'swipe';
const RADIUS_OPTIONS = [2000, 5000, 25000, 100000];

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const coords = location.coords;

  const nearby = useQuery({
    queryKey: ['events', 'nearby', coords?.latitude, coords?.longitude, radiusM],
    queryFn: () =>
      getNearbyEvents({
        latitude: coords?.latitude,
        longitude: coords?.longitude,
        radiusM,
        limit: 60,
      }),
    enabled: Boolean(coords),
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
        <View>
          <Text style={styles.greeting}>
            {profile?.display_name ? `Hey ${profile.display_name.split(' ')[0]}` : 'Hey'}
          </Text>
          <Text style={styles.subGreeting}>
            {location.city ? `What's happening in ${location.city}` : "What's happening around you"}
          </Text>
        </View>

        <Pressable onPress={() => router.push('/tickets')} hitSlop={8} style={styles.headerButton}>
          <Text style={styles.headerButtonText}>🎟️</Text>
        </Pressable>
      </View>

      <View style={styles.modeRow}>
        {(['map', 'feed', 'swipe'] as Mode[]).map((option) => (
          <Pressable
            key={option}
            onPress={() => setMode(option)}
            style={[styles.modeChip, mode === option && styles.modeChipActive]}
          >
            <Text style={[styles.modeLabel, mode === option && styles.modeLabelActive]}>
              {option === 'map' ? 'Map' : option === 'feed' ? 'Feed' : 'Swipe'}
            </Text>
          </Pressable>
        ))}

        <View style={styles.flex} />

        <Pressable
          onPress={() => {
            const index = RADIUS_OPTIONS.indexOf(radiusM);
            setRadiusM(RADIUS_OPTIONS[(index + 1) % RADIUS_OPTIONS.length]);
          }}
          style={styles.radiusChip}
        >
          <Text style={styles.radiusLabel}>
            {radiusM >= 1000 ? `${radiusM / 1000} km` : `${radiusM} m`}
          </Text>
        </Pressable>
      </View>

      {actionError ? (
        <View style={styles.noticeWrapper}>
          <Notice tone="danger" title="Could not do that" body={actionError} />
        </View>
      ) : null}

      {needsLocation ? (
        <View style={styles.noticeWrapper}>
          <Notice
            tone="warning"
            title={location.status === 'denied' ? 'Location is off' : 'Turn on location'}
            body={
              location.error ??
              'BLUP needs your position to show what is happening around you and how far away it is.'
            }
            actionLabel={location.status === 'denied' ? 'Open settings' : 'Enable location'}
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
          <LoadingState label="Finding events for you…" />
        ) : recommended.length === 0 ? (
          <EmptyState
            emoji="🫧"
            title="Nothing to swipe through yet"
            body="No events match you in this radius. Widen it, or be the first to put something on the map."
            actionLabel="Create the first BLUP"
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
          <Text style={styles.mapLoadingText}>Loading events…</Text>
        </View>
      ) : null}

      {selected ? (
        <View style={styles.mapCard}>
          <EventCard event={selected} size="compact" onPress={() => onOpen(selected)} />
        </View>
      ) : events.length === 0 && !loading ? (
        <View style={styles.mapEmpty}>
          <Text style={styles.mapEmptyTitle}>Nothing happening here yet</Text>
          <Body muted style={styles.mapEmptyBody}>
            Be the first — put your event on the map and people nearby will see it.
          </Body>
          <Button title="Create the first BLUP" onPress={() => router.push('/(tabs)/create')} />
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
    return <LoadingState label="Looking around you…" />;
  }

  if (error && all.length === 0) return <ErrorState message={error} onRetry={onRefresh} />;

  if (all.length === 0 && recommended.length === 0) {
    return (
      <EmptyState
        emoji="🫧"
        title="Nothing happening here yet"
        body="No events near you right now. Create the first BLUP and it appears on everyone's map instantly."
        actionLabel="Create the first BLUP"
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
          <SectionHeader title="Today near you" />
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
            <SectionHeader title="For you" />
            {explanationSource && explanationSource !== 'none' ? (
              <Badge
                tone="accent"
                label={explanationSource.startsWith('local') || explanationSource.startsWith('fallback')
                  ? 'Ranked by BLUP'
                  : 'AI explained'}
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

      <SectionHeader title="Everything nearby" />
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
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  greeting: { ...typography.title, color: colors.text },
  subGreeting: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  headerButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerButtonText: { fontSize: 19 },

  modeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  modeChip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  modeChipActive: { backgroundColor: colors.accent },
  modeLabel: { ...typography.caption, color: colors.textSecondary },
  modeLabelActive: { color: colors.textInverse },
  radiusChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceElevated,
  },
  radiusLabel: { ...typography.caption, color: colors.text },

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
