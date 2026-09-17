import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, typography } from '@/theme';

/**
 * The mark that somebody pays for BLUP.
 *
 * Small and quiet: it sits next to a name, not over it. It reads from
 * `premium_until`, which the database keeps in sync with the subscription — so
 * a badge cannot outlive the thing it stands for, which is the only way a badge
 * keeps meaning anything.
 *
 * The clock is read once, into state, rather than on every render: reading it
 * during render is impure — two renders of the same props could disagree — and
 * the React Compiler rules say so. Once is also all this needs; a badge that
 * expires while somebody is looking at the screen can wait for the next load.
 */
export function PremiumBadge({
  until,
  size = 'small',
}: {
  until?: string | null;
  size?: 'small' | 'inline';
}) {
  const [mountedAt] = useState(() => Date.now());

  if (!until || new Date(until).getTime() <= mountedAt) return null;

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
