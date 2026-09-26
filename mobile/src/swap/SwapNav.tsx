import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { router } from 'expo-router';

import { CONTENT_MAX } from '@/hooks/useLayout';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Prepínač medzi časťami môjho SWAPu.
 *
 * Štyri obrazovky, nie jedna dlhá: ponuky, predaje, nákupy a peniaze sú štyri
 * rôzne otázky a človek má naraz len jednu. Jedna obrazovka so štyrmi sekciami
 * pod sebou znamená, že k peniazom sa dorolujem cez všetko ostatné.
 *
 * Vlastné trasy, nie stav v jednej obrazovke: na webe sa tak dá poslať odkaz
 * priamo na „predaje" a tlačidlo späť robí, čo má.
 */
const TABS: { href: string; label: string }[] = [
  { href: '/swap/selling', label: 'Moje ponuky' },
  { href: '/swap/sales', label: 'Predaje' },
  { href: '/swap/orders', label: 'Nákupy' },
  { href: '/swap/wallet', label: 'Peniaze' },
];

export function SwapNav({ active }: { active: string }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {TABS.map((tab) => {
        const on = tab.href === active;
        return (
          <Pressable
            key={tab.href}
            onPress={() => { if (!on) router.replace(tab.href as never); }}
            style={[styles.tab, on && styles.tabOn]}
            accessibilityRole="button"
          >
            <Text style={[styles.label, on && styles.labelOn]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: spacing.xs,
    paddingBottom: spacing.md,
    maxWidth: CONTENT_MAX,
    width: '100%',
    alignSelf: 'center',
  },
  tab: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  label: { ...typography.metaSm, color: colors.textSecondary },
  labelOn: { color: '#FFFFFF', fontWeight: '700' },
});
