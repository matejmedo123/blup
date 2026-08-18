import React, { useEffect } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getNotifications, markAllRead } from '@/api/notifications';
import { supabase } from '@/lib/supabase';
import { messageFor } from '@/lib/errors';
import { formatRelative } from '@/lib/format';
import {
  Body, Caption, EmptyState, ErrorState, LoadingState, Mono, Screen,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';
import type { AppNotification, NotificationType } from '@/types/models';

/** Monochrome glyphs, matching the icon tiles in the design. */
const ICONS: Record<NotificationType, string> = {
  new_follower: '⇄',
  friend_request: '⇄',
  friend_accepted: '✓',
  event_reminder: '◷',
  event_starting_soon: '◉',
  event_updated: '✎',
  event_cancelled: '✕',
  friend_attending: '◉',
  ticket_purchased: '◫',
  ticket_confirmed: '◫',
  payout_update: '€',
  org_verified: '✓',
  org_rejected: '!',
  weekly_recommendations: '✦',
  new_comment: '❝',
  event_full: '★',
};

/** Activity — notifications, live over realtime. */
export default function ActivityScreen() {
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => getNotifications(80),
  });

  // Live updates: a new follower or RSVP lands here without pulling to refresh.
  useEffect(() => {
    const channel = supabase
      .channel('activity-notifications')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications' },
        () => {
          void queryClient.invalidateQueries({ queryKey: ['notifications'] });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  // Opening the tab marks everything read.
  useEffect(() => {
    if (!data || data.length === 0) return;
    const hasUnread = data.some((notification) => !notification.read_at);
    if (!hasUnread) return;

    markAllRead()
      .then(() => queryClient.invalidateQueries({ queryKey: ['notifications', 'unread'] }))
      .catch(() => undefined);
  }, [data, queryClient]);

  const open = (notification: AppNotification) => {
    if (notification.event_id) {
      router.push(`/event/${notification.event_id}`);
      return;
    }
    if (notification.actor_id) {
      router.push(`/user/${notification.actor_id}`);
      return;
    }
    if (notification.type === 'payout_update') {
      router.push('/organizer');
    }
  };

  if (isLoading) return <Screen><LoadingState label="Načítavam notifikácie…" /></Screen>;

  if (isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(error)} onRetry={() => void refetch()} />
      </Screen>
    );
  }

  return (
    <Screen contentStyle={styles.container}>
      <Text style={styles.title}>Notifikácie</Text>

      <FlatList
        data={data ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => void refetch()}
            tintColor={colors.accent}
          />
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => open(item)}
            style={({ pressed }) => [
              styles.row,
              !item.read_at && styles.rowUnread,
              pressed && styles.rowPressed,
            ]}
          >
            <View style={[styles.icon, !item.read_at && styles.iconUnread]}>
              <Text style={[styles.iconText, !item.read_at && styles.iconTextUnread]}>
                {ICONS[item.type] ?? '◉'}
              </Text>
            </View>

            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>{item.title}</Text>
              {item.body ? <Body muted numberOfLines={2}>{item.body}</Body> : null}

            </View>

            <Mono style={styles.time}>{formatRelative(item.created_at)}</Mono>
          </Pressable>
        )}
        ListEmptyComponent={
          <EmptyState
            emoji="🔔"
            title="Zatiaľ nič"
            body="Nové sledovania, RSVP, potvrdenia vstupeniek a pripomienky eventov sa objavia tu."
          />
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { paddingTop: spacing.md },
  title: { ...typography.title, color: colors.text, paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl, flexGrow: 1 },

  row: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    alignItems: 'flex-start',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  rowUnread: { borderColor: colors.accent, backgroundColor: colors.backgroundElevated },
  rowPressed: { backgroundColor: colors.surfacePressed },

  icon: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconUnread: { backgroundColor: colors.accent },
  iconText: { fontSize: 19, color: colors.textSecondary },
  iconTextUnread: { color: '#FFFFFF' },

  rowBody: { flex: 1, gap: 2 },
  rowTitle: { ...typography.bodyStrong, color: colors.text },
  time: { color: colors.textTertiary },

});
