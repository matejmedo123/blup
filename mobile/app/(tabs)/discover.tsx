import { eventHref } from '@/lib/format';
import { EventListSkeleton, DetailSkeleton } from '@/components/Skeleton';
import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useLocation } from '@/hooks/useLocation';
import { getFeedEvents, saveEvent, unsaveEvent } from '@/api/events';
import { useRequireAuth } from '@/auth/useRequireAuth';
import { recordSignal } from '@/api/signals';
import { messageFor } from '@/lib/errors';
import { SwipeDeck, type SwipeDirection } from '@/components/SwipeDeck';
import { useToast } from '@/components/Toast';
import { ErrorState, LoadingState, Notice } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';
import type { EventFeedItem } from '@/types/models';

/**
 * Objav — the swipe deck.
 *
 * Right blups the event (and it leaves the deck), left records a dismissal that
 * suppresses it from future recommendations, up opens the detail. Every swipe
 * is a behavioural signal for the ranker, so the deck teaches the feed.
 */
export default function DiscoverScreen() {
  const { requireAuth } = useRequireAuth();
  const location = useLocation();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState(0);

  const nearby = useQuery({
    queryKey: ['events', 'deck', location.coords, session],
    queryFn: () =>
      getFeedEvents({
        latitude: location.coords?.latitude,
        longitude: location.coords?.longitude,
        radiusM: 50000,
        limit: 40,
      }),
  });

  // Anything already saved is out of the deck — the handoff has blupped events
  // disappear from it.
  const deck = useMemo(
    () => (nearby.data ?? []).filter((event) => !event.is_saved),
    [nearby.data],
  );

  const savedCount = useMemo(
    () => (nearby.data ?? []).filter((event) => event.is_saved).length,
    [nearby.data],
  );

  const handleSwipe = useCallback(
    async (event: EventFeedItem, direction: SwipeDirection) => {
      setError(null);

      if (direction === 'up') {
        void recordSignal(event.id, 'open_detail');
        router.push(eventHref(event));
        return;
      }

      if (direction === 'right') {
        // Swiping right keeps the event, which needs somewhere to keep it.
        if (!requireAuth('Blupnuté eventy sa ukladajú k tvojmu účtu.', () => {})) return;
        try {
          await saveEvent(event.id);
          await recordSignal(event.id, 'swipe_right');
          toast.show('Blupnuté, uložené do Ja');
          void queryClient.invalidateQueries({ queryKey: ['events'] });
        } catch (caught) {
          setError(messageFor(caught));
        }
        return;
      }

      await recordSignal(event.id, 'swipe_left');
    },
    [queryClient, toast, requireAuth],
  );

  if (nearby.isLoading) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <EventListSkeleton count={3} />
      </SafeAreaView>
    );
  }

  if (nearby.isError) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <ErrorState message={messageFor(nearby.error)} onRetry={() => void nearby.refetch()} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.flex}>
          <Text style={styles.title}>Blupni si program</Text>
          <Text style={styles.subtitle}>
            {deck.length === 0
              ? 'Zatiaľ nič nové v okolí'
              : `${deck.length} ${deck.length === 1 ? 'event' : deck.length < 5 ? 'eventy' : 'eventov'} na dnes v okolí`}
          </Text>
        </View>

        <View style={styles.counter}>
          <Text style={styles.counterLabel}>{savedCount} BLUPOV</Text>
        </View>
      </View>

      {error ? <Notice tone="danger" title="Toto sa nepodarilo" body={error} /> : null}

      <SwipeDeck
        events={deck}
        onSwipe={handleSwipe}
        onReset={() => {
          // A fresh session re-queries, which brings back everything that was
          // only dismissed locally.
          setSession((value) => value + 1);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },
  title: { ...typography.screenTitle, color: colors.text },
  subtitle: { ...typography.metaSm, color: colors.textTertiary, marginTop: 3 },

  counter: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.chip,
    backgroundColor: colors.accentSoft,
  },
  counterLabel: { ...typography.monoSm, color: colors.accent },
});
