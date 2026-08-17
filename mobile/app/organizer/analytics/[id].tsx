import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getEventAnalytics, getEventOrders } from '@/api/organizations';
import { messageFor } from '@/lib/errors';
import { formatMoney, formatRelative } from '@/lib/format';
import {
  Badge, Body, Caption, Divider, ErrorState, LoadingState, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/** Per-event analytics: views, saves, RSVPs, sales, BLUP fee and organizer net. */
export default function EventAnalyticsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  const analytics = useQuery({
    queryKey: ['analytics', id],
    queryFn: () => getEventAnalytics(id!),
    enabled: Boolean(id),
  });

  const orders = useQuery({
    queryKey: ['analytics', id, 'orders'],
    queryFn: () => getEventOrders(id!),
    enabled: Boolean(id),
  });

  if (analytics.isLoading) return <Screen><LoadingState /></Screen>;

  if (analytics.isError || !analytics.data) {
    return (
      <Screen>
        <ErrorState message={messageFor(analytics.error)} onRetry={() => void analytics.refetch()} />
      </Screen>
    );
  }

  const data = analytics.data;
  const paidOrders = (orders.data ?? []).filter((order) => order.payment_status === 'succeeded');

  return (
    <Screen scroll>
      <Text style={styles.title}>{data.title}</Text>

      <SectionHeader title="Reach" />
      <View style={styles.grid}>
        <Tile label="Views" value={String(data.views)} />
        <Tile label="Unique viewers" value={String(data.unique_viewers)} />
        <Tile label="Saves" value={String(data.saves)} />
        <Tile label="Likes" value={String(data.likes)} />
      </View>

      <SectionHeader title="Attendance" />
      <View style={styles.grid}>
        <Tile label="Going" value={String(data.rsvp_going)} />
        <Tile label="Interested" value={String(data.rsvp_interested)} />
        <Tile label="Tickets sold" value={String(data.tickets_sold)} />
        <Tile label="Checked in" value={String(data.checked_in)} />
      </View>

      <SectionHeader title="Money" />
      <View style={styles.money}>
        <MoneyRow label="Gross revenue" value={formatMoney(data.gross_revenue_cents, data.currency)} />
        <MoneyRow label="BLUP fee" value={`− ${formatMoney(data.platform_fee_cents, data.currency)}`} />
        <Divider />
        <MoneyRow label="Your net" value={formatMoney(data.organizer_net_cents, data.currency)} strong />
      </View>

      <Caption style={styles.conversion}>
        Conversion: {data.conversion_rate}% of views became a ticket.
      </Caption>

      <SectionHeader title="Recent orders" />
      {paidOrders.length === 0 ? (
        <Body muted>No paid orders yet.</Body>
      ) : (
        paidOrders.slice(0, 20).map((order) => (
          <View key={order.id as string} style={styles.orderRow}>
            <View style={styles.flex}>
              <Text style={styles.orderTitle}>
                {order.quantity as number} × ticket
              </Text>
              <Caption>{formatRelative(order.created_at as string)}</Caption>
            </View>
            <Badge tone="success" label={formatMoney(order.total_cents as number, order.currency as string)} />
          </View>
        ))
      )}
    </Screen>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileValue}>{value}</Text>
      <Caption>{label}</Caption>
    </View>
  );
}

function MoneyRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.moneyRow}>
      <Caption>{label}</Caption>
      <Text style={[styles.moneyValue, strong && styles.moneyValueStrong]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  title: { ...typography.heading, color: colors.text },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  tile: {
    flexGrow: 1,
    minWidth: '45%',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: 2,
  },
  tileValue: { ...typography.title, color: colors.text },

  money: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg },
  moneyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  moneyValue: { ...typography.body, color: colors.textSecondary },
  moneyValueStrong: { ...typography.subheading, color: colors.text },
  conversion: { marginTop: spacing.md },

  orderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  orderTitle: { ...typography.bodyStrong, color: colors.text },
});
