import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Tabs } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getUnreadMessageCount } from '@/api/messages';
import { DesktopShell } from '@/components/DesktopShell';
import { useLayout } from '@/hooks/useLayout';
import { colors, radius, typography } from '@/theme';

/**
 * The tab bar from the handoff: height 88 with `8px 8px 26px` padding, a
 * translucent app-coloured background and a subtle top border. Each tab is a
 * 54-tall pill that fills with `rgba(0,128,255,.1)` when active.
 */
function TabIcon({ glyph, focused }: { glyph: string; focused: boolean }) {
  return (
    <View style={[styles.tabIcon, focused && styles.tabIconActive]}>
      <Text style={[styles.tabGlyph, focused && styles.tabGlyphActive]}>{glyph}</Text>
    </View>
  );
}

export default function TabsLayout() {
  const layout = useLayout();

  const { data: unread } = useQuery({
    queryKey: ['messages', 'unread'],
    queryFn: getUnreadMessageCount,
    refetchInterval: 60_000,
  });

  const tabs = (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: layout.isDesktop ? { display: 'none' } : {
          backgroundColor: Platform.OS === 'web' ? colors.background : 'rgba(10, 13, 18, 0.92)',
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: Platform.OS === 'web' ? 64 : 88,
          paddingTop: 8,
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
        tabBarLabelStyle: {
          fontSize: 10,
          fontFamily: typography.tabLabel.fontFamily,
          marginTop: -4,
        },
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
          tabBarIcon: ({ focused }) => <TabIcon glyph="◉" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="discover"
        options={{
          title: 'Objav',
          tabBarIcon: ({ focused }) => <TabIcon glyph="◈" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="feed"
        options={{
          title: 'Feed',
          tabBarIcon: ({ focused }) => <TabIcon glyph="☰" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="messages"
        options={{
          title: 'Chat',
          tabBarIcon: ({ focused }) => <TabIcon glyph="✉" focused={focused} />,
          tabBarBadge: unread && unread > 0 ? (unread > 99 ? '99+' : unread) : undefined,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Ja',
          tabBarIcon: ({ focused }) => <TabIcon glyph="☺" focused={focused} />,
        }}
      />
    </Tabs>
  );

  // On a desktop the same five destinations move into a sidebar: there is no
  // thumb to reach the bottom of the window, and a bar pinned there covers
  // content for no benefit. The screens themselves are untouched.
  if (layout.isDesktop) {
    return <DesktopShell unread={unread ?? 0}>{tabs}</DesktopShell>;
  }

  return tabs;
}

const styles = StyleSheet.create({
  tabIcon: {
    width: 58,
    height: 34,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabIconActive: { backgroundColor: 'rgba(0, 128, 255, 0.1)' },
  tabGlyph: { fontSize: 18, color: colors.textQuaternary },
  tabGlyphActive: { color: colors.accent },
});
