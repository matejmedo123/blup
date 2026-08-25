import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getCart } from '@/api/cart';
import { useAuth } from '@/auth/AuthProvider';
import { useLayout } from '@/hooks/useLayout';
import { formatMoney } from '@/lib/format';
import { colors, radius, shadow, spacing, typography } from '@/theme';

/**
 * The basket, where you can see it.
 *
 * It used to be a number in the sidebar: technically present, and missed by
 * everyone. Reserved tickets expire, so a basket nobody notices is a basket
 * that quietly empties itself. This follows you instead — and because the next
 * step after adding a ticket is either "pay" or "keep looking", it asks which.
 *
 * Hidden where it would be in the way: on the basket and checkout screens
 * themselves, and while the basket is empty.
 */
const HAS_CART = Platform.OS === 'web';

export function CartFab() {
  const { isGuest, session } = useAuth();
  const pathname = usePathname();
  const layout = useLayout();
  const [open, setOpen] = useState(false);

  const cart = useQuery({
    queryKey: ['cart', null],
    queryFn: () => getCart(null),
    enabled: HAS_CART && !isGuest && Boolean(session),
    refetchInterval: 60_000,
  });

  const quantity = cart.data?.quantity ?? 0;

  const onCartScreen =
    pathname === '/cart' ||
    pathname.startsWith('/event/checkout') ||
    pathname.startsWith('/order');

  // Signing in and onboarding are not "inside" the app: a basket bubble
  // floating over the sign-in form is noise at the worst possible moment.
  const outsideTheApp =
    pathname.startsWith('/sign-in') ||
    pathname.startsWith('/sign-up') ||
    pathname.startsWith('/forgot-password') ||
    pathname.startsWith('/reset-password') ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/interests') ||
    pathname.startsWith('/location') ||
    pathname === '/profile-setup';

  if (!HAS_CART || quantity === 0 || onCartScreen || outsideTheApp) return null;

  const total = cart.data?.total_cents ?? 0;

  // Home has its own "Vytvor event" button in this corner, and the two were
  // drawn on top of each other. The basket sits above it instead.
  const overFab = pathname === '/' || pathname === '/index';

  return (
    <View
      style={[
        styles.wrapper,
        layout.isDesktop ? styles.wrapperDesktop : styles.wrapperPhone,
        overFab && (layout.isDesktop ? styles.aboveFabDesktop : styles.aboveFabPhone),
      ]}
      pointerEvents="box-none"
    >
      {open ? (
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>
            {quantity} {quantity === 1 ? 'vstupenka' : quantity < 5 ? 'vstupenky' : 'vstupeniek'}
            {total > 0 ? ` · ${formatMoney(total, cart.data?.currency ?? 'EUR')}` : ''}
          </Text>

          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setOpen(false);
              router.push('/cart');
            }}
            style={({ pressed }) => [styles.action, styles.actionPrimary, pressed && styles.pressed]}
          >
            <Text style={styles.actionPrimaryLabel}>Prejsť do pokladne</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={() => setOpen(false)}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          >
            <Text style={styles.actionLabel}>Pokračovať v nákupe</Text>
          </Pressable>
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Košík, ${quantity} vstupeniek`}
        onPress={() => setOpen((current) => !current)}
        style={({ pressed }) => [styles.fab, pressed && styles.pressed]}
      >
        <Text style={styles.fabGlyph}>🛒</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeLabel}>{quantity}</Text>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    right: spacing.lg,
    alignItems: 'flex-end',
    gap: spacing.sm,
    zIndex: 40,
  },
  // Clear of the bottom tab bar on a phone; nothing is down there on a desktop.
  wrapperPhone: { bottom: 92 },
  wrapperDesktop: { bottom: spacing.xl },
  // Clear of the 56px create-event button plus a gap.
  aboveFabPhone: { bottom: 92 + 56 + spacing.md },
  aboveFabDesktop: { bottom: spacing.xl + 56 + spacing.md },

  fab: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.cta,
  },
  fabGlyph: { fontSize: 26 },
  pressed: { opacity: 0.9, transform: [{ scale: 0.98 }] },

  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 24,
    height: 24,
    paddingHorizontal: 6,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeLabel: { ...typography.captionStrong, color: colors.text },

  panel: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
    minWidth: 240,
    ...shadow.cta,
  },
  panelTitle: { ...typography.captionStrong, color: colors.text, marginBottom: spacing.xs },

  action: {
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surfaceElevated2,
  },
  actionPrimary: { backgroundColor: colors.accent },
  actionLabel: { ...typography.captionStrong, color: colors.text },
  actionPrimaryLabel: { ...typography.captionStrong, color: '#FFFFFF' },
});
