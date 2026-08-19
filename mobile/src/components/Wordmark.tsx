import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { colors, heroGradient, spacing, typography } from '@/theme';

/**
 * The BLUP logo.
 *
 * A wordmark, exactly as supplied: "Blup." set in a heavy rounded face with the
 * full stop in the same colour as the letters. No icon, no coloured dot — the
 * period is part of the word, not decoration.
 *
 * `color` overrides the ink so the same component works on a dark screen, on a
 * gradient, and inverted on a light surface.
 */
export function Wordmark({
  size = 48,
  color = colors.text,
  style,
  textStyle,
}: {
  size?: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}) {
  return (
    <View style={[styles.row, style]}>
      <Text
        accessibilityRole="header"
        accessibilityLabel="Blup"
        style={[
          styles.word,
          {
            fontSize: size,
            lineHeight: size * 1.18,
            // Tracking has to tighten as the mark grows or the letters drift
            // apart from the reference at large sizes.
            letterSpacing: -size * 0.045,
            color,
          },
          textStyle,
        ]}
      >
        Blup.
      </Text>
    </View>
  );
}

/**
 * The square lockup for places a wordmark does not fit — the app icon, an
 * avatar-sized slot. It is the same face and the same period, cropped to the
 * initial; a derivation of the wordmark rather than a second logo.
 */
export function BlupMonogram({
  size = 48,
  color = '#FFFFFF',
  background = colors.accent,
  style,
}: {
  size?: number;
  color?: string;
  background?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        styles.monogram,
        { width: size, height: size, borderRadius: size * 0.28, backgroundColor: background },
        style,
      ]}
    >
      <Text
        style={[
          styles.word,
          {
            fontSize: size * 0.58,
            lineHeight: size * 0.7,
            letterSpacing: -size * 0.03,
            color,
          },
        ]}
      >
        B.
      </Text>
    </View>
  );
}

/**
 * Full-bleed navy → black backdrop used by the auth and onboarding screens,
 * with a soft accent bloom behind the content.
 */
export function HeroBackground({ children }: { children: React.ReactNode }) {
  return (
    <LinearGradient colors={[...heroGradient]} style={styles.hero}>
      <View style={styles.bloom} pointerEvents="none" />
      {children}
    </LinearGradient>
  );
}

/** Small centred tagline under the wordmark. */
export function Tagline({ children }: { children: React.ReactNode }) {
  return <Text style={styles.tagline}>{children}</Text>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end' },
  word: { ...typography.logo },

  monogram: { alignItems: 'center', justifyContent: 'center' },

  hero: { flex: 1 },
  bloom: {
    position: 'absolute',
    top: -140,
    left: -60,
    right: -60,
    height: 340,
    borderRadius: 400,
    backgroundColor: colors.accentSoft,
    opacity: 0.7,
  },

  tagline: {
    ...typography.heading,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.md,
  },
});
