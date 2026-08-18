import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { colors, heroGradient, spacing, typography } from '@/theme';

/**
 * The BLUP wordmark: "Blup" in extra-bold with the dot in accent blue.
 * One component so the logo is identical on every screen that shows it.
 */
export function Wordmark({ size = 48, style }: { size?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.row, style]}>
      <Text style={[styles.word, { fontSize: size, lineHeight: size * 1.15 }]}>Blup</Text>
      <Text style={[styles.dot, { fontSize: size, lineHeight: size * 1.15 }]}>.</Text>
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
  word: { ...typography.logo, color: colors.text },
  dot: { ...typography.logo, color: colors.accent },

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
