import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getMyTickets } from '@/api/tickets';
import { messageFor } from '@/lib/errors';
import { formatEventDate, formatPrice } from '@/lib/format';
import { Badge, Caption, EmptyState, ErrorState, LoadingState, Screen } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';
import type { TicketStatus } from '@/types/models';

const TONE: Record<TicketStatus, 'success' | 'neutral' | 'danger' | 'warning'> = {
  valid: 'success',
  used: 'neutral',
  refunded: 'warning',
  cancelled: 'danger',
};

export default function TicketsScreen() {
  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['tickets', 'mine'],
    queryFn: getMyTickets,
  });

  if (isLoading) return <Screen><LoadingState label="Loading your tickets…" /></Screen>;

  if (isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(error)} onRetry={() => void refetch()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <FlatList
        data={data ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshing={isRefetching}
        onRefresh={() => void refetch()}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.ticket, pressed && styles.ticketPressed]}
            onPress={() => router.push(`/tickets/${item.id}`)}
          >
            <View style={styles.stub}>
              <Text style={styles.stubEmoji}>🎫</Text>
            </View>

            <View style={styles.flex}>
              <Text style={styles.title} numberOfLines={1}>
                {item.event?.title ?? 'Event'}
              </Text>
              {item.event ? <Caption>{formatEventDate(item.event.start_at)}</Caption> : null}
              {item.event?.venue_name ? <Caption>{item.event.venue_name}</Caption> : null}
              <Caption style={styles.code}>{item.code}</Caption>
            </View>

            <View style={styles.right}>
              <Badge tone={TONE[item.status]} label={item.status} />
              <Caption>{formatPrice(item.price_cents, item.currency)}</Caption>
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          <EmptyState
            emoji="🎟️"
            title="No tickets yet"
            body="When you buy a ticket it lands here with a QR code you can show at the door — even offline."
            actionLabel="Find something to go to"
            onAction={() => router.replace('/(tabs)/explore')}
          />
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: spacing.lg, gap: spacing.md, flexGrow: 1 },

  ticket: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  ticketPressed: { backgroundColor: colors.surfacePressed },

  stub: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stubEmoji: { fontSize: 22 },

  title: { ...typography.bodyStrong, color: colors.text },
  code: { color: colors.textTertiary, marginTop: 2, letterSpacing: 1 },
  right: { alignItems: 'flex-end', gap: spacing.xs },
});
