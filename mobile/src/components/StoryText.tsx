import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { StoryOverlay } from '@/api/stories';
import { colors, spacing, typography } from '@/theme';

/**
 * Text written over a story.
 *
 * Drawn over the media rather than baked into it, which is why it works the
 * same over a photo and over a playing video, stays readable to a screen
 * reader, and can be corrected without re-encoding anything.
 *
 * The shadow is not decoration: white text on a photo is unreadable often
 * enough that it has to be there, and it is what lets any of the five colours
 * sit on any picture.
 */
const COLOURS = {
  white:  '#FFFFFF',
  black:  '#0A0D12',
  accent: colors.accent,
  pink:   colors.pink,
  amber:  '#FBBF24',
} as const;

export function StoryText({ overlay }: { overlay: StoryOverlay }) {
  const text = overlay.text?.trim();
  if (!text) return null;

  // 0 is the top, 1 the bottom. Clamped away from both edges so a story is
  // never written under the header or off the bottom of the screen.
  const y = Math.min(0.88, Math.max(0.08, typeof overlay.y === 'number' ? overlay.y : 0.5));
  const colour = COLOURS[overlay.color ?? 'white'] ?? COLOURS.white;

  return (
    <View style={[styles.wrap, { top: `${y * 100}%` }]} pointerEvents="none">
      <Text
        style={[
          styles.text,
          { color: colour },
          overlay.size === 's' && styles.small,
          overlay.size === 'l' && styles.large,
          // Black text needs a light shadow to survive a dark photo; every
          // other colour needs a dark one.
          overlay.color === 'black' && styles.onLight,
        ]}
      >
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, paddingHorizontal: spacing.lg },
  text: {
    ...typography.subheading,
    fontSize: 26,
    lineHeight: 32,
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  small: { fontSize: 18, lineHeight: 24 },
  large: { fontSize: 36, lineHeight: 42 },
  onLight: { textShadowColor: 'rgba(255,255,255,0.65)' },
});
