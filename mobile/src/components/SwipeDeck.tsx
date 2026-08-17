import React, { useCallback, useState } from 'react';
import { Dimensions, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming,
} from 'react-native-reanimated';

import { colors, radius, spacing, typography } from '@/theme';
import type { EventFeedItem } from '@/types/models';
import { EventCard } from './EventCard';
import { Body, Button } from './ui';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const SWIPE_THRESHOLD = SCREEN_WIDTH * 0.28;

export type SwipeDirection = 'left' | 'right' | 'up';

/**
 * BeReal/Tinder-style deck (spec §9).
 *   right → interested / save
 *   left  → not interested (suppressed from future recommendations)
 *   up    → open the detail screen
 *
 * Every swipe is reported to the caller, which records it as a behavioural
 * signal that feeds the ranker.
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

  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);

  const advance = useCallback(
    (direction: SwipeDirection) => {
      const current = events[index];
      if (current) onSwipe(current, direction);

      translateX.value = 0;
      translateY.value = 0;

      if (direction === 'up') return; // navigation happens in onSwipe

      setIndex((previous) => {
        const next = previous + 1;
        if (next >= events.length) onExhausted?.();
        return next;
      });
    },
    [events, index, onSwipe, onExhausted, translateX, translateY],
  );

  const gesture = Gesture.Pan()
    .onUpdate((changeEvent) => {
      translateX.value = changeEvent.translationX;
      translateY.value = changeEvent.translationY;
    })
    .onEnd((changeEvent) => {
      const { translationX, translationY, velocityX } = changeEvent;

      if (translationY < -SWIPE_THRESHOLD && Math.abs(translationX) < SWIPE_THRESHOLD) {
        translateY.value = withTiming(-600, { duration: 180 }, () => {
          runOnJS(advance)('up');
        });
        return;
      }

      if (Math.abs(translationX) > SWIPE_THRESHOLD || Math.abs(velocityX) > 900) {
        const direction: SwipeDirection = translationX > 0 ? 'right' : 'left';
        translateX.value = withTiming(
          translationX > 0 ? SCREEN_WIDTH * 1.5 : -SCREEN_WIDTH * 1.5,
          { duration: 200 },
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
      { rotate: `${interpolate(translateX.value, [-SCREEN_WIDTH, 0, SCREEN_WIDTH], [-9, 0, 9])}deg` },
    ],
  }));

  const likeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateX.value, [0, SWIPE_THRESHOLD], [0, 1], 'clamp'),
  }));

  const nopeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateX.value, [-SWIPE_THRESHOLD, 0], [1, 0], 'clamp'),
  }));

  const current = events[index];
  const upcoming = events[index + 1];

  if (!current) {
    return (
      <View style={styles.done}>
        <Text style={styles.doneEmoji}>🎉</Text>
        <Body style={styles.doneTitle}>That is everything nearby</Body>
        <Body muted style={styles.doneBody}>
          You have been through every event in range. Widen the radius or check back later.
        </Body>
        {onReset ? <Button title="Start over" variant="secondary" onPress={() => { setIndex(0); onReset(); }} /> : null}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {upcoming ? (
        <View style={[styles.cardWrapper, styles.behind]} pointerEvents="none">
          <EventCard event={upcoming} showScore />
        </View>
      ) : null}

      <GestureDetector gesture={gesture}>
        <Animated.View style={[styles.cardWrapper, cardStyle]}>
          <EventCard event={current} showScore />

          <Animated.View style={[styles.stamp, styles.stampLike, likeStyle]} pointerEvents="none">
            <Text style={[styles.stampText, { color: colors.success }]}>INTERESTED</Text>
          </Animated.View>

          <Animated.View style={[styles.stamp, styles.stampNope, nopeStyle]} pointerEvents="none">
            <Text style={[styles.stampText, { color: colors.danger }]}>NOT FOR ME</Text>
          </Animated.View>
        </Animated.View>
      </GestureDetector>

      <View style={styles.hint}>
        <Text style={styles.hintText}>← skip</Text>
        <Text style={styles.hintText}>↑ open</Text>
        <Text style={styles.hintText}>save →</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center' },
  cardWrapper: { paddingHorizontal: spacing.lg },
  behind: { position: 'absolute', left: 0, right: 0, transform: [{ scale: 0.94 }], opacity: 0.5 },

  stamp: {
    position: 'absolute',
    top: 40,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 3,
    backgroundColor: colors.overlay,
  },
  stampLike: { left: spacing.xxl, borderColor: colors.success, transform: [{ rotate: '-12deg' }] },
  stampNope: { right: spacing.xxl, borderColor: colors.danger, transform: [{ rotate: '12deg' }] },
  stampText: { ...typography.bodyStrong, letterSpacing: 1 },

  hint: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xxl,
    marginTop: spacing.xl,
  },
  hintText: { ...typography.caption, color: colors.textTertiary },

  done: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  doneEmoji: { fontSize: 44 },
  doneTitle: { ...typography.heading, color: colors.text },
  doneBody: { textAlign: 'center', marginBottom: spacing.lg },
});
