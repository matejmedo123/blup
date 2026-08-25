import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet } from 'react-native';
import { usePathname } from 'expo-router';

import { colors } from '@/theme';

/**
 * A thin blue bar across the top while a screen changes.
 *
 * The navigator's fade tells you the screen is different; it does not tell you
 * anything is happening in between. On a slow connection that gap is where the
 * app looked frozen, and on a fast one the change was so abrupt it read as a
 * slide deck. The bar covers both: it always runs, so a transition looks the
 * same whether the data took 40ms or two seconds.
 *
 * Deliberately not tied to any request. A bar that waits for the network stalls
 * visibly when one query is slow, and this is about the transition, not about
 * the loading — the skeletons already speak for that.
 */
export function RouteProgress() {
  const pathname = usePathname();
  const progress = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const first = useRef(true);

  useEffect(() => {
    // Not on the very first render: an app opening is not a navigation.
    if (first.current) { first.current = false; return; }

    let cancelled = false;

    AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled || reduced) return;

      progress.setValue(0);
      opacity.setValue(1);

      Animated.sequence([
        // Quick to most of the way, then the last stretch slower — the shape
        // of every progress bar people already trust.
        Animated.timing(progress, {
          toValue: 0.75, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: false,
        }),
        Animated.timing(progress, {
          toValue: 1, duration: 220, easing: Easing.out(Easing.quad), useNativeDriver: false,
        }),
        Animated.timing(opacity, {
          toValue: 0, duration: 180, useNativeDriver: false,
        }),
      ]).start();
    }).catch(() => {});

    return () => { cancelled = true; };
  }, [pathname, progress, opacity]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.bar,
        {
          opacity,
          width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    height: 3,
    backgroundColor: colors.accent,
    // Above every screen, below nothing.
    zIndex: 9999,
    ...(Platform.OS === 'web'
      ? { boxShadow: `0 0 12px ${colors.accent}` } as object
      : { shadowColor: colors.accent, shadowOpacity: 0.9, shadowRadius: 8, shadowOffset: { width: 0, height: 0 } }),
  },
});
