import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import {
  getEventAnalytics, getEventOrders, getEventSalesSeries, getMyOrganizations,
} from '@/api/organizations';
import { SalesChart } from '@/components/SalesChart';
import { useLayout } from '@/hooks/useLayout';
import { messageFor } from '@/lib/errors';
import { formatMoney, formatRelative, vatSplit } from '@/lib/format';
import {
  Badge, Body, Caption, Divider, ErrorState, LoadingState, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/** Per-event analytics: views, saves, RSVPs, sales, BLUP fee and organizer net. */
export default function EventAnalyticsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const layout = useLayout();

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

  // Only to know whether this organizer is VAT-registered, and at what rate.
  const organizations = useQuery({
    queryKey: ['organizations', 'mine'],
    queryFn: getMyOrganizations,
  });
  const organization = organizations.data?.[0];

  const [days, setDays] = useState(30);

  const series = useQuery({
    queryKey: ['analytics', id, 'series', days],
    queryFn: () => getEventSalesSeries(id!, days),
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

  // Set up to sell, or has sold before — the second so a finished event whose
  // ticket types were deactivated still shows what it made.
  const sells = data.sells_tickets || data.has_sales;

  return (
    <Screen scroll>
      <Text style={styles.title}>{data.title}</Text>

      <SectionHeader title="Dosah" />
      <View style={[styles.grid, layout.isWide && styles.gridWide]}>
        <Tile label="Zobrazenia" value={String(data.views)} />
        <Tile label="Unikátni návštevníci" value={String(data.unique_viewers)} />
        <Tile label="Uloženia" value={String(data.saves)} />
        <Tile label="Páči sa" value={String(data.likes)} />
      </View>

      <SectionHeader title="Účasť" />
      <View style={[styles.grid, layout.isWide && styles.gridWide]}>
        <Tile label="Idú" value={String(data.rsvp_going)} />
        <Tile label="Zaujíma ich to" value={String(data.rsvp_interested)} />
        {sells ? <Tile label="Predané vstupenky" value={String(data.tickets_sold)} /> : null}
        {sells ? <Tile label="Odbavení" value={String(data.checked_in)} /> : null}
      </View>

      {/* The numbers above say how many; this says who — with the address each
          ticket went to and the code on it, and the switch that turns one off. */}
      <Pressable
        style={styles.linkRow}
        accessibilityRole="button"
        onPress={() => router.push(`/organizer/attendees/${id}`)}
      >
        <View style={styles.flex}>
          <Text style={styles.linkTitle}>Kto príde</Text>
          <Caption>Mená, adresy a kódy vstupeniek — a deaktivácia jednotlivej vstupenky.</Caption>
        </View>
        <Text style={styles.linkChevron}>›</Text>
      </Pressable>

      {/* --- the curve ----------------------------------------------------- */}
      {/* A free event has nothing to plot and no money to report. A curve of
          zeroes there is not an empty state, it is a screen that looks broken. */}
      {sells ? (
      <>
      <SectionHeader title="Predaj v čase" />
      <View style={styles.rangeRow}>
        {[7, 30, 90].map((option) => (
          <Pressable
            key={option}
            onPress={() => setDays(option)}
            style={[styles.range, days === option && styles.rangeOn]}
          >
            <Text style={[styles.rangeLabel, days === option && styles.rangeLabelOn]}>
              {option} dní
            </Text>
          </Pressable>
        ))}
      </View>

      {series.isLoading ? (
        <LoadingState label="Počítam predaj…" />
      ) : series.data ? (
        <SalesChart data={series.data} currency={data.currency} />
      ) : null}

      <SectionHeader title="Peniaze" />
      <View style={styles.money}>
        <MoneyRow label="Predaj v cenníku" value={formatMoney(data.gross_revenue_cents, data.currency)} />
        {data.discount_cents > 0 ? (
          <MoneyRow
            label="Zľavy z promo kódov"
            value={`− ${formatMoney(data.discount_cents, data.currency)}`}
          />
        ) : null}
        <MoneyRow label="Tržba po zľavách" value={formatMoney(data.net_revenue_cents, data.currency)} />
        <Divider />
        <MoneyRow
          label="Provízia BLUP"
          value={`− ${formatMoney(data.commission_cents, data.currency)}`}
        />
        <Divider />
        <MoneyRow label="Tvoj čistý príjem" value={formatMoney(data.organizer_net_cents, data.currency)} strong />
      </View>

      {organization?.is_vat_payer ? (
        <>
          <SectionHeader title="DPH z tržby" />
          <View style={styles.money}>
            <MoneyRow
              label="Základ dane (netto)"
              value={formatMoney(
                vatSplit(data.net_revenue_cents, organization.vat_rate_bps ?? 2300).netCents,
                data.currency,
              )}
            />
            <MoneyRow
              label={`DPH ${((organization.vat_rate_bps ?? 2300) / 100).toFixed(
                (organization.vat_rate_bps ?? 2300) % 100 === 0 ? 0 : 2,
              )} %`}
              value={formatMoney(
                vatSplit(data.net_revenue_cents, organization.vat_rate_bps ?? 2300).vatCents,
                data.currency,
              )}
            />
          </View>
          <Caption style={styles.conversion}>
            Ceny vstupeniek sú s DPH — kupujúci vidí a platí plnú sumu. Toto je rozpad tej
            istej tržby, len pre teba.
          </Caption>
        </>
      ) : null}

      {data.archive_fee_cents > 0 ? (
        <Caption style={styles.conversion}>
          Kupujúci zaplatili navyše {formatMoney(data.archive_fee_cents, data.currency)} archívneho
          poplatku — z tvojej tržby ti neuberá.
        </Caption>
      ) : null}

      <Caption style={styles.conversion}>
        Z {data.views} zobrazení skončilo vstupenkou {data.conversion_rate} %.
      </Caption>
      </>
      ) : null}

      <SectionHeader title="Posledné objednávky" />
      {paidOrders.length === 0 ? (
        <Body muted>Zatiaľ žiadne platené objednávky.</Body>
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
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },

  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginTop: spacing.md,
  },
  linkTitle: { ...typography.bodyStrong, color: colors.text },
  linkChevron: { ...typography.heading, color: colors.textTertiary },

  rangeRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  range: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.chip,
    backgroundColor: colors.surfaceElevated,
  },
  rangeOn: { backgroundColor: colors.accent },
  rangeLabel: { ...typography.chip, fontSize: 12, color: colors.textSecondary },
  rangeLabelOn: { color: '#FFFFFF' },
  title: { ...typography.heading, color: colors.text },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  // Two tiles stretched across a monitor is a lot of felt for four numbers.
  gridWide: { flexWrap: 'nowrap' },
  tile: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 140,
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
