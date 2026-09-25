import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Tabs } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getUnreadMessageCount } from '@/api/messages';
import { useAuth } from '@/auth/AuthProvider';
import { useLayout } from '@/hooks/useLayout';
import { colors, radius, typography } from '@/theme';

/**
 * The tab bar from the handoff: height 88 with `8px 8px 26px` padding, a
 * translucent app-coloured background and a subtle top border. Each tab is a
 * pill that fills with `rgba(0,128,255,.1)` when active.
 *
 * Glyph and label are drawn together, in one box, and the navigator's own
 * label is switched off. They used to be two separate things: the pill was
 * this component and the label was drawn by the navigator underneath it, so
 * the highlight ended above the word it was highlighting — on a phone, where
 * the bar is tall enough to separate them, "Objav" sat visibly outside its own
 * marking. A highlight that does not contain the thing it marks reads as a
 * rendering fault, because that is what it looks like.
 */
function TabItem({
  glyph, label, focused,
}: {
  glyph: string;
  label: string;
  focused: boolean;
}) {
  return (
    <View style={[styles.tabItem, focused && styles.tabItemActive]}>
      <Text style={[styles.tabGlyph, focused && styles.tabGlyphActive]}>{glyph}</Text>
      <Text
        style={[styles.tabLabel, focused && styles.tabLabelActive]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

export default function TabsLayout() {
  const layout = useLayout();
  const { isGuest } = useAuth();

  const { data: unread } = useQuery({
    queryKey: ['messages', 'unread'],
    queryFn: getUnreadMessageCount,
    refetchInterval: 60_000,
    // Nobody signed in has no unread anything; asking would just 401 once a
    // minute forever.
    enabled: !isGuest,
  });

  const tabs = (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: layout.isDesktop ? { display: 'none' } : {
          backgroundColor: Platform.OS === 'web' ? colors.background : 'rgba(10, 13, 18, 0.92)',
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: Platform.OS === 'web' ? 70 : 88,
          paddingTop: 6,
          paddingHorizontal: 8,
          // A phone needs room for the home indicator; a browser does not.
          paddingBottom: Platform.OS === 'web' ? 8 : 26,
          elevation: 0,
        },
        // Keep the bar readable on a wide screen: five icons stretched across a
        // desktop monitor look like a mistake, so each item keeps a phone-sized
        // width and the row centres itself.
        tabBarItemStyle: Platform.OS === 'web' ? { maxWidth: 152 } : undefined,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textQuaternary,
        // Off, because TabItem draws the label inside the pill. Leaving it on
        // would put the word on the screen twice, once in each place.
        tabBarShowLabel: false,
        tabBarBadgeStyle: {
          backgroundColor: colors.accent,
          fontSize: 10,
          fontFamily: typography.tabLabel.fontFamily,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Domov',
          tabBarIcon: ({ focused }) => (
            <TabItem glyph="◉" label="Domov" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="discover"
        options={{
          title: 'Objav',
          tabBarIcon: ({ focused }) => (
            <TabItem glyph="◈" label="Objav" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="feed"
        options={{
          title: 'Feed',
          tabBarIcon: ({ focused }) => (
            <TabItem glyph="☰" label="Feed" focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="messages"
        options={{
          title: 'Chat',
          tabBarIcon: ({ focused }) => (
            <TabItem glyph="✉" label="Chat" focused={focused} />
          ),
          tabBarBadge: unread && unread > 0 ? (unread > 99 ? '99+' : unread) : undefined,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Ja',
          tabBarIcon: ({ focused }) => (
            <TabItem glyph="☺" label="Ja" focused={focused} />
          ),
        }}
      />
    </Tabs>
  );

  // On a desktop the same five destinations move into a sidebar: there is no
  // thumb to reach the bottom of the window, and a bar pinned there covers
  // content for no benefit. The screens themselves are untouched.
  if (layout.isDesktop) {
    // The sidebar is drawn by AppFrame at the root now, so every screen keeps
    // it — not just these five. Here the desktop only drops the tab bar.
    return tabs;
  }

  return tabs;
}

const styles = StyleSheet.create({
  tabItem: {
    minWidth: 58,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  tabItemActive: { backgroundColor: 'rgba(0, 128, 255, 0.1)' },
  tabGlyph: { fontSize: 18, lineHeight: 22, color: colors.textQuaternary },
  tabGlyphActive: { color: colors.accent },
  tabLabel: {
    fontSize: 10,
    lineHeight: 13,
    fontFamily: typography.tabLabel.fontFamily,
    color: colors.textQuaternary,
  },
  tabLabelActive: { color: colors.accent },
});
