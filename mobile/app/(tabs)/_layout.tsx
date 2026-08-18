import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Tabs } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getUnreadCount } from '@/api/notifications';
import { colors, radius, typography } from '@/theme';

/**
 * Tab icons are drawn as glyphs on a pill that fills with the accent colour
 * when active, matching the design's bottom bar.
 */
function TabIcon({ glyph, focused }: { glyph: string; focused: boolean }) {
  return (
    <View style={[styles.tabIcon, focused && styles.tabIconActive]}>
      <Text style={[styles.tabGlyph, focused && styles.tabGlyphActive]}>{glyph}</Text>
    </View>
  );
}

export default function TabsLayout() {
  const { data: unread } = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: getUnreadCount,
    refetchInterval: 60_000,
  });

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.backgroundElevated,
          borderTopColor: colors.border,
          height: 88,
          paddingTop: 10,
        },
        tabBarActiveTintColor: colors.accentText,
        tabBarInactiveTintColor: colors.textTertiary,
        tabBarLabelStyle: { fontSize: 11, fontFamily: typography.captionStrong.fontFamily },
        tabBarBadgeStyle: {
          backgroundColor: colors.accent,
          fontSize: 10,
          fontFamily: typography.captionStrong.fontFamily,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Objav',
          tabBarIcon: ({ focused }) => <TabIcon glyph="◉" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Komunita',
          tabBarIcon: ({ focused }) => <TabIcon glyph="◈" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="create"
        options={{
          title: 'Vytvoriť',
          tabBarIcon: ({ focused }) => <TabIcon glyph="≡" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          // Notifications, not chat — BLUP has no messaging backend, so the tab
          // is not labelled as if it did.
          title: 'Aktivita',
          tabBarIcon: ({ focused }) => <TabIcon glyph="✦" focused={focused} />,
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
}

const styles = StyleSheet.create({
  tabIcon: {
    width: 54,
    height: 34,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabIconActive: { backgroundColor: colors.accentSoft },
  tabGlyph: { fontSize: 19, color: colors.textTertiary },
  tabGlyphActive: { color: colors.accentText },
});
