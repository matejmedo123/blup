import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';

import { colors, coverGradientFor, spacing, typography } from '@/theme';

/**
 * Event cover.
 *
 * With a photo it shows the photo. Without one it draws a gradient chosen
 * deterministically from the event id, overlaid with diagonal stripes — so an
 * event with no picture still looks designed, and the same event always gets
 * the same colours across the feed, the card and the detail screen.
 *
 * `placeholderLabel` is the small monospace caption from the design
 * ("[ foto z eventu ]"), which makes it obvious the image is missing rather
 * than pretending a stock photo is the venue.
 */
export function GradientCover({
  uri,
  seed,
  height,
  placeholderLabel = '[ foto z eventu ]',
  showPlaceholderLabel = true,
  children,
  style,
  stripeOpacity = 0.09,
}: {
  uri?: string | null;
  seed: string;
  height?: number;
  placeholderLabel?: string;
  showPlaceholderLabel?: boolean;
  children?: React.ReactNode;
  style?: object;
  stripeOpacity?: number;
}) {
  const [start, end] = coverGradientFor(seed);

  return (
    <View style={[styles.container, height ? { height } : null, style]}>
      {uri ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={180} />
      ) : (
        <>
          <LinearGradient
            colors={[start, end]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <DiagonalStripes opacity={stripeOpacity} />
          {showPlaceholderLabel ? (
            <Text style={styles.placeholder}>{placeholderLabel}</Text>
          ) : null}
        </>
      )}

      {children}
    </View>
  );
}

/**
 * The diagonal texture. Drawn as rotated bars rather than an image so it scales
 * to any card size and costs nothing to load.
 */
function DiagonalStripes({ opacity }: { opacity: number }) {
  return (
    <View style={styles.stripes} pointerEvents="none">
      {Array.from({ length: 22 }).map((_, index) => (
        <View
          key={index}
          style={[
            styles.stripe,
            { left: index * 34 - 220, backgroundColor: `rgba(255,255,255,${opacity})` },
          ]}
        />
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
  stripes: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' },
  stripe: {
    position: 'absolute',
    top: -400,
    width: 14,
    height: 1200,
    transform: [{ rotate: '35deg' }],
  },
  placeholder: {
    ...typography.mono,
    color: 'rgba(255,255,255,0.8)',
    position: 'absolute',
    left: spacing.lg,
    bottom: spacing.md,
  },
});
