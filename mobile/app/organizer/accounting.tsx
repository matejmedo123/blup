import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import {
  exportAccountingCsv, getAccountingSummary, monthRange, yearRange,
  type AccountingSummaryRow, type DateRange,
} from '@/api/accounting';
import { getMyOrganizations } from '@/api/organizations';
import { messageFor } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import {
  Body, Button, Caption, Card, Divider, EmptyState, LoadingState, Mono, Notice, Screen,
  SectionHeader, Segmented,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

type Period = 'this-month' | 'last-month' | 'this-year' | 'all';

const PERIODS: { value: Period; label: string }[] = [
  { value: 'this-month', label: 'Tento mesiac' },
  { value: 'last-month', label: 'Minulý' },
  { value: 'this-year', label: 'Tento rok' },
  { value: 'all', label: 'Všetko' },
];

function rangeFor(period: Period): DateRange & { label: string } {
  switch (period) {
    case 'this-month': return { ...monthRange(0) };
    case 'last-month': return { ...monthRange(1) };
    case 'this-year':  return { ...yearRange(0) };
    case 'all':        return { from: null, to: null, label: 'vsetko' };
  }
}

/** Adds up several months into the one figure the organizer actually wants. */
function totals(rows: AccountingSummaryRow[]) {
  return rows.reduce(
    (sum, row) => ({
      orders: sum.orders + row.orders_count,
      tickets: sum.tickets + row.tickets_count,
      gross: sum.gross + row.gross_cents,
      discount: sum.discount + row.discount_cents,
      net: sum.net + row.net_cents,
      commission: sum.commission + row.commission_cents,
      archive: sum.archive + row.archive_fee_cents,
      blup: sum.blup + row.blup_revenue_cents,
      organizer: sum.organizer + row.organizer_net_cents,
      refunded: sum.refunded + row.refunded_cents,
      currency: row.currency || sum.currency,
    }),
    {
      orders: 0, tickets: 0, gross: 0, discount: 0, net: 0,
      commission: 0, archive: 0, blup: 0, organizer: 0, refunded: 0,
      currency: 'EUR',
    },
  );
}

/**
 * Účtovníctvo.
 *
 * Everything on this screen is computed by the database and only rendered here,
 * and the CSV is rendered by the server from those same functions. There is no
 * second implementation of the arithmetic to drift out of sync — which is the
 * only way an export is worth handing to an accountant.
 */
export default function AccountingScreen() {
  const [period, setPeriod] = useState<Period>('this-month');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const organizations = useQuery({ queryKey: ['organizations', 'mine'], queryFn: getMyOrganizations });
  const organization = organizations.data?.[0];

  const range = useMemo(() => rangeFor(period), [period]);

  const summary = useQuery({
    queryKey: ['accounting', organization?.id, range.from, range.to],
    queryFn: () => getAccountingSummary(organization!.id, range),
    enabled: Boolean(organization?.id),
  });

  const exportCsv = async (scope: 'orders' | 'ledger' | 'summary') => {
    if (!organization) return;
    setError(null);
    setNotice(null);
    setBusy(scope);
    try {
      const result = await exportAccountingCsv({
        scope,
        organizationId: organization.id,
        range,
        label: `${scope}_${range.label}`,
      });
      if (!result.shared) {
        setNotice(`Súbor je pripravený: ${result.uri}`);
      }
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  if (organizations.isLoading) return <Screen><LoadingState /></Screen>;

  if (!organization) {
    return (
      <Screen>
        <EmptyState
          emoji="🏢"
          title="Žiadna organizácia"
          body="Účtovníctvo sa vedie na organizáciu. Najprv si nejakú vytvor."
        />
      </Screen>
    );
  }

  const rows = summary.data ?? [];
  const sum = totals(rows);

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Export sa nepodaril" body={error} /> : null}
      {notice ? <Notice tone="accent" title="Hotovo" body={notice} /> : null}

      <Segmented options={PERIODS} value={period} onChange={setPeriod} />

      {summary.isLoading ? (
        <LoadingState label="Počítam…" />
      ) : rows.length === 0 ? (
        <EmptyState
          emoji="📕"
          title="Za toto obdobie nič"
          body="Keď predáš prvú vstupenku, objaví sa tu presný rozpis aj export."
        />
      ) : (
        <>
          <View style={styles.hero}>
            <Caption>Tvoj čistý príjem</Caption>
            <Text style={styles.heroValue}>{formatMoney(sum.organizer, sum.currency)}</Text>
            <Caption>
              {sum.orders} {sum.orders === 1 ? 'objednávka' : 'objednávok'} · {sum.tickets} vstupeniek
            </Caption>
          </View>

          <Card>
            <SectionHeader title="Rozpis" />
            <Line label="Predaj v cenníku" value={formatMoney(sum.gross, sum.currency)} />
            {sum.discount > 0 ? (
              <Line label="Zľavy z promo kódov" value={`− ${formatMoney(sum.discount, sum.currency)}`} tone="warning" />
            ) : null}
            <Line label="Tržba po zľavách" value={formatMoney(sum.net, sum.currency)} strong />
            <Divider />
            <Line
              label="Provízia BLUP"
              value={`− ${formatMoney(sum.commission, sum.currency)}`}
              tone="danger"
            />
            <Line
              label="Archívny poplatok"
              hint={`${sum.tickets} × 1,00 € · platí ho kupujúci`}
              value={formatMoney(sum.archive, sum.currency)}
              tone="muted"
            />
            <Divider />
            <Line label="Tvoj čistý príjem" value={formatMoney(sum.organizer, sum.currency)} strong />
            {sum.refunded > 0 ? (
              <Line label="Vrátené" value={`− ${formatMoney(sum.refunded, sum.currency)}`} tone="danger" />
            ) : null}
          </Card>

          <Caption style={styles.feeNote}>
            Archívny poplatok platí kupujúci navyše k cene vstupenky, takže ti z tržby neuberá.
            Provízia sa počíta zo sumy po zľavách — z toho, čo naozaj prišlo.
          </Caption>

          {rows.length > 1 ? (
            <>
              <SectionHeader title="Po mesiacoch" />
              {rows.map((row) => (
                <Card key={row.period} style={styles.monthCard}>
                  <View style={styles.monthHead}>
                    <Mono style={styles.monthLabel}>{row.period}</Mono>
                    <Body style={styles.monthValue}>
                      {formatMoney(row.organizer_net_cents, row.currency)}
                    </Body>
                  </View>
                  <Caption>
                    {row.tickets_count} vstupeniek · provízia{' '}
                    {formatMoney(row.commission_cents, row.currency)} · archív{' '}
                    {formatMoney(row.archive_fee_cents, row.currency)}
                  </Caption>
                </Card>
              ))}
            </>
          ) : null}
        </>
      )}

      <SectionHeader title="Export pre účtovníka" />
      <Caption style={styles.exportNote}>
        CSV v kódovaní UTF-8, sumy v desatinných číslach. Otvoríš to v Exceli, Google Sheets aj
        v účtovnom softvéri.
      </Caption>

      <Button
        title="Predajný denník"
        variant="secondary"
        loading={busy === 'orders'}
        onPress={() => void exportCsv('orders')}
      />
      <Button
        title="Kniha pohybov"
        variant="secondary"
        loading={busy === 'ledger'}
        onPress={() => void exportCsv('ledger')}
      />
      <Button
        title="Mesačný súhrn"
        variant="secondary"
        loading={busy === 'summary'}
        onPress={() => void exportCsv('summary')}
      />
    </Screen>
  );
}

function Line({
  label, value, hint, strong, tone,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
  tone?: 'danger' | 'warning' | 'muted';
}) {
  const color = tone === 'danger'
    ? colors.danger
    : tone === 'warning'
      ? colors.warning
      : tone === 'muted'
        ? colors.textTertiary
        : colors.text;

  return (
    <View style={styles.line}>
      <View style={styles.lineLabel}>
        <Body muted={!strong}>{label}</Body>
        {hint ? <Caption>{hint}</Caption> : null}
      </View>
      <Text style={[strong ? styles.lineValueStrong : styles.lineValue, { color }]}>{value}</Text>
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
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  lineLabel: { flex: 1 },
  lineValue: { ...typography.body },
  lineValueStrong: { ...typography.bodyStrong },

  feeNote: { marginTop: spacing.sm },
  exportNote: { marginBottom: spacing.md },

  monthCard: { marginBottom: spacing.sm },
  monthHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  monthLabel: { color: colors.textTertiary },
  monthValue: { ...typography.bodyStrong, color: colors.text },
});
