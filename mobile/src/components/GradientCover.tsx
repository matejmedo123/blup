import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';

import { colors, coverGradientFor, spacing, typography } from '@/theme';

/**
 * The event cover.
 *
 * With a photo it shows the photo. Without one it draws the category's gradient
 * overlaid with the handoff's 135° hatching, plus the mono placeholder label
 * (`[ foto z eventu ]`) that makes it obvious a real picture is missing rather
 * than pretending a stock photo is the venue.
 *
 * The gradient comes from the event's *category*, not its id — the handoff
 * assigns one gradient per category family, so two techno nights look related.
 */
export function GradientCover({
  uri,
  category,
  height,
  placeholderLabel = '[ foto z eventu ]',
  showPlaceholderLabel = true,
  children,
  style,
  overlay = false,
}: {
  uri?: string | null;
  /** Event category — decides the gradient. */
  category?: string | null;
  height?: number;
  placeholderLabel?: string;
  showPlaceholderLabel?: boolean;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Darkens the bottom so a title sits legibly on top (event hero). */
  overlay?: boolean;
}) {
  const [start, end] = coverGradientFor(category);

  return (
    <View style={[styles.container, height ? { height } : null, style]}>
      {uri ? (
        <Image source={{ uri }} style={styles.fill} contentFit="cover" transition={180} />
      ) : (
        <>
          <LinearGradient
            colors={[start, end]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.fill}
          />
          <Hatching />
          {showPlaceholderLabel ? (
            <Text style={styles.placeholder}>{placeholderLabel}</Text>
          ) : null}
        </>
      )}

      {overlay ? (
        <LinearGradient
          colors={['rgba(6,8,11,0.45)', 'transparent', 'rgba(10,13,18,0.92)']}
          locations={[0, 0.4, 1]}
          style={styles.fill}
          pointerEvents="none"
        />
      ) : null}

      {children}
    </View>
  );
}

/**
 * `repeating-linear-gradient(135deg, rgba(255,255,255,.14) 0 2px, transparent
 * 2px 12px)` — drawn as rotated bars, so it scales to any card and costs
 * nothing to load.
 */
function Hatching() {
  return (
    <View style={styles.hatching} pointerEvents="none">
      {Array.from({ length: 34 }).map((_, index) => (
        <View key={index} style={[styles.bar, { left: index * 17 - 260 }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    backgroundColor: colors.surfaceElevated,
    justifyContent: 'flex-end',
  },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },

  hatching: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' },
  bar: {
    position: 'absolute',
    top: -420,
    width: 2,
    height: 1240,
    backgroundColor: 'rgba(255,255,255,0.14)',
    transform: [{ rotate: '45deg' }],
  },

  placeholder: {
    ...typography.monoSm,
    color: 'rgba(255,255,255,0.72)',
    position: 'absolute',
    left: spacing.lg,
    bottom: spacing.md,
  },
});
