import React, { useEffect } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import { getNotifications, markAllRead } from '@/api/notifications';
import { SignInInvite } from '@/components/SignInInvite';
import { subscribeToTable } from '@/lib/realtime';
import { messageFor } from '@/lib/errors';
import { formatRelative } from '@/lib/format';
import { EmptyState, ErrorState, LoadingState, Screen } from '@/components/ui';
import { SiteFooter } from '@/components/SiteFooter';
import { colors, radius, spacing, typography } from '@/theme';
import type { AppNotification, NotificationType } from '@/types/models';

/**
 * Notifikácie.
 *
 * The handoff's list: a monochrome glyph tile, title, body and a relative time.
 * The newest unread row is "hot" — accent border, filled blue tile — so the
 * thing that just happened is obvious at a glance.
 */
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
  new_message: '✉',
  badge_earned: '★',
  level_up: '▲',
};

export default function ActivityScreen() {
  const queryClient = useQueryClient();
  const { isGuest } = useAuth();

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => getNotifications(80),
    enabled: !isGuest,
  });

  useEffect(() => subscribeToTable({
    topic: 'activity-notifications',
    table: 'notifications',
    event: 'INSERT',
    onChange: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  }), [queryClient]);

  // Opening the screen marks everything read.
  useEffect(() => {
    if (!data || data.length === 0) return;
    if (!data.some((notification) => !notification.read_at)) return;

    markAllRead()
      .then(() => queryClient.invalidateQueries({ queryKey: ['notifications', 'unread'] }))
      .catch(() => undefined);
  }, [data, queryClient]);

  const open = (notification: AppNotification) => {
    const conversationId = (notification.data as { conversation_id?: string } | null)
      ?.conversation_id;

    if (conversationId) {
      router.push(`/chat/${conversationId}`);
      return;
    }
    if (notification.event_id) {
      router.push(`/event/${notification.event_id}`);
      return;
    }
    if (notification.type === 'badge_earned' || notification.type === 'level_up') {
      router.push('/badges');
      return;
    }
    if (notification.actor_id) {
      router.push(`/user/${notification.actor_id}`);
      return;
    }
    if (notification.type === 'payout_update') router.push('/organizer');
  };

  if (isLoading) return <Screen><LoadingState label="Načítavam notifikácie…" /></Screen>;

  if (isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(error)} onRetry={() => void refetch()} />
      </Screen>
    );
  }

  const items = data ?? [];
  const hotId = items.find((notification) => !notification.read_at)?.id;

  // Notifications are about things that happened to *you*. A guest has none —
  // and "Zatiaľ nič" would imply they might, later, without signing up.
  if (isGuest) {
    return (
      <SignInInvite
        glyph="🔔"
        title="Notifikácie sú pre prihlásených"
        body="Potvrdené vstupenky, pripomienky eventov, nové sledovania a odznaky chodia na účet."
      />
    );
  }

  return (
    <Screen contentStyle={styles.container}>
      <FlatList
        ListFooterComponent={<SiteFooter />}
        data={items}
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
        renderItem={({ item }) => {
          const hot = item.id === hotId;

          return (
            <Pressable
              onPress={() => open(item)}
              style={({ pressed }) => [
                styles.row,
                hot && styles.rowHot,
                pressed && styles.rowPressed,
              ]}
            >
              <View style={[styles.icon, hot && styles.iconHot]}>
                <Text style={[styles.iconGlyph, hot && styles.iconGlyphHot]}>
                  {ICONS[item.type] ?? '◉'}
                </Text>
              </View>

              <View style={styles.flex}>
                <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
                {item.body ? (
                  <Text style={styles.body} numberOfLines={2}>{item.body}</Text>
                ) : null}
              </View>

              <Text style={styles.time}>{formatRelative(item.created_at)}</Text>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <EmptyState
            emoji="🔔"
            title="Zatiaľ nič"
            body="Nové sledovania, potvrdené vstupenky, pripomienky eventov a odznaky sa objavia tu."
          />
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { padding: 0 },
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
  list: { padding: spacing.gutter, paddingBottom: spacing.xxxl, flexGrow: 1 },

  row: {
    flexDirection: 'row',
    gap: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.card,
    alignItems: 'flex-start',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  rowHot: { backgroundColor: 'rgba(0,128,255,0.1)', borderColor: colors.accentBorder },
  rowPressed: { backgroundColor: colors.surfacePressed },

  icon: {
    width: 42,
    height: 42,
    borderRadius: radius.block,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconHot: { backgroundColor: colors.accent },
  iconGlyph: { fontSize: 17, color: colors.textTertiary },
  iconGlyphHot: { color: '#FFFFFF' },

  title: { ...typography.rowTitleSm, color: colors.text },
  body: { ...typography.metaSm, color: colors.textTertiary, marginTop: 3 },
  time: { ...typography.monoSm, color: colors.textMuted },
});
