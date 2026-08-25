import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View, type ViewStyle } from 'react-native';

import { colors, radius, spacing } from '@/theme';

/**
 * Placeholders shaped like the thing that is loading.
 *
 * A spinner in the middle of an empty screen says "wait" and nothing else, so
 * every navigation looked like a stall — the screen emptied, a circle turned,
 * and the content appeared all at once. A block where the picture will be and
 * two bars where the text will be says the same wait is progress, and the
 * arrival is a fill rather than a jump.
 *
 * The pulse is opacity only: no layout, no shadow, nothing the compositor has
 * to re-measure. And it stops entirely when the viewer has asked for reduced
 * motion, where a pulsing screen is the problem rather than the polish.
 */
export function Skeleton({
  width,
  height,
  radius: r = radius.sm,
  style,
}: {
  width?: number | `${number}%`;
  height: number;
  radius?: number;
  style?: ViewStyle;
}) {
  const pulse = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    let cancelled = false;
    let loop: Animated.CompositeAnimation | null = null;

    AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled || reduced) return;
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, {
            toValue: 0.9, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true,
          }),
          Animated.timing(pulse, {
            toValue: 0.45, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true,
          }),
        ]),
      );
      loop.start();
    }).catch(() => {
      // An environment that cannot answer gets the still version, not a crash.
    });

    return () => { cancelled = true; loop?.stop(); };
  }, [pulse]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width: width ?? '100%',
          height,
          borderRadius: r,
          // Blue, not grey: the pulse should read as the app's own colour
          // arriving, the same blue the transition bar uses.
          backgroundColor: colors.accentSoft,
          borderWidth: 1,
          borderColor: colors.accentBorder,
          opacity: pulse,
        },
        style,
      ]}
    />
  );
}

/** The shape of one event card in the feed. */
export function EventCardSkeleton() {
  return (
    <View style={styles.card}>
      <Skeleton height={150} radius={radius.lg} />
      <View style={styles.lines}>
        <Skeleton height={16} width="72%" />
        <Skeleton height={12} width="45%" />
      </View>
    </View>
  );
}

/** A short list of them, for a feed that has not arrived yet. */
export function EventListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <View style={styles.list}>
      {Array.from({ length: count }, (_, i) => <EventCardSkeleton key={i} />)}
    </View>
  );
}

/** The shape of a detail screen: hero, title, two lines, a button. */
export function DetailSkeleton() {
  return (
    <View style={styles.detail}>
      <Skeleton height={220} radius={radius.lg} />
      <Skeleton height={22} width="66%" />
      <Skeleton height={13} width="40%" />
      <Skeleton height={13} width="52%" />
      <Skeleton height={50} radius={radius.md} style={styles.detailCta} />
    </View>
  );
}

const styles = StyleSheet.create({
  // The same gutter the real cards sit in. Without it the placeholders ran
  // edge to edge and the content visibly jumped inwards as it arrived, which
  // is the jolt these are here to remove.
  list: { gap: spacing.lg, paddingTop: spacing.sm, paddingHorizontal: spacing.gutter },
  card: { gap: spacing.sm },
  lines: { gap: spacing.xs },
  detail: { gap: spacing.md, paddingTop: spacing.sm },
  detailCta: { marginTop: spacing.sm, maxWidth: 360, alignSelf: 'center', width: '100%' },
});
