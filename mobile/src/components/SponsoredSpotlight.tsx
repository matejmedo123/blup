import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getSponsored, recordBoostEvent } from '@/api/boost';
import { getEventsForCards } from '@/api/events';
import { useLocation } from '@/hooks/useLocation';
import { GradientCover } from '@/components/GradientCover';
import { eventHref, formatEventDate } from '@/lib/format';
import { Body, Button, Mono } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * The one sponsored card a day that arrives instead of waiting to be scrolled
 * past.
 *
 * Every constraint that makes this bearable is in the database, not here: one
 * a day across every advertiser, never to somebody it does not fit, never to
 * the organizer paying for it, and never past the budget. This component asks
 * once per app start and shows whatever comes back — so there is exactly one
 * place to change the policy, and it is not the client.
 *
 * It is labelled, it closes on the backdrop and on Escape, and closing it is
 * not counted as interest. An ad you cannot get out of is a tax on opening
 * the app.
 */
export function SponsoredSpotlight() {
  const location = useLocation();
  const [dismissed, setDismissed] = useState(false);
  const counted = useRef(false);

  const slot = useQuery({
    queryKey: ['sponsored', 'spotlight'],
    queryFn: () => getSponsored('spotlight', location.coords, 1),
    // Once per app start. Asking again on every screen would turn "one a day"
    // into "one a day, plus whatever races through before it is recorded".
    staleTime: Infinity,
    retry: false,
  });

  const boost = slot.data?.[0] ?? null;

  const card = useQuery({
    queryKey: ['sponsored-card', boost?.event_id],
    queryFn: () => getEventsForCards([boost!.event_id], location.coords),
    enabled: Boolean(boost?.event_id),
  });
  const event = { data: card.data?.[0] ?? null };

  // Counted when it is actually on screen, not when it was fetched. A card
  // nobody saw is not an impression, whatever the ad industry says.
  useEffect(() => {
    if (!boost || !event.data || dismissed || counted.current) return;
    counted.current = true;
    void recordBoostEvent(boost.boost_id, 'spotlight', 'impression');
  }, [boost, event.data, dismissed]);

  if (!boost || !event.data || dismissed) return null;

  const open = () => {
    void recordBoostEvent(boost.boost_id, 'spotlight', 'click');
    setDismissed(true);
    router.push(eventHref(event.data!));
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => setDismissed(true)}>
      <Pressable
        style={styles.backdrop}
        onPress={() => setDismissed(true)}
        accessibilityLabel="Zavrieť"
      >
        <Pressable style={styles.card} onPress={() => {}}>
          <View style={styles.labelRow}>
            <Mono style={styles.label}>SPONZOROVANÉ</Mono>
            <Pressable
              onPress={() => setDismissed(true)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Zavrieť"
            >
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          <GradientCover
            uri={event.data.cover_image_url}
            category={event.data.category}
            height={170}
            style={styles.cover}
          />

          <Text style={styles.title} numberOfLines={2}>{event.data.title}</Text>
          <Body muted>
            {formatEventDate(event.data.start_at)}
            {event.data.city ? ` · ${event.data.city}` : ''}
          </Body>

          <Button title="Pozrieť event" onPress={open} style={styles.cta} />
          <Pressable onPress={() => setDismissed(true)} accessibilityRole="button">
            <Mono style={styles.later}>TERAZ NIE</Mono>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(4,6,10,0.78)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { color: colors.textTertiary, fontSize: 9 },
  close: { ...typography.subheading, color: colors.textSecondary },
  cover: { borderRadius: radius.md, overflow: 'hidden' },
  title: { ...typography.subheading, color: colors.text },
  cta: { marginTop: spacing.sm },
  later: { color: colors.textTertiary, textAlign: 'center', paddingVertical: spacing.sm },
});
