import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, typography } from '@/theme';

/**
 * The mark that somebody pays for BLUP.
 *
 * Small and quiet: it sits next to a name, not over it. It reads from
 * `premium_until`, which the database keeps in sync with the subscription — so
 * a badge cannot outlive the thing it stands for, which is the only way a badge
 * keeps meaning anything.
 */
export function PremiumBadge({
  until,
  size = 'small',
}: {
  until?: string | null;
  size?: 'small' | 'inline';
}) {
  if (!until || new Date(until).getTime() <= Date.now()) return null;

  return (
    <View style={[styles.badge, size === 'inline' && styles.badgeInline]}>
      <Text style={styles.star}>✦</Text>
      {size === 'small' ? <Text style={styles.label}>PREMIUM</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.45)',
  },
  badgeInline: { paddingHorizontal: 4 },
  star: { color: '#FBBF24', fontSize: 10, lineHeight: 14 },
  label: { ...typography.mono, fontSize: 8, color: '#FBBF24' },
});
