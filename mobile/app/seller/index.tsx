import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  cancelResaleListing, getMyResaleListings, getSellerBalance,
  type MyResaleListing,
} from '@/api/resale';
import {
  Button, Caption, EmptyState, LoadingState, Mono, Notice, Screen,
  SectionHeader,
} from '@/components/ui';
import { useDialog } from '@/components/Dialog';
import { messageFor } from '@/lib/errors';
import { formatEventDate, formatMoney } from '@/lib/format';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Predávam — prehľad pre toho, kto ponúka vstupenky.
 *
 * Tri čísla hore a pri každom je jasné, čo znamená. „Čaká" nie je zdržanie
 * ani chyba: peniaze sa uvoľňujú až po evente, lebo dovtedy nevieme, či sa
 * kupujúci naozaj dostal dnu. Keby to obrazovka nepovedala, vyzeralo by to
 * ako zadržiavanie bez dôvodu.
 */
export default function SellerScreen() {
  const queryClient = useQueryClient();
  const dialog = useDialog();
  const [error, setError] = React.useState<string | null>(null);

  const balance = useQuery({
    queryKey: ['resale', 'balance'],
    queryFn: getSellerBalance,
  });

  const listings = useQuery({
    queryKey: ['resale', 'mine'],
    queryFn: () => getMyResaleListings(50),
  });

  if (listings.isLoading) return <Screen><LoadingState label="Načítavam…" /></Screen>;

  const rows = listings.data ?? [];
  const live = rows.filter((r) => r.status === 'active' || r.status === 'reserved');
  const sold = rows.filter((r) => r.status === 'sold');
  const done = rows.filter((r) => !live.includes(r) && !sold.includes(r));
  const b = balance.data;

  const waitingDelivery = sold.filter(
    (r) => r.source === 'external' && r.order_status === 'waiting_for_ticket',
  );

  const withdraw = async () => {
    setError(null);
    try {
      await dialog.confirm({
        title: 'Poslať peniaze na účet',
        body: `Pošleme ti ${formatMoney(b?.available_cents ?? 0, b?.currency ?? 'EUR')}.`,
        confirmLabel: 'Poslať',
      });
    } catch {
      return;
    }
    try {
      const { requestSellerPayout } = await import('@/api/resale');
      await requestSellerPayout();
      await queryClient.invalidateQueries({ queryKey: ['resale'] });
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  return (
    <Screen scroll>
      {/* Bez vlastného nadpisu: hlavička hore už hovorí „Predávam" a druhý
          raz pod ňou to vyzerá ako chyba v rozložení. */}
      {b ? (
        <View style={styles.money}>
          <View style={styles.moneyRow}>
            <Cell
              label="K výplate"
              value={formatMoney(b.available_cents, b.currency)}
              strong
            />
            <Cell label="Čaká na event" value={formatMoney(b.pending_cents, b.currency)} />
            <Cell label="Vyplatené" value={formatMoney(b.paid_out_cents, b.currency)} />
          </View>

          <Caption style={styles.moneyNote}>
            Peniaze sa uvoľnia po evente. Pri vstupenke z inej platformy až keď
            kupujúci potvrdí, že fungovala.
          </Caption>

          {b.available_cents > 0 ? (
            b.payouts_enabled ? (
              <Button title="Poslať na účet" onPress={() => void withdraw()} />
            ) : (
              <Notice
                tone="accent"
                title="Najprv si nastav výplatný účet"
                body="Bez neho nemáme kam peniaze poslať."
              />
            )
          ) : null}
        </View>
      ) : null}

      {error ? <Notice tone="danger" title="Nepodarilo sa" body={error} /> : null}

      {waitingDelivery.length > 0 ? (
        <Notice
          tone="warning"
          title={waitingDelivery.length === 1
            ? 'Jedna vstupenka čaká na doručenie'
            : `${waitingDelivery.length} vstupenky čakajú na doručenie`}
          body="Kým ju kupujúcemu nepošleš, platba sa neuvoľní."
        />
      ) : null}

      <Button
        title="Predať vstupenku"
        variant="secondary"
        onPress={() => router.push('/resale/sell')}
      />

      <SectionHeader title="V predaji" />
      {live.length === 0 ? (
        <EmptyState
          emoji="🎟"
          title="Nič neponúkaš"
          body="Keď nebudeš môcť ísť, vstupenku tu vieš ponúknuť ďalej."
        />
      ) : (
        live.map((row) => (
          <ListingCard
            key={row.id}
            row={row}
            onCancel={async () => {
              setError(null);
              try {
                await dialog.confirm({
                  title: 'Stiahnuť ponuku',
                  body: 'Vstupenka sa prestane ponúkať. Vypísať ju môžeš znova.',
                  confirmLabel: 'Stiahnuť',
                  destructive: true,
                });
              } catch {
                return;
              }
              try {
                await cancelResaleListing(row.id);
                await queryClient.invalidateQueries({ queryKey: ['resale'] });
              } catch (caught) {
                setError(messageFor(caught));
              }
            }}
          />
        ))
      )}

      {sold.length > 0 ? (
        <>
          <SectionHeader title="Predané" />
          {sold.map((row) => <ListingCard key={row.id} row={row} />)}
        </>
      ) : null}

      {done.length > 0 ? (
        <>
          <SectionHeader title="Uzavreté" />
          {done.map((row) => <ListingCard key={row.id} row={row} />)}
        </>
      ) : null}
    </Screen>
  );
}

function Cell({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.cell}>
      <Text style={[styles.cellValue, strong && styles.cellValueStrong]}>{value}</Text>
      <Caption style={styles.cellLabel}>{label}</Caption>
    </View>
  );
}

function ListingCard({
  row, onCancel,
}: {
  row: MyResaleListing;
  onCancel?: () => void;
}) {
  const seat = [
    row.section && `Sektor ${row.section}`,
    row.row_label && `rad ${row.row_label}`,
    row.seat_label && `miesto ${row.seat_label}`,
  ].filter(Boolean).join(' · ');

  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View style={styles.cardTitle}>
          <Text style={styles.event} numberOfLines={1}>{row.event_title}</Text>
          <Caption>{formatEventDate(row.event_start_at)}</Caption>
        </View>
        <Mono style={styles.cardPrice}>{formatMoney(row.price_cents, row.currency)}</Mono>
      </View>

      {seat ? <Caption>{seat}</Caption> : null}

      <View style={styles.cardBottom}>
        <StatusPill row={row} />
        {row.seller_net_cents != null ? (
          <Caption style={styles.net}>
            tebe {formatMoney(row.seller_net_cents, row.currency)}
          </Caption>
        ) : null}
        {onCancel ? (
          <Pressable onPress={onCancel} accessibilityRole="button" hitSlop={8}>
            <Text style={styles.cancel}>Stiahnuť</Text>
          </Pressable>
        ) : null}
      </View>

      {/* Skutočné tlačidlo, nie štítok, ktorý sa na tlačidlo hrá. Stav hore
          hovorí, čo sa deje; toto je to, čím sa s tým dá pohnúť. */}
      {row.order_id && row.order_status === 'waiting_for_ticket' ? (
        <Button
          title="Doručiť vstupenku"
          onPress={() => router.push(`/resale/deliver/${row.order_id}`)}
        />
      ) : null}
    </View>
  );
}

/** Stav slovami, ktoré niečo hovoria — nie „ticket_delivered". */
function StatusPill({ row }: { row: MyResaleListing }) {
  const [label, tone] = statusOf(row);
  return (
    <View style={[styles.pill, tone === 'good' && styles.pillGood, tone === 'warn' && styles.pillWarn]}>
      <Text style={[styles.pillLabel, tone === 'good' && styles.pillLabelGood,
                    tone === 'warn' && styles.pillLabelWarn]}>
        {label}
      </Text>
    </View>
  );
}

function statusOf(row: MyResaleListing): [string, 'plain' | 'good' | 'warn'] {
  if (row.status === 'active')    return ['V predaji', 'plain'];
  if (row.status === 'reserved')  return ['Niekto práve platí', 'warn'];
  if (row.status === 'cancelled') return ['Stiahnuté', 'plain'];
  if (row.status === 'expired')   return ['Vypršalo', 'plain'];

  switch (row.order_status) {
    case 'waiting_for_ticket': return ['Čaká na doručenie', 'warn'];
    case 'ticket_delivered':   return ['Doručené', 'good'];
    case 'completed':          return ['Hotovo', 'good'];
    case 'disputed':           return ['Otvorený spor', 'warn'];
    case 'refunded':           return ['Vrátené', 'plain'];
    default:                   return ['Predané', 'good'];
  }
}

const styles = StyleSheet.create({
  money: {
    padding: spacing.md,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  moneyRow: { flexDirection: 'row' },
  cell: { flex: 1, alignItems: 'center', gap: 2 },
  cellValue: { ...typography.body, color: colors.textSecondary },
  cellValueStrong: { ...typography.subheading, color: colors.text },
  cellLabel: { textAlign: 'center' },
  moneyNote: { lineHeight: 18 },

  card: {
    padding: spacing.md,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  cardTitle: { flex: 1 },
  event: { ...typography.bodyStrong, color: colors.text },
  cardPrice: { color: colors.text },
  cardBottom: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  net: { flex: 1 },
  cancel: { ...typography.metaSm, color: colors.danger, fontWeight: '700' },

  pill: {
    paddingHorizontal: spacing.sm, paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.border,
  },
  pillGood: { backgroundColor: colors.successSoft, borderColor: colors.success },
  pillWarn: { backgroundColor: colors.warningSoft, borderColor: colors.warning },
  pillLabel: { ...typography.metaSm, color: colors.textSecondary },
  pillLabelGood: { color: colors.success },
  pillLabelWarn: { color: colors.warning },
});
