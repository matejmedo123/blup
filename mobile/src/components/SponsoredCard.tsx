import React, { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getSponsored, recordBoostEvent } from '@/api/boost';
import { getEventsForCards } from '@/api/events';
import { EventCard } from '@/components/EventCard';
import { useLocation } from '@/hooks/useLocation';
import { eventHref } from '@/lib/format';
import { Mono } from '@/components/ui';
import { colors, spacing } from '@/theme';

/**
 * One sponsored card, in the feed.
 *
 * It renders nothing at all when there is nothing to show — which is most of
 * the time, and deliberately so: with no eligible advertiser the feed is
 * exactly what it was before, rather than a slot with a house ad in it.
 *
 * The impression is recorded when the card is on screen, not when it is
 * fetched. It says SPONZOROVANÉ above the card and the card itself is the
 * ordinary EventCard, so a paid placement looks like what it is — an event
 * somebody paid to show you — rather than like an editorial pick.
 */
export function SponsoredCard({ style }: { style?: object }) {
  const location = useLocation();
  const counted = useRef<string | null>(null);

  const slot = useQuery({
    queryKey: ['sponsored', 'feed'],
    queryFn: () => getSponsored('feed', location.coords, 1),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const boost = slot.data?.[0] ?? null;

  const card = useQuery({
    queryKey: ['sponsored-card', boost?.event_id],
    queryFn: () => getEventsForCards([boost!.event_id], location.coords),
    enabled: Boolean(boost?.event_id),
  });
  const event = { data: card.data?.[0] ?? null };

  useEffect(() => {
    if (!boost || !event.data || counted.current === boost.boost_id) return;
    counted.current = boost.boost_id;
    void recordBoostEvent(boost.boost_id, 'feed', 'impression');
  }, [boost, event.data]);

  if (!boost || !event.data) return null;

  return (
    <View style={[styles.wrap, style]}>
      <Mono style={styles.label}>SPONZOROVANÉ</Mono>
      <EventCard
        event={event.data}
        onPress={() => {
          void recordBoostEvent(boost.boost_id, 'feed', 'click');
          router.push(eventHref(event.data!));
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  label: { color: colors.textTertiary, fontSize: 9, paddingHorizontal: 2 },
});
