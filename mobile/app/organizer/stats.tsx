import React, { useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import {
  getCheckoutFunnel, getMyOrganizations, getSalesByCity, getSalesByEvent, getSalesByMethod,
  getSalesByTicketType, getSalesRows, getSalesTotals, type SalesScope,
} from '@/api/organizations';
import { SalesMap } from '@/components/SalesMap';
import { useLayout } from '@/hooks/useLayout';
import { csvMoney, toCsv } from '@/lib/csv';
import { saveTextFile } from '@/lib/download';
import { messageFor } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import {
  Body, Button, Caption, Divider, EmptyState, ErrorState, LoadingState, Notice,
  Screen, SectionHeader, Segmented,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

type RangeKey = 'today' | 'week' | 'month' | 'quarter' | 'all';

const RANGES: { value: RangeKey; label: string }[] = [
  { value: 'today', label: 'Dnes' },
  { value: 'week', label: '7 dní' },
  { value: 'month', label: '30 dní' },
  { value: 'quarter', label: '90 dní' },
  { value: 'all', label: 'Celé' },
];

/** The window a range key stands for, as the database wants it. */
function rangeToScope(key: RangeKey): { from: string | null; to: string | null } {
  if (key === 'all') return { from: null, to: null };

  const days = key === 'today' ? 1 : key === 'week' ? 7 : key === 'month' ? 30 : 90;
  const from = new Date();
  if (key === 'today') from.setHours(0, 0, 0, 0);
  else from.setTime(from.getTime() - days * 24 * 3600 * 1000);

  return { from: from.toISOString(), to: new Date().toISOString() };
}

/**
 * Sales, across every event at once.
 *
 * The per-event screen answers "how did this one go". This answers the
 * questions that only make sense together: which event is carrying the others,
 * which ticket type to print more of, which city to advertise in next, and how
 * many people started paying and walked away.
 *
 * Every number comes from one of the `sales_*` functions, which are scoped in
 * the database to events this person actually runs. Nothing here is filtered in
 * the browser for safety — the filters are for choosing what to look at.
 */
export default function SalesStatsScreen() {
  const layout = useLayout();
  const [range, setRange] = useState<RangeKey>('month');
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const organizations = useQuery({
    queryKey: ['organizations', 'mine'],
    queryFn: getMyOrganizations,
  });

  const scope: SalesScope = useMemo(() => rangeToScope(range), [range]);
  const key = [range] as const;

  const totals = useQuery({ queryKey: ['sales', 'totals', ...key], queryFn: () => getSalesTotals(scope) });
  const byEvent = useQuery({ queryKey: ['sales', 'events', ...key], queryFn: () => getSalesByEvent(scope) });
  const byType = useQuery({ queryKey: ['sales', 'types', ...key], queryFn: () => getSalesByTicketType(scope) });
  const byMethod = useQuery({ queryKey: ['sales', 'methods', ...key], queryFn: () => getSalesByMethod(scope) });
  const byCity = useQuery({ queryKey: ['sales', 'cities', ...key], queryFn: () => getSalesByCity(scope) });
  const funnel = useQuery({ queryKey: ['sales', 'funnel', ...key], queryFn: () => getCheckoutFunnel(scope) });

  const exportCsv = async () => {
    setError(null);
    setNotice(null);
    setExporting(true);
    try {
      const rows = await getSalesRows(scope);
      if (rows.length === 0) {
        setNotice('V tomto období nie je čo exportovať.');
        return;
      }

      const csv = toCsv(
        [
          { key: 'paid_at', label: 'Zaplatené' },
          { key: 'event_title', label: 'Event' },
          { key: 'ticket_type', label: 'Typ vstupenky' },
          { key: 'quantity', label: 'Počet' },
          { key: 'gross', label: 'Tržba' },
          { key: 'discount', label: 'Zľava' },
          { key: 'commission', label: 'Provízia BLUP' },
          { key: 'archive', label: 'Archívny poplatok' },
          { key: 'net', label: 'Tvoj čistý príjem' },
          { key: 'currency', label: 'Mena' },
          { key: 'buyer', label: 'Kupujúci' },
          { key: 'email', label: 'E-mail' },
          { key: 'city', label: 'Mesto' },
          { key: 'account', label: 'Účet' },
          { key: 'order_id', label: 'Objednávka' },
        ],
        rows.map((row) => ({
          paid_at: row.paid_at ? new Date(row.paid_at).toLocaleString('sk-SK') : '',
          event_title: row.event_title,
          ticket_type: row.ticket_type ?? '',
          quantity: row.quantity,
          gross: csvMoney(row.gross_cents),
          discount: csvMoney(row.discount_cents),
          commission: csvMoney(row.commission_cents),
          archive: csvMoney(row.archive_fee_cents),
          net: csvMoney(row.organizer_net_cents),
          currency: row.currency,
          buyer: row.buyer,
          email: row.email ?? '',
          city: row.city ?? '',
          account: row.has_account ? 'áno' : 'bez účtu',
          order_id: row.order_id,
        })),
      );

      const stamp = new Date().toISOString().slice(0, 10);
      const result = await saveTextFile(`blup_predaj_${range}_${stamp}.csv`, csv);
      setNotice(
        result.shared
          ? `Export hotový — ${rows.length} objednávok.`
          : `Uložené do ${result.uri}`,
      );
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setExporting(false);
    }
  };

  if (totals.isLoading) return <Screen><LoadingState /></Screen>;

  if (totals.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(totals.error)} onRetry={() => void totals.refetch()} />
      </Screen>
    );
  }

  const data = totals.data;
  const currency = data?.currency ?? 'EUR';
  const cities = byCity.data ?? [];
  const locatedCities = cities.filter((city) => city.latitude != null);
  const f = funnel.data;

  // Against the same length of time immediately before. A number on its own
  // does not say whether it is going the right way.
  const change = data && data.prev_gross_cents > 0
    ? Math.round(((data.gross_cents - data.prev_gross_cents) / data.prev_gross_cents) * 100)
    : null;

  const hasAnything = (data?.orders_total ?? 0) > 0 || (data?.tickets ?? 0) > 0;

  return (
    <Screen scroll>
      <SectionHeader title="Predaj" />
      <Caption style={styles.intro}>
        Naprieč všetkými tvojimi eventmi. Vidíš len to, čo naozaj organizuješ.
      </Caption>

      <Segmented options={RANGES} value={range} onChange={setRange} style={styles.ranges} />

      {error ? <Notice tone="danger" title="Nepodarilo sa" body={error} /> : null}
      {notice ? <Notice tone="success" title="Hotovo" body={notice} /> : null}

      {!hasAnything ? (
        <EmptyState
          emoji="📈"
          title="V tomto období sa nič nepredalo"
          body="Skús dlhšie obdobie, alebo je toto ten moment, kedy sa robí prvý event."
          actionLabel="Vytvoriť event"
          onAction={() => router.push('/organizer/create')}
        />
      ) : null}

      {/* --- the tiles ---------------------------------------------------- */}
      <View style={[styles.grid, layout.isWide && styles.gridWide]}>
        <Tile
          label="Tržba"
          value={formatMoney(data?.gross_cents ?? 0, currency)}
          hint={
            change === null
              ? `${data?.tickets ?? 0} vstupeniek`
              : `${change >= 0 ? '+' : ''}${change} % oproti predchádzajúcemu obdobiu`
          }
          tone={change === null ? undefined : change >= 0 ? 'success' : 'danger'}
        />
        <Tile
          label="Tvoj čistý príjem"
          value={formatMoney(data?.organizer_net_cents ?? 0, currency)}
          hint={`Po provízii ${formatMoney(data?.commission_cents ?? 0, currency)}`}
        />
        <Tile
          label="Vstupenky"
          value={String(data?.tickets ?? 0)}
          hint={`${data?.orders_paid ?? 0} objednávok · ${data?.complimentary ?? 0} zdarma`}
        />
        <Tile
          label="Odbavených"
          value={`${data?.checked_in_pct ?? 0} %`}
          hint={`${data?.tickets_used ?? 0} z ${(data?.tickets_valid ?? 0) + (data?.tickets_used ?? 0)}`}
        />
      </View>

      {/* --- the funnel --------------------------------------------------- */}
      <SectionHeader title="Úspešnosť objednávok" />
      <Caption style={styles.intro}>
        Koľko ľudí začalo platiť a koľko to dokončilo. Objednávka, ktorá bola zaplatená a neskôr
        vrátená, sa tu ráta ako dokončená — refundácia nie je opustená pokladňa.
      </Caption>

      {f ? (
        <View style={styles.panel}>
          <View style={styles.funnelRow}>
            <FunnelStep label="Otvorili event" value={f.views} of={f.views} />
            <FunnelStep label="Dali do košíka" value={f.baskets} of={f.views} />
            <FunnelStep label="Začali platiť" value={f.started} of={f.views} />
            <FunnelStep label="Zaplatili" value={f.paid} of={f.views} highlight />
          </View>

          <Divider />

          <View style={styles.summaryRow}>
            <Body>Dokončené platby</Body>
            <Text style={[
              styles.summaryValue,
              f.success_pct >= 70 ? styles.good : f.success_pct >= 40 ? styles.warn : styles.bad,
            ]}>
              {f.success_pct} %
            </Text>
          </View>
          <View style={styles.summaryRow}>
            <Body muted>Odišlo z pokladne</Body>
            <Body muted>
              {f.abandoned} {f.abandoned === 1 ? 'objednávka' : 'objednávok'}
              {f.abandoned_cents > 0 ? ` · ${formatMoney(f.abandoned_cents, currency)}` : ''}
            </Body>
          </View>
          {f.expired > 0 || f.failed > 0 ? (
            <View style={styles.summaryRow}>
              <Caption>
                Z toho {f.expired} vypršalo (rezervácia má 30 minút)
                {f.failed > 0 ? ` a ${f.failed} odmietla banka` : ''}.
              </Caption>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* --- where they are from ------------------------------------------ */}
      <SectionHeader title="Odkiaľ ľudia kupujú" />
      <Caption style={styles.intro}>
        Mesto, ktoré kupujúci zadal — u prihlásených z ich profilu. Podľa toho vieš, kde má zmysel
        robiť ďalší event a kde inzerovať.
      </Caption>

      {Platform.OS === 'web' ? (
        <SalesMap points={locatedCities} height={layout.isWide ? 380 : 280} />
      ) : null}

      {cities.length === 0 ? (
        <Caption style={styles.empty}>Zatiaľ žiadne mesto — objaví sa tu po prvom predaji.</Caption>
      ) : (
        <View style={styles.panel}>
          {cities.slice(0, 12).map((city, index) => (
            <View key={city.city} style={styles.row}>
              <Text style={styles.rank}>{index + 1}</Text>
              <View style={styles.flex}>
                <Text style={styles.rowTitle}>{city.city}</Text>
                <Caption>{city.orders} {city.orders === 1 ? 'objednávka' : 'objednávok'}</Caption>
              </View>
              <View style={styles.rowRight}>
                <Text style={styles.rowValue}>{city.tickets}</Text>
                <Caption>{formatMoney(city.gross_cents, currency)}</Caption>
              </View>
            </View>
          ))}
          {cities.length > locatedCities.length ? (
            <Caption style={styles.footnote}>
              {cities.length - locatedCities.length} {cities.length - locatedCities.length === 1
                ? 'mesto nemá súradnice, takže nie je na mape'
                : 'miest nemá súradnice, takže nie sú na mape'} — v zozname sú.
            </Caption>
          ) : null}
        </View>
      )}

      {/* --- per event ----------------------------------------------------- */}
      <SectionHeader title="Podľa eventu" />
      {(byEvent.data ?? []).length === 0 ? (
        <Caption style={styles.empty}>Žiadne eventy v tomto období.</Caption>
      ) : (
        <View style={styles.panel}>
          {(byEvent.data ?? []).map((row) => (
            <Pressable
              key={row.event_id}
              style={styles.row}
              onPress={() => router.push(`/organizer/analytics/${row.event_id}`)}
            >
              <View style={styles.flex}>
                <Text style={styles.rowTitle}>{row.title}</Text>
                <Caption>
                  {new Date(row.start_at).toLocaleDateString('sk-SK')}
                  {row.city ? ` · ${row.city}` : ''}
                  {row.checked_in > 0 ? ` · ${row.checked_in} prišlo` : ''}
                </Caption>
              </View>
              <View style={styles.rowRight}>
                <Text style={styles.rowValue}>{formatMoney(row.gross_cents, row.currency)}</Text>
                <Caption>{row.tickets} vstupeniek</Caption>
              </View>
            </Pressable>
          ))}
        </View>
      )}

      {/* --- per ticket type ----------------------------------------------- */}
      <SectionHeader title="Podľa typu vstupenky" />
      {(byType.data ?? []).length === 0 ? (
        <Caption style={styles.empty}>Žiadne typy vstupeniek.</Caption>
      ) : (
        <View style={styles.panel}>
          {(byType.data ?? []).map((row) => (
            <View key={row.ticket_type_id} style={styles.row}>
              <View style={styles.flex}>
                <Text style={styles.rowTitle}>{row.name}</Text>
                <Caption>{row.event_title} · {formatMoney(row.price_cents, row.currency)}</Caption>
              </View>
              <View style={styles.rowRight}>
                <Text style={styles.rowValue}>{row.sold}</Text>
                <Caption>{row.remaining > 0 ? `${row.remaining} zostáva` : 'vypredané'}</Caption>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* --- how they paid -------------------------------------------------- */}
      {(byMethod.data ?? []).length > 0 ? (
        <>
          <SectionHeader title="Ako platili" />
          <View style={styles.panel}>
            {(byMethod.data ?? []).map((row) => (
              <View key={row.method} style={styles.row}>
                <View style={styles.flex}>
                  <Text style={styles.rowTitle}>{row.method}</Text>
                  <Caption>{row.orders} {row.orders === 1 ? 'objednávka' : 'objednávok'}</Caption>
                </View>
                <View style={styles.rowRight}>
                  <Text style={styles.rowValue}>{formatMoney(row.gross_cents, row.currency)}</Text>
                  <Caption>{row.tickets} vstupeniek</Caption>
                </View>
              </View>
            ))}
          </View>
        </>
      ) : null}

      {/* --- the money ----------------------------------------------------- */}
      <SectionHeader title="Peniaze" />
      <View style={styles.panel}>
        <MoneyRow label="Tržba v cenníku" value={formatMoney(data?.gross_cents ?? 0, currency)} />
        {(data?.discount_cents ?? 0) > 0 ? (
          <MoneyRow label="Zľavy" value={`− ${formatMoney(data?.discount_cents ?? 0, currency)}`} />
        ) : null}
        <MoneyRow label="Provízia BLUP" value={`− ${formatMoney(data?.commission_cents ?? 0, currency)}`} />
        {(data?.archive_fee_cents ?? 0) > 0 ? (
          <MoneyRow
            label="Archívny poplatok"
            value={formatMoney(data?.archive_fee_cents ?? 0, currency)}
          />
        ) : null}
        {(data?.refunded_orders ?? 0) > 0 ? (
          <MoneyRow
            label={`Vrátené (${data?.refunded_orders})`}
            value={`− ${formatMoney(data?.refunded_cents ?? 0, currency)}`}
          />
        ) : null}
        <Divider />
        <MoneyRow
          label="Tvoj čistý príjem"
          value={formatMoney(data?.organizer_net_cents ?? 0, currency)}
          strong
        />

        {data?.available_cents !== undefined ? (
          <>
            <Divider />
            <MoneyRow label="Na výplatu teraz" value={formatMoney(data.available_cents ?? 0, currency)} />
            <MoneyRow label="Ešte sa drží" value={formatMoney(data.pending_cents ?? 0, currency)} />
            {(data.reserve_cents ?? 0) > 0 ? (
              <MoneyRow label="Z toho rezerva" value={formatMoney(data.reserve_cents ?? 0, currency)} />
            ) : null}
            {(data.paid_out_cents ?? 0) > 0 ? (
              <MoneyRow label="Už vyplatené" value={formatMoney(data.paid_out_cents ?? 0, currency)} />
            ) : null}
          </>
        ) : null}
      </View>

      {(data?.disputes_open ?? 0) > 0 ? (
        <Notice
          tone="danger"
          title={`${data?.disputes_open} otvorený spor`}
          body={
            `Kým sa spor neuzavrie, výplaty organizácie sú zmrazené. Ide o `
            + `${formatMoney(data?.disputes_open_cents ?? 0, currency)}.`
          }
        />
      ) : null}

      <Button
        title="Stiahnuť ako CSV"
        variant="secondary"
        loading={exporting}
        onPress={() => void exportCsv()}
        style={styles.export}
      />
      <Caption style={styles.footnote}>
        Jeden riadok na objednávku, presne tie isté čísla ako vyššie — vrátane mena, e-mailu a mesta
        kupujúceho. Sú to osobné údaje, tak s tým súborom podľa toho aj zaobchádzaj.
      </Caption>

      {organizations.data && organizations.data.length === 0 ? (
        <Notice
          tone="accent"
          title="Zatiaľ bez organizácie"
          body="Predaj vstupeniek potrebuje overenú organizáciu. Eventy zdarma vieš robiť aj bez nej."
        />
      ) : null}
    </Screen>
  );
}

function Tile({
  label, value, hint, tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'success' | 'danger';
}) {
  return (
    <View style={styles.tile}>
      <Caption>{label}</Caption>
      <Text style={styles.tileValue}>{value}</Text>
      {hint ? (
        <Text style={[
          styles.tileHint,
          tone === 'success' && styles.good,
          tone === 'danger' && styles.bad,
        ]}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

function FunnelStep({
  label, value, of, highlight,
}: {
  label: string;
  value: number;
  of: number;
  highlight?: boolean;
}) {
  // Width relative to the widest step, so the shape of the drop-off is visible
  // at a glance rather than having to be read off four numbers.
  const share = of > 0 ? Math.max(value / of, 0.04) : 0.04;

  return (
    <View style={styles.funnelStep}>
      <Text style={[styles.funnelValue, highlight && styles.funnelValueOn]}>{value}</Text>
      <View style={styles.funnelTrack}>
        <View
          style={[
            styles.funnelFill,
            { width: `${Math.round(share * 100)}%` },
            highlight && styles.funnelFillOn,
          ]}
        />
      </View>
      <Caption>{label}</Caption>
    </View>
  );
}

function MoneyRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.summaryRow}>
      <Caption>{label}</Caption>
      <Text style={[styles.summaryValue, strong && styles.summaryValueStrong]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
  intro: { marginBottom: spacing.md },
  ranges: { marginBottom: spacing.lg },
  empty: { marginBottom: spacing.lg },
  export: { marginTop: spacing.lg },
  footnote: { marginTop: spacing.sm, lineHeight: 18 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginBottom: spacing.lg },
  gridWide: { flexWrap: 'nowrap' },
  tile: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 150,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: 2,
  },
  tileValue: { ...typography.title, color: colors.text },
  tileHint: { ...typography.caption, color: colors.textSecondary },
  good: { color: colors.success },
  warn: { color: colors.warning },
  bad: { color: colors.danger },

  panel: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },

  funnelRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.sm },
  funnelStep: { flex: 1, gap: spacing.xs },
  funnelValue: { ...typography.subheading, color: colors.textSecondary },
  funnelValueOn: { color: colors.text },
  funnelTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceElevated,
    overflow: 'hidden',
  },
  funnelFill: { height: 6, borderRadius: 3, backgroundColor: colors.textTertiary },
  funnelFillOn: { backgroundColor: colors.accent },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rank: { ...typography.monoStrong, color: colors.textTertiary, width: 20 },
  rowTitle: { ...typography.bodyStrong, color: colors.text },
  rowRight: { alignItems: 'flex-end' },
  rowValue: { ...typography.bodyStrong, color: colors.text },

  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  summaryValue: { ...typography.body, color: colors.textSecondary },
  summaryValueStrong: { ...typography.subheading, color: colors.text },
});
