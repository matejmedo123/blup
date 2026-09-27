import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getMyResaleListings, type MyResaleListing } from '@/api/resale';
import { SwapNav } from '@/swap/SwapNav';
import { Button, Caption, EmptyState, LoadingState, Screen } from '@/components/ui';
import { formatEventDate, formatMoney } from '@/lib/format';
import { CONTENT_MAX_WIDE } from '@/hooks/useLayout';
import { colors, radius, spacing, typography } from '@/theme';
import { swapAccountRoute } from '@/swap/SwapGuestGate';

/**
 * Čo sa mi predalo.
 *
 * Oddelené od „Moje ponuky" preto, že sú to dve rôzne úlohy. V ponukách sa
 * rozhoduje o cene a o tom, čo stiahnuť; tu sa dokončuje predaj — doručiť
 * vstupenku a čakať na peniaze. Zmiešané dokopy je to zoznam, v ktorom treba
 * hľadať to jedno, čo si vyžaduje pozornosť.
 *
 * Preto je hore vytiahnuté to naliehavé: vstupenka, ktorú kupujúci zaplatil a
 * ešte ju nemá.
 */
function SwapSalesScreen() {
  const listings = useQuery({
    queryKey: ['resale', 'mine'],
    queryFn: () => getMyResaleListings(60),
  });

  if (listings.isLoading) return <Screen><LoadingState label="Načítavam…" /></Screen>;

  const rows = listings.data ?? [];
  const sold = rows.filter((row) => row.status === 'sold');
  const waiting = sold.filter((row) => row.order_status === 'waiting_for_ticket');
  const rest = sold.filter((row) => row.order_status !== 'waiting_for_ticket');

  const earned = sold
    .filter((row) => row.order_status === 'completed')
    .reduce((sum, row) => sum + (row.seller_net_cents ?? 0), 0);

  return (
    <Screen scroll>
      <SwapNav active="/swap/sales" />

      {sold.length === 0 ? (
        <EmptyState
          emoji="🎟"
          title="Zatiaľ si nič nepredal"
          body="Keď niekto kúpi tvoju vstupenku, objaví sa tu."
          actionLabel="Predať vstupenku"
          onAction={() => router.push('/swap/sell')}
        />
      ) : (
        <>
          <View style={styles.summary}>
            <Text style={styles.summaryBig}>
              {sold.length} {sold.length === 1 ? 'predaná vstupenka'
                : sold.length < 5 ? 'predané vstupenky' : 'predaných vstupeniek'}
            </Text>
            {earned > 0 ? (
              <Caption>
                zarobené {formatMoney(earned, sold[0]?.currency ?? 'EUR')}
              </Caption>
            ) : null}
          </View>

          {waiting.length > 0 ? (
            <>
              <Text style={styles.group}>Čaká na teba</Text>
              <Caption style={styles.groupBody}>
                Kupujúci zaplatil. Kým mu vstupenku nepošleš, platba sa neuvoľní.
              </Caption>
              {waiting.map((row) => <SaleCard key={row.id} row={row} urgent />)}
            </>
          ) : null}

          {rest.length > 0 ? (
            <>
              <Text style={styles.group}>Hotové</Text>
              {rest.map((row) => <SaleCard key={row.id} row={row} />)}
            </>
          ) : null}
        </>
      )}
    </Screen>
  );
}

function SaleCard({ row, urgent }: { row: MyResaleListing; urgent?: boolean }) {
  const seat = [
    row.section && `Sektor ${row.section}`,
    row.row_label && `rad ${row.row_label}`,
    row.seat_label && `miesto ${row.seat_label}`,
  ].filter(Boolean).join(' · ');

  const [label, tone] = stateOf(row);

  return (
    <View style={[styles.card, urgent && styles.cardUrgent]}>
      <View style={styles.cardTop}>
        <View style={styles.cardText}>
          <Text style={styles.event} numberOfLines={1}>{row.event_title}</Text>
          <Caption>{formatEventDate(row.event_start_at)}{seat ? ` · ${seat}` : ''}</Caption>
        </View>
        <View style={styles.money}>
          <Text style={styles.price}>
            {formatMoney(row.price_cents, row.currency)}
          </Text>
          {row.seller_net_cents != null ? (
            <Caption>tebe {formatMoney(row.seller_net_cents, row.currency)}</Caption>
          ) : null}
        </View>
      </View>

      <View style={styles.cardBottom}>
        <View style={[styles.pill, tone === 'good' && styles.pillGood,
                      tone === 'warn' && styles.pillWarn]}>
          <Text style={[styles.pillLabel, tone === 'good' && styles.pillLabelGood,
                        tone === 'warn' && styles.pillLabelWarn]}>
            {label}
          </Text>
        </View>
      </View>

      {row.order_id && row.order_status === 'waiting_for_ticket' ? (
        <Button
          title="Doručiť vstupenku"
          onPress={() => router.push(`/swap/deliver/${row.order_id}`)}
        />
      ) : null}
    </View>
  );
}

function stateOf(row: MyResaleListing): [string, 'plain' | 'good' | 'warn'] {
  switch (row.order_status) {
    case 'waiting_for_ticket': return ['Čaká na doručenie', 'warn'];
    case 'ticket_delivered':   return ['Doručené — čaká sa na potvrdenie', 'warn'];
    case 'completed':          return ['Hotovo', 'good'];
    case 'disputed':           return ['Otvorený spor', 'warn'];
    case 'refunded':           return ['Vrátené kupujúcemu', 'plain'];
    default:                   return ['Predané', 'good'];
  }
}

const styles = StyleSheet.create({
  summary: {
    padding: spacing.md, borderRadius: radius.card,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    marginBottom: spacing.md, gap: 2,
    maxWidth: CONTENT_MAX_WIDE, width: '100%', alignSelf: 'center',
  },
  summaryBig: { ...typography.subheading, color: colors.text },

  group: { ...typography.bodyStrong, color: colors.text, marginTop: spacing.sm },
  groupBody: { marginBottom: spacing.sm, lineHeight: 18 },

  card: {
    padding: spacing.md, borderRadius: radius.card,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    gap: spacing.sm, marginBottom: spacing.sm,
    maxWidth: CONTENT_MAX_WIDE, width: '100%', alignSelf: 'center',
  },
  cardUrgent: { borderColor: colors.warning },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  cardText: { flex: 1 },
  event: { ...typography.bodyStrong, color: colors.text },
  money: { alignItems: 'flex-end' },
  price: { ...typography.subheading, color: colors.text },
  cardBottom: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },

  pill: {
    paddingHorizontal: spacing.sm, paddingVertical: 3,
    borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border,
  },
  pillGood: { backgroundColor: colors.successSoft, borderColor: colors.success },
  pillWarn: { backgroundColor: colors.warningSoft, borderColor: colors.warning },
  pillLabel: { ...typography.metaSm, color: colors.textSecondary },
  pillLabelGood: { color: colors.success },
  pillLabelWarn: { color: colors.warning },
});

export default swapAccountRoute(
  'Tu uvidíš, čo si predal a čo ešte treba doručiť.',
  SwapSalesScreen,
);
