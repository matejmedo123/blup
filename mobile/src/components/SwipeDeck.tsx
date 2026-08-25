import React, { useCallback, useState } from 'react';
import { Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming,
} from 'react-native-reanimated';

import {
  categoryFamilies, colors, familyFor, radius, shadow, spacing, typography,
} from '@/theme';
import { formatCount, formatEventDate, formatPrice } from '@/lib/format';
import type { EventFeedItem } from '@/types/models';
import { CARD_MAX } from '@/hooks/useLayout';
import { GradientCover } from './GradientCover';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
/** The handoff asks for a ~35% threshold. */
const SWIPE_THRESHOLD = SCREEN_WIDTH * 0.35;
/** Fling duration; the deck is locked against further input while it runs. */
const FLING_MS = 260;

export type SwipeDirection = 'left' | 'right' | 'up';

/**
 * The Objav deck.
 *
 * Three layers — two offset cards behind, the live card on top. Right blups,
 * left dismisses, up opens the detail. A real pan gesture drives it (rotation
 * follows x); the three buttons underneath stay as the alternative, as the
 * handoff requires.
 */
export function SwipeDeck({
  events, onSwipe, onExhausted, onReset,
}: {
  events: EventFeedItem[];
  onSwipe: (event: EventFeedItem, direction: SwipeDirection) => void;
  onExhausted?: () => void;
  onReset?: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [locked, setLocked] = useState(false);

  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);

  const advance = useCallback(
    (direction: SwipeDirection) => {
      const current = events[index];
      if (current) onSwipe(current, direction);

      translateX.value = 0;
      translateY.value = 0;
      setLocked(false);

      if (direction === 'up') return; // navigation happens in onSwipe

      setIndex((previous) => {
        const next = previous + 1;
        if (next >= events.length) onExhausted?.();
        return next;
      });
    },
    [events, index, onSwipe, onExhausted, translateX, translateY],
  );

  const lock = useCallback(() => setLocked(true), []);

  const gesture = Gesture.Pan()
    .enabled(!locked)
    .onUpdate((change) => {
      translateX.value = change.translationX;
      translateY.value = change.translationY;
    })
    .onEnd((change) => {
      const { translationX, translationY, velocityX } = change;

      if (translationY < -SWIPE_THRESHOLD && Math.abs(translationX) < SWIPE_THRESHOLD) {
        runOnJS(lock)();
        translateY.value = withTiming(-700, { duration: 180 }, () => {
          runOnJS(advance)('up');
        });
        return;
      }

      if (Math.abs(translationX) > SWIPE_THRESHOLD || Math.abs(velocityX) > 900) {
        const direction: SwipeDirection = translationX > 0 ? 'right' : 'left';
        runOnJS(lock)();
        translateX.value = withTiming(
          translationX > 0 ? SCREEN_WIDTH * 1.3 : -SCREEN_WIDTH * 1.3,
          { duration: FLING_MS },
          () => {
            runOnJS(advance)(direction);
          },
        );
        return;
      }

      translateX.value = withSpring(0, { damping: 18 });
      translateY.value = withSpring(0, { damping: 18 });
    });

  const cardStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { rotate: `${interpolate(translateX.value, [-SCREEN_WIDTH, 0, SCREEN_WIDTH], [-16, 0, 16])}deg` },
    ],
    opacity: interpolate(
      Math.abs(translateX.value),
      [0, SCREEN_WIDTH * 0.9],
      [1, 0],
      'clamp',
    ),
  }));

  const blupStamp = useAnimatedStyle(() => ({
    opacity: interpolate(translateX.value, [0, SWIPE_THRESHOLD], [0, 1], 'clamp'),
  }));

  const nopeStamp = useAnimatedStyle(() => ({
    opacity: interpolate(translateX.value, [-SWIPE_THRESHOLD, 0], [1, 0], 'clamp'),
  }));

  const press = (direction: SwipeDirection) => {
    if (locked) return;

    if (direction === 'up') {
      advance('up');
      return;
    }

    setLocked(true);
    translateX.value = withTiming(
      direction === 'right' ? SCREEN_WIDTH * 1.3 : -SCREEN_WIDTH * 1.3,
      { duration: FLING_MS },
      () => {
        runOnJS(advance)(direction);
      },
    );
  };

  const current = events[index];
  const upcoming = events.slice(index + 1, index + 3);

  if (!current) {
    return (
      <View style={styles.done}>
        <View style={styles.doneCircle}><Text style={styles.doneGlyph}>◉</Text></View>
        <Text style={styles.doneTitle}>Pre dnes hotovo</Text>
        <Text style={styles.doneBody}>
          Prešiel si všetko v okolí. Zajtra pribudnú nové eventy — alebo si prejdi tie, ktoré si
          preskočil.
        </Text>
        {onReset ? (
          <Pressable
            style={styles.doneButton}
            onPress={() => { setIndex(0); onReset(); }}
          >
            <Text style={styles.doneButtonLabel}>Prejsť znova</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.deck}>
        {upcoming.map((event, offset) => (
          <View
            key={event.id}
            style={[
              styles.behind,
              {
                transform: [{ scale: 1 - (upcoming.length - offset) * 0.03 }],
                opacity: offset === 0 ? 0.8 : 0.5,
                top: (upcoming.length - offset) * 8,
              },
            ]}
            pointerEvents="none"
          >
            <DeckCard event={event} />
          </View>
        ))}

        <GestureDetector gesture={gesture}>
          <Animated.View style={[styles.live, cardStyle]}>
            <DeckCard event={current} />

            <Animated.View style={[styles.stamp, styles.stampBlup, blupStamp]} pointerEvents="none">
              <Text style={[styles.stampText, { color: colors.accent }]}>BLUP</Text>
            </Animated.View>

            <Animated.View style={[styles.stamp, styles.stampNope, nopeStamp]} pointerEvents="none">
              <Text style={[styles.stampText, { color: colors.pink }]}>NIE</Text>
            </Animated.View>
          </Animated.View>
        </GestureDetector>
      </View>

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Nezaujíma ma"
          onPress={() => press('left')}
          style={({ pressed }) => [styles.circle, styles.circleNope, pressed && styles.pressed]}
        >
          <Text style={styles.circleGlyph}>✕</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Viac info"
          onPress={() => press('up')}
          style={({ pressed }) => [styles.circle, styles.circleInfo, pressed && styles.pressed]}
        >
          <Text style={[styles.circleGlyph, { color: colors.cyan }]}>↑</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Blupnúť"
          onPress={() => press('right')}
          style={({ pressed }) => [styles.blup, pressed && styles.pressed]}
        >
          <Text style={styles.blupLabel}>BLUP</Text>
        </Pressable>
      </View>

      <Text style={styles.hint}>✕ nezaujíma · ↑ viac info · BLUP uložiť</Text>
    </View>
  );
}

/** The card face — hero 250, title 21/900, description, circles line and price. */
function DeckCard({ event }: { event: EventFeedItem }) {
  const family = categoryFamilies[familyFor(event.category)];

  return (
    <View style={styles.card}>
      <GradientCover
        uri={event.cover_image_url}
        category={event.category}
        height={250}
        whole
        placeholderLabel="[ foto z minulého ročníka ]"
      >
        <View style={styles.cardBadges}>
          <View style={styles.glass}>
            <Text style={styles.glassLabel}>{family.label}</Text>
          </View>
        </View>
      </GradientCover>

      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} numberOfLines={2}>{event.title}</Text>
        <Text style={styles.cardMeta} numberOfLines={1}>
          {formatEventDate(event.start_at)}
          {event.venue_name ? ` · ${event.venue_name}` : ''}
        </Text>

        {event.description ? (
          <Text style={styles.cardDescription} numberOfLines={3}>{event.description}</Text>
        ) : null}

        <View style={styles.cardFooter}>
          <Text style={styles.cardGoing}>
            {event.friends_going > 0
              ? `${event.friends_going} z tvojich kruhov ide`
              : `${formatCount(event.attendee_count)} ide`}
          </Text>
          <View style={styles.price}>
            <Text style={styles.priceLabel}>
              {event.is_free ? 'Zdarma' : formatPrice(event.price_cents, event.currency)}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center' },
  // One card, centred and card-shaped. Stretched across a desktop window it
  // stopped looking like something you swipe.
  deck: {
    justifyContent: 'center',
    paddingHorizontal: spacing.gutter,
    width: '100%',
    maxWidth: CARD_MAX + spacing.gutter * 2,
    alignSelf: 'center',
  },
  behind: { position: 'absolute', left: spacing.gutter, right: spacing.gutter },
  live: {},

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.swipe,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardBadges: { position: 'absolute', top: spacing.lg, left: spacing.lg, flexDirection: 'row', gap: spacing.sm },
  glass: {
    backgroundColor: colors.overlay,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 11,
  },
  glassLabel: { ...typography.micro, color: colors.text },

  cardBody: { padding: spacing.lg, gap: spacing.sm },
  cardTitle: { ...typography.swipeTitle, color: colors.text },
  cardMeta: { ...typography.metaSm, color: colors.textTertiary },
  cardDescription: { ...typography.caption, color: colors.textSecondary },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  cardGoing: { ...typography.metaSm, color: colors.accentText, flex: 1 },
  price: {
    backgroundColor: colors.surfaceElevated2,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 11,
  },
  priceLabel: { ...typography.micro, color: colors.text },

  stamp: {
    position: 'absolute',
    top: 24,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.block,
    borderWidth: 3,
    backgroundColor: colors.overlay,
  },
  stampBlup: { right: spacing.xxl, borderColor: colors.accent, transform: [{ rotate: '12deg' }] },
  stampNope: { left: spacing.xxl, borderColor: colors.pink, transform: [{ rotate: '-12deg' }] },
  stampText: { ...typography.button, letterSpacing: 1.5 },

  actions: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.xxl,
    marginTop: spacing.xxl,
  },
  circle: { alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  circleNope: {
    width: 58,
    height: 58,
    borderRadius: 29,
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  circleInfo: {
    width: 50,
    height: 50,
    borderRadius: 25,
    borderColor: 'rgba(34, 211, 238, 0.4)',
    backgroundColor: colors.cyanSoft,
  },
  circleGlyph: { fontSize: 22, color: colors.textTertiary },
  pressed: { opacity: 0.8, transform: [{ scale: 0.95 }] },

  blup: {
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.glow,
  },
  blupLabel: { ...typography.micro, fontSize: 13, color: '#FFFFFF', letterSpacing: 0.5 },

  hint: {
    ...typography.metaSm,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.lg,
  },

  done: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl, gap: spacing.lg },
  doneCircle: {
    width: 74,
    height: 74,
    borderRadius: 37,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneGlyph: { fontSize: 30, color: colors.accent },
  doneTitle: { ...typography.heading, color: colors.text },
  doneBody: {
    ...typography.body,
    color: colors.textTertiary,
    textAlign: 'center',
    maxWidth: 280,
  },
  doneButton: {
    height: 50,
    paddingHorizontal: spacing.xxl,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceElevated2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneButtonLabel: { ...typography.buttonSm, color: colors.text },
});
