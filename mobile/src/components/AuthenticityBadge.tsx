import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { Authenticity } from '@/api/resale';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Štítok, ktorý hovorí, čo o vstupenke naozaj vieme.
 *
 * Je to jedna komponenta a berie hodnotu zo servera preto, aby sa to nikde v
 * appke nedalo napísať inak. Keby si každá obrazovka rozhodovala sama, skôr
 * či neskôr by niekde nad vstupenkou z Ticketportalu svietilo „overené" — a
 * to by bola lož, za ktorú by zaplatil kupujúci.
 *
 * Rozdiel medzi tými dvoma je celý zmysel burzy:
 *
 *   overená    vydal ju BLUP. Pri predaji sa prepíše majiteľ a starý QR
 *              prestane platiť. Toto vieme podložiť a test to dokazuje.
 *
 *   chránená   z inej platformy. Do ich databázy nevidíme, takže pravosť
 *              overiť nevieme a netvárime sa, že vieme. Držíme peniaze, kým
 *              kupujúci nepotvrdí, že vstupenka funguje.
 */
export function AuthenticityBadge({
  authenticity,
  size = 'm',
}: {
  authenticity: Authenticity;
  size?: 's' | 'm';
}) {
  const verified = authenticity === 'verified';
  return (
    <View
      style={[
        styles.badge,
        size === 's' && styles.badgeSmall,
        verified ? styles.verified : styles.protected,
      ]}
    >
      <Text style={[styles.glyph, size === 's' && styles.glyphSmall]}>
        {verified ? '✓' : '⛨'}
      </Text>
      <Text
        style={[
          styles.label,
          size === 's' && styles.labelSmall,
          verified ? styles.verifiedLabel : styles.protectedLabel,
        ]}
      >
        {verified ? 'Overená BLUP vstupenka' : 'Chránená platba'}
      </Text>
    </View>
  );
}

/**
 * Celá veta pod štítkom. Krátky štítok sám nestačí — „chránená platba" bez
 * vysvetlenia si človek ľahko prečíta ako „overená", čo je presne to
 * nedorozumenie, ktorému sa treba vyhnúť.
 */
export function authenticityExplainer(authenticity: Authenticity): string {
  return authenticity === 'verified'
    ? 'Vstupenku vydal BLUP. Po zaplatení ju prepíšeme na teba a pôvodný QR kód '
      + 'prestane platiť, takže sa s ním nikto iný dnu nedostane.'
    : 'Vstupenka je z inej platformy, takže jej pravosť overiť nevieme. '
      + 'Peniaze držíme, kým nepotvrdíš, že funguje — ak nie, vrátime ti ich.';
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  badgeSmall: { paddingHorizontal: 8, paddingVertical: 3, gap: 4 },

  // Zelená je tu zaslúžená: za ňou je overiteľný fakt.
  verified: {
    backgroundColor: 'rgba(34, 197, 94, 0.12)',
    borderColor: 'rgba(34, 197, 94, 0.45)',
  },
  // Modrá, nie zelená. Ochrana peňazí je dobrá vec, ale nie je to overenie a
  // nesmie tak vyzerať.
  protected: {
    backgroundColor: 'rgba(0, 128, 255, 0.12)',
    borderColor: 'rgba(0, 128, 255, 0.45)',
  },

  glyph: { fontSize: 13, color: colors.textSecondary },
  glyphSmall: { fontSize: 11 },
  label: { ...typography.metaSm, fontWeight: '700' },
  labelSmall: { fontSize: 11 },
  verifiedLabel: { color: '#22C55E' },
  protectedLabel: { color: colors.accent },
});
