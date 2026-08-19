import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import {
  exportAccountingCsv, getPlatformAccounting, monthRange, yearRange, type DateRange,
} from '@/api/accounting';
import { messageFor } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import {
  Body, Button, Caption, Card, Divider, EmptyState, LoadingState, Mono, Notice, Screen,
  SectionHeader, Segmented,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

type Period = 'this-month' | 'this-year' | 'all';

const PERIODS: { value: Period; label: string }[] = [
  { value: 'this-month', label: 'Tento mesiac' },
  { value: 'this-year', label: 'Tento rok' },
  { value: 'all', label: 'Všetko' },
];

function rangeFor(period: Period): DateRange & { label: string } {
  if (period === 'this-month') return { ...monthRange(0) };
  if (period === 'this-year') return { ...yearRange(0) };
  return { from: null, to: null, label: 'vsetko' };
}

/**
 * BLUP's own books: what the platform earned, split by where it came from.
 *
 * Ticket revenue is commission plus archive fees; boost revenue is money BLUP
 * charged directly. They are shown apart because they are two different
 * businesses with two different unit economics, and averaging them hides which
 * one is actually working.
 */
export default function AdminAccountingScreen() {
  const [period, setPeriod] = useState<Period>('this-year');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const range = useMemo(() => rangeFor(period), [period]);

  const books = useQuery({
    queryKey: ['platform-accounting', range.from, range.to],
    queryFn: () => getPlatformAccounting(range),
  });

  const rows = books.data ?? [];
  const totals = rows.reduce(
    (sum, row) => ({
      orders: sum.orders + row.orders_count,
      tickets: sum.tickets + row.tickets_count,
      net: sum.net + row.net_cents,
      commission: sum.commission + row.commission_cents,
      archive: sum.archive + row.archive_fee_cents,
      ticketRevenue: sum.ticketRevenue + row.ticket_revenue_cents,
      boostRevenue: sum.boostRevenue + row.boost_revenue_cents,
      total: sum.total + row.total_revenue_cents,
      organizers: sum.organizers + row.organizer_net_cents,
      currency: row.currency || sum.currency,
    }),
    {
      orders: 0, tickets: 0, net: 0, commission: 0, archive: 0,
      ticketRevenue: 0, boostRevenue: 0, total: 0, organizers: 0, currency: 'EUR',
    },
  );

  const exportCsv = async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await exportAccountingCsv({
        scope: 'platform',
        range,
        label: `platforma_${range.label}`,
      });
      if (!result.shared) setNotice(`Súbor je pripravený: ${result.uri}`);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  if (books.isLoading) return <Screen><LoadingState /></Screen>;

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Export sa nepodaril" body={error} /> : null}
      {notice ? <Notice tone="accent" title="Hotovo" body={notice} /> : null}

      <Segmented options={PERIODS} value={period} onChange={setPeriod} />

      {rows.length === 0 ? (
        <EmptyState emoji="📕" title="Za toto obdobie nič" body="Zatiaľ neprešla žiadna platba." />
      ) : (
        <>
          <View style={styles.hero}>
            <Caption>Príjem BLUPu</Caption>
            <Text style={styles.heroValue}>{formatMoney(totals.total, totals.currency)}</Text>
            <Caption>{totals.tickets} vstupeniek · {totals.orders} objednávok</Caption>
          </View>

          <Card>
            <SectionHeader title="Odkiaľ to prišlo" />
            <Line label="Provízia z predaja" value={formatMoney(totals.commission, totals.currency)} />
            <Line label="Archívne poplatky" value={formatMoney(totals.archive, totals.currency)} />
            <Line label="Vstupenky spolu" value={formatMoney(totals.ticketRevenue, totals.currency)} strong />
            <Divider />
            <Line label="Boosty" value={formatMoney(totals.boostRevenue, totals.currency)} />
            <Divider />
            <Line label="Spolu" value={formatMoney(totals.total, totals.currency)} strong />
          </Card>

          <Card>
            <SectionHeader title="Cez platformu pretieklo" />
            <Line label="Tržba organizátorov" value={formatMoney(totals.net, totals.currency)} />
            <Line label="Vyplatené organizátorom" value={formatMoney(totals.organizers, totals.currency)} />
            <Caption style={styles.take}>
              Take rate{' '}
              {totals.net > 0 ? ((totals.ticketRevenue / totals.net) * 100).toFixed(1) : '0,0'} %
              z objemu vstupeniek
            </Caption>
          </Card>

          <SectionHeader title="Po mesiacoch" />
          {rows.map((row) => (
            <Card key={row.period} style={styles.monthCard}>
              <View style={styles.monthHead}>
                <Mono style={styles.monthLabel}>{row.period}</Mono>
                <Body style={styles.monthValue}>
                  {formatMoney(row.total_revenue_cents, row.currency)}
                </Body>
              </View>
              <Caption>
                vstupenky {formatMoney(row.ticket_revenue_cents, row.currency)} · boosty{' '}
                {formatMoney(row.boost_revenue_cents, row.currency)}
              </Caption>
            </Card>
          ))}
        </>
      )}

      <Button
        title="Exportovať CSV"
        variant="secondary"
        loading={busy}
        onPress={() => void exportCsv()}
      />
    </Screen>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.line}>
      <Body muted={!strong}>{label}</Body>
      <Text style={strong ? styles.valueStrong : styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xl,
    marginTop: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  heroValue: { ...typography.title, color: colors.text },
  line: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
    gap: spacing.md,
  },
  value: { ...typography.body, color: colors.textSecondary },
  valueStrong: { ...typography.bodyStrong, color: colors.text },
  take: { marginTop: spacing.sm },
  monthCard: { marginBottom: spacing.sm },
  monthHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  monthLabel: { color: colors.textTertiary },
  monthValue: { ...typography.bodyStrong, color: colors.text },
});
