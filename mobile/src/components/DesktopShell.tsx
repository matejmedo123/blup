import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Link, usePathname, router } from 'expo-router';

import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import { getCart } from '@/api/cart';
import { getUnreadMessageCount } from '@/api/messages';
import { SIDEBAR_WIDTH } from '@/hooks/useLayout';
import { Avatar, Button } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * The desktop chrome: a persistent sidebar instead of a bottom tab bar.
 *
 * A bottom bar exists because a thumb reaches the bottom of a phone. On a
 * desktop there is no thumb and no bottom — the same five items belong down the
 * side, where they are always visible and never cover content. Everything below
 * the navigation is the same screen the phone renders; only the frame changes.
 */

/**
 * react-native-web adds `hovered` to the Pressable state callback; React
 * Native's own types do not have it. A pointer is the main way a desktop user
 * navigates, so the hover state is worth this one narrow cast.
 */
const isHovered = (state: { pressed: boolean }): boolean =>
  Boolean((state as { hovered?: boolean }).hovered);

interface NavItem {
  href: string;
  label: string;
  glyph: string;
  badge?: number;
}

/**
 * A real anchor, not a button that navigates: on a desktop people middle-click
 * and right-click their navigation, and only an `<a href>` honours either.
 *
 * The row layout lives on a View *inside* the link rather than on the link
 * itself — `Link` brings its own style and wins, which is how the glyphs ended
 * up stacked above their labels instead of beside them.
 */
function NavLink({
  item, active, collapsed = false,
}: {
  item: NavItem;
  active: boolean;
  /** Glyph only, with the label as a tooltip. */
  collapsed?: boolean;
}) {
  const [hovered, setHovered] = React.useState(false);

  return (
    <Link
      href={item.href as never}
      accessibilityRole="link"
      accessibilityState={{ selected: active }}
      style={styles.linkReset}
      // A glyph on its own says little; the browser's own tooltip fills in.
      {...({ title: collapsed ? item.label : undefined } as object)}
    >
      <View
        // react-native-web forwards mouse events on any View; Link's own props
        // are typed for React Native, which has no pointer.
        {...({
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
        } as object)}
        style={[
          styles.link,
          collapsed && styles.linkCollapsed,
          hovered && styles.linkHovered,
          active && styles.linkActive,
        ]}
      >
        <Text style={[styles.glyph, active && styles.glyphActive]}>{item.glyph}</Text>
        {collapsed ? null : (
          <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
            {item.label}
          </Text>
        )}
        {item.badge ? (
          <View style={[styles.badge, collapsed && styles.badgeCollapsed]}>
            <Text style={styles.badgeText}>{item.badge > 99 ? '99+' : item.badge}</Text>
          </View>
        ) : null}
      </View>
    </Link>
  );
}

/** Remembered per browser, so the choice survives a reload. */
const COLLAPSED_KEY = 'blup.sidebar.collapsed';

function readCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(COLLAPSED_KEY) === 'yes';
  } catch {
    // A private window that refuses storage is not a reason to fail to render.
    return false;
  }
}

/**
 * localStorage as an external store, so React can read it the way it reads any
 * other one. `storage` fires in *other* tabs, so the local write notifies
 * explicitly — otherwise collapsing the sidebar in this tab would be the one
 * change nobody was told about.
 */
const collapsedListeners = new Set<() => void>();

function subscribeCollapsed(onChange: () => void): () => void {
  collapsedListeners.add(onChange);
  globalThis.addEventListener?.('storage', onChange);
  return () => {
    collapsedListeners.delete(onChange);
    globalThis.removeEventListener?.('storage', onChange);
  };
}

function writeCollapsed(next: boolean): void {
  try {
    globalThis.localStorage?.setItem(COLLAPSED_KEY, next ? 'yes' : 'no');
  } catch {
    /* not remembered; the notification below still collapses it for this visit */
  }
  for (const listener of collapsedListeners) listener();
}

export function DesktopShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { profile, isAdmin, isGuest } = useAuth();

  /**
   * The sidebar can be put away.
   *
   * It opens with the app — navigation you cannot see is navigation you do not
   * use — but it is 244px of a monitor that a map, a seat plan or a long
   * document would rather have. Collapsed it keeps the glyphs, so it is still
   * navigation and not a mystery strip.
   *
   * Read after mount, not during the first render: on a static export the
   * first paint happens on the server, where there is no localStorage, and
   * reading it during render makes the markup disagree with the browser's.
   */
  // Read as an external store rather than copied into state by an effect on
  // mount. Same protection against the build-time snapshot disagreeing with the
  // browser — that is what the third argument is for — without the extra render
  // the effect cost, and without a second copy of the truth to keep in step.
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);

  const toggle = () => writeCollapsed(!collapsed);

  // The shell frames every screen, not just the tabs, so the badges belong to
  // it rather than to whichever layout happens to be mounted underneath.
  const { data: unread = 0 } = useQuery({
    queryKey: ['messages', 'unread'],
    queryFn: getUnreadMessageCount,
    refetchInterval: 60_000,
    enabled: !isGuest,
  });

  // The basket badge is the only nav item that carries a number the visitor is
  // on a clock for, so it refetches on focus rather than sitting stale.
  const cart = useQuery({
    queryKey: ['cart', null],
    queryFn: () => getCart(null),
    enabled: !isGuest,
    refetchOnWindowFocus: true,
  });

  const primary: NavItem[] = [
    { href: '/', label: 'Domov', glyph: '◉' },
    { href: '/discover', label: 'Objav', glyph: '◈' },
    { href: '/feed', label: 'Feed', glyph: '☰' },
    { href: '/messages', label: 'Chat', glyph: '✉', badge: unread },
    { href: '/(tabs)/profile', label: isGuest ? 'Účet' : 'Ja', glyph: '☺' },
  ];

  // A guest sees the parts that work without an account. Listing "Vstupenky"
  // to somebody who cannot have any is a menu item that only leads to a wall.
  const secondary: NavItem[] = isGuest
    ? [{ href: '/community', label: 'Komunity', glyph: '◇' }]
    : [
        { href: '/community', label: 'Komunity', glyph: '◇' },
        ...((cart.data?.quantity ?? 0) > 0
          ? [{ href: '/cart', label: 'Košík', glyph: '⛒', badge: cart.data!.quantity }]
          : []),
        { href: '/tickets', label: 'Vstupenky', glyph: '🎫' },
        { href: '/activity', label: 'Aktivita', glyph: '🔔' },
        { href: '/organizer', label: 'Organizátor', glyph: '◆' },
        ...(isAdmin ? [{ href: '/admin', label: 'Admin', glyph: '⚙' }] : []),
      ];

  // `/` must match exactly or every route would light it up.
  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href.replace('/', ''));

  return (
    <View style={styles.shell}>
      <View style={[styles.sidebar, collapsed && styles.sidebarCollapsed]}>
        <View style={[styles.brandRow, collapsed && styles.brandRowCollapsed]}>
          {collapsed ? null : (
            <Pressable
              onPress={() => router.push('/')}
              accessibilityRole="link"
              accessibilityLabel="Blup — domov"
              style={styles.brand}
            >
              <Text style={styles.wordmark}>
                Blup<Text style={styles.dot}>.</Text>
              </Text>
            </Pressable>
          )}

          <Pressable
            onPress={toggle}
            accessibilityRole="button"
            accessibilityLabel={collapsed ? 'Rozbaliť menu' : 'Zbaliť menu'}
            style={(state) => [styles.collapseButton, isHovered(state) && styles.linkHovered]}
          >
            <Text style={styles.collapseGlyph}>{collapsed ? '»' : '«'}</Text>
          </Pressable>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.navScroll}>
          <View style={styles.group}>
            {primary.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={isActive(item.href)}
                collapsed={collapsed}
              />
            ))}
          </View>

          <View style={styles.divider} />

          <View style={styles.group}>
            {secondary.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={isActive(item.href)}
                collapsed={collapsed}
              />
            ))}
          </View>
        </ScrollView>

        {isGuest && !collapsed ? (
          <View style={styles.guest}>
            <Text style={styles.guestTitle}>Prezeráš ako hosť</Text>
            <Text style={styles.guestBody}>
              Účet potrebuješ, až keď si budeš chcieť kúpiť lístok alebo niekomu napísať.
            </Text>
            <Button title="Prihlásiť sa" compact onPress={() => router.push('/(auth)/sign-in')} />
          </View>
        ) : isGuest ? null : (
          <Pressable
            onPress={() => router.push('/settings')}
            accessibilityRole="link"
            style={(state) => [
              styles.me,
              collapsed && styles.meCollapsed,
              isHovered(state) && styles.linkHovered,
            ]}
          >
            <Avatar name={profile?.display_name ?? profile?.username ?? '·'} url={profile?.avatar_url} size={32} />
            {collapsed ? null : (
            <View style={styles.meText}>
              <Text style={styles.meName} numberOfLines={1}>
                {profile?.display_name ?? 'Ja'}
              </Text>
              <Text style={styles.meHandle} numberOfLines={1}>
                {profile?.username ? `@${profile.username}` : 'Nastavenia'}
              </Text>
            </View>
            )}
          </Pressable>
        )}
      </View>

      <View style={styles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, flexDirection: 'row', backgroundColor: colors.background },

  sidebar: {
    width: SIDEBAR_WIDTH,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    backgroundColor: colors.backgroundElevated,
    paddingVertical: spacing.xl,
    // The sidebar never scrolls with the page — it is the frame, not content.
    ...(Platform.OS === 'web' ? ({ position: 'sticky', top: 0, height: '100vh' } as object) : null),
  },
  sidebarCollapsed: { width: 68 },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: spacing.md,
    paddingBottom: spacing.xl,
  },
  brandRowCollapsed: { justifyContent: 'center', paddingRight: 0 },
  brand: { paddingHorizontal: spacing.xl },
  collapseButton: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  collapseGlyph: { ...typography.captionStrong, color: colors.textSecondary, fontSize: 15 },
  linkCollapsed: { justifyContent: 'center', paddingHorizontal: 0 },
  badgeCollapsed: { position: 'absolute', top: 4, right: 8 },
  meCollapsed: { justifyContent: 'center' },
  wordmark: { ...typography.logo, fontSize: 28, color: colors.text, letterSpacing: -1.2 },
  dot: { color: colors.accent },

  navScroll: { paddingHorizontal: spacing.md, gap: spacing.xs },
  group: { gap: 2 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md, marginHorizontal: spacing.sm },

  linkReset: { textDecorationLine: 'none' },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderRadius: radius.block,
  },
  linkHovered: { backgroundColor: colors.surfaceElevated },
  linkPressed: { backgroundColor: colors.surfacePressed },
  linkActive: { backgroundColor: colors.accentSoft },
  glyph: { fontSize: 16, width: 22, textAlign: 'center', color: colors.textTertiary },
  glyphActive: { color: colors.accent },
  label: { ...typography.bodyStrong, fontSize: 14.5, color: colors.textSecondary, flex: 1 },
  labelActive: { color: colors.accent },

  badge: {
    minWidth: 20,
    paddingHorizontal: 6,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { ...typography.tabLabel, fontSize: 10, color: '#FFFFFF' },

  me: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.md,
    marginHorizontal: spacing.md,
    padding: spacing.md,
    borderRadius: radius.block,
  },
  meText: { flex: 1 },
  meName: { ...typography.bodyStrong, fontSize: 13.5, color: colors.text },
  meHandle: { ...typography.caption, fontSize: 11.5, color: colors.textQuaternary },

  guest: {
    margin: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.block,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    gap: spacing.sm,
  },
  guestTitle: { ...typography.bodyStrong, fontSize: 13.5, color: colors.text },
  guestBody: { ...typography.caption, fontSize: 11.5, color: colors.textQuaternary, lineHeight: 16 },

  content: { flex: 1, minWidth: 0 },
});
