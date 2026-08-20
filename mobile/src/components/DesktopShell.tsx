import React from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Link, usePathname, router } from 'expo-router';

import { useAuth } from '@/auth/AuthProvider';
import { SIDEBAR_WIDTH } from '@/hooks/useLayout';
import { Avatar } from '@/components/ui';
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
function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const [hovered, setHovered] = React.useState(false);

  return (
    <Link
      href={item.href as never}
      accessibilityRole="link"
      accessibilityState={{ selected: active }}
      style={styles.linkReset}
    >
      <View
        // react-native-web forwards mouse events on any View; Link's own props
        // are typed for React Native, which has no pointer.
        {...({
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
        } as object)}
        style={[styles.link, hovered && styles.linkHovered, active && styles.linkActive]}
      >
        <Text style={[styles.glyph, active && styles.glyphActive]}>{item.glyph}</Text>
        <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
          {item.label}
        </Text>
        {item.badge ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{item.badge > 99 ? '99+' : item.badge}</Text>
          </View>
        ) : null}
      </View>
    </Link>
  );
}

export function DesktopShell({
  children,
  unread = 0,
}: {
  children: React.ReactNode;
  unread?: number;
}) {
  const pathname = usePathname();
  const { profile, isAdmin } = useAuth();

  const primary: NavItem[] = [
    { href: '/', label: 'Domov', glyph: '◉' },
    { href: '/discover', label: 'Objav', glyph: '◈' },
    { href: '/feed', label: 'Feed', glyph: '☰' },
    { href: '/messages', label: 'Chat', glyph: '✉', badge: unread },
    { href: '/(tabs)/profile', label: 'Ja', glyph: '☺' },
  ];

  const secondary: NavItem[] = [
    { href: '/community', label: 'Komunity', glyph: '◇' },
    { href: '/tickets', label: 'Vstupenky', glyph: '🎫' },
    { href: '/activity', label: 'Aktivita', glyph: '🔔' },
    { href: '/organizer', label: 'Organizátor', glyph: '◆' },
    ...(isAdmin ? [{ href: '/admin', label: 'Admin', glyph: '⚙' }] : []),
  ];

  // `/` must match exactly or every route would light it up.
  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href.replace('/(tabs)', ''));

  return (
    <View style={styles.shell}>
      <View style={styles.sidebar}>
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

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.navScroll}>
          <View style={styles.group}>
            {primary.map((item) => (
              <NavLink key={item.href} item={item} active={isActive(item.href)} />
            ))}
          </View>

          <View style={styles.divider} />

          <View style={styles.group}>
            {secondary.map((item) => (
              <NavLink key={item.href} item={item} active={isActive(item.href)} />
            ))}
          </View>
        </ScrollView>

        <Pressable
          onPress={() => router.push('/settings')}
          accessibilityRole="link"
          style={(state) => [styles.me, isHovered(state) && styles.linkHovered]}
        >
          <Avatar name={profile?.display_name ?? profile?.username ?? '·'} url={profile?.avatar_url} size={32} />
          <View style={styles.meText}>
            <Text style={styles.meName} numberOfLines={1}>
              {profile?.display_name ?? 'Ja'}
            </Text>
            <Text style={styles.meHandle} numberOfLines={1}>
              {profile?.username ? `@${profile.username}` : 'Nastavenia'}
            </Text>
          </View>
        </Pressable>
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
  brand: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl },
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

  content: { flex: 1, minWidth: 0 },
});
