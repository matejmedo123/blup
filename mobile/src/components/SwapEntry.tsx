import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getSwapHome } from '@/api/swap';
import { SWAP_BRAND } from '@/swap/brand';
import { Caption } from '@/components/ui';
import { formatMoney } from '@/lib/format';
import { CONTENT_MAX } from '@/hooks/useLayout';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Vstup do SWAPu z obrazoviek BLUPu.
 *
 * Na telefóne je spodná lišta plná a šiesta záložka by z nej spravila
 * neprehľadnú kašu. SWAP sa preto ponúka tam, kde na neho človek prirodzene
 * narazí — na domovskej obrazovke a medzi vstupenkami — a nie ako trvalá
 * položka v menu.
 *
 * Kreslí sa LEN keď je čo ponúknuť. Prázdny prúžok „Burza vstupeniek" nad
 * burzou, na ktorej nikto nič nepredáva, je sľub, ktorý sa po kliknutí
 * nesplní — a druhýkrát naň už nikto neklikne.
 */
export function SwapEntry({ compact = false }: { compact?: boolean }) {
  const home = useQuery({
    queryKey: ['swap', 'home'],
    queryFn: () => getSwapHome(1),
    staleTime: 120_000,
  });

  const data = home.data;
  if (!data || data.total_listings === 0) return null;

  const verified = data.families.length > 0
    ? data.verified.length
    : 0;

  return (
    <Pressable
      style={[styles.wrap, compact && styles.compact]}
      accessibilityRole="button"
      onPress={() => router.push('/swap')}
    >
      <View style={styles.glyphBox}>
        <Text style={styles.glyph}>⇄</Text>
      </View>

      <View style={styles.text}>
        <Text style={styles.title}>{SWAP_BRAND}</Text>
        <Caption numberOfLines={1}>
          {data.total_tickets}{' '}
          {data.total_tickets === 1 ? 'vstupenka'
            : data.total_tickets < 5 ? 'vstupenky' : 'vstupeniek'}
          {' od ľudí'}
          {data.from_cents != null
            ? ` · od ${formatMoney(data.from_cents, data.currency ?? 'EUR')}`
            : ''}
        </Caption>
      </View>

      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSoft,
    maxWidth: CONTENT_MAX,
    width: '100%',
    alignSelf: 'center',
  },
  compact: { paddingVertical: spacing.sm },
  glyphBox: {
    width: 38, height: 38, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  glyph: { fontSize: 18, color: '#FFFFFF', fontWeight: '700' },
  text: { flex: 1 },
  title: { ...typography.bodyStrong, color: colors.text, letterSpacing: 0.4 },
  chevron: { fontSize: 22, color: colors.textTertiary },
});
