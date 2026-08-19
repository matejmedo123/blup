import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Tabs } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getUnreadMessageCount } from '@/api/messages';
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
  const { data: unread } = useQuery({
    queryKey: ['messages', 'unread'],
    queryFn: getUnreadMessageCount,
    refetchInterval: 60_000,
  });

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: Platform.OS === 'web' ? colors.background : 'rgba(10, 13, 18, 0.92)',
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 88,
          paddingTop: 8,
          paddingHorizontal: 8,
          paddingBottom: 26,
          elevation: 0,
        },
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
