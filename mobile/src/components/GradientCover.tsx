import React, { useState } from 'react';
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
  whole = false,
  wholeMinRatio = 0.8,
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
  /**
   * Show the whole picture instead of a crop of it.
   *
   * A poster is usually portrait and a card is usually landscape, so a fixed
   * height cuts the poster's top and bottom off — which is the part with the
   * line-up on it. With this on, the cover takes the picture's own proportions
   * (within reason) and nothing is cut away.
   */
  whole?: boolean;
  /** How tall the cover may get when showing the whole picture (w/h). */
  wholeMinRatio?: number;
}) {
  const [start, end] = coverGradientFor(category);
  const [ratio, setRatio] = useState<number | null>(null);

  // Between a tall poster and a wide banner, but never so tall that one card
  // fills the screen: 4:5 is as narrow as a card gets before the list stops
  // reading as a list.
  const wholeRatio = whole && ratio ? Math.min(Math.max(ratio, wholeMinRatio), 1.91) : null;

  return (
    <View
      style={[
        styles.container,
        wholeRatio ? { aspectRatio: wholeRatio } : height ? { height } : null,
        style,
      ]}
    >
      {uri ? (
        <>
          {/* A poster taller than the card's limit letterboxes. Grey bars look
              like a bug; the picture's own colours, blurred, look deliberate. */}
          {whole ? (
            <Image
              source={{ uri }}
              style={[styles.fill, styles.blurred]}
              contentFit="cover"
              blurRadius={24}
              pointerEvents="none"
            />
          ) : null}
          <Image
            source={{ uri }}
            style={styles.fill}
            contentFit={whole ? 'contain' : 'cover'}
            transition={180}
            onLoad={
              whole
                ? (event) => {
                    const { width, height: h } = event.source ?? {};
                    if (width && h) setRatio(width / h);
                  }
                : undefined
            }
          />
        </>
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
        // Bottom only. The top used to be darkened too, to keep the floating
        // back button legible over a photo — but that meant the top third of
        // every poster was dimmed, and the poster is the part with the line-up
        // on it. The controls have their own row above the cover now.
        <LinearGradient
          colors={['transparent', 'transparent', 'rgba(10,13,18,0.92)']}
          locations={[0, 0.45, 1]}
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
  blurred: { opacity: 0.55 },

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
