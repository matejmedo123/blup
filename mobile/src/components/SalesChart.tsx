import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatMoney } from '@/lib/format';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * The sales curve for one event.
 *
 * Drawn with plain views rather than a charting library: the shape is a column
 * per day plus a cumulative line, and a dependency that ships a canvas renderer
 * to draw twenty rectangles is a poor trade on a page people open on a phone.
 *
 * Two things are deliberate.
 *
 *   · The bars are scaled to the busiest day, and that day's number is printed,
 *     so the axis is stated instead of implied. A chart whose scale you cannot
 *     read is decoration.
 *   · A day with no sales is still a bar of height zero. Dropping empty days
 *     would compress a quiet week into a wall of activity that never happened.
 */

export interface SalesPoint {
  day: string;
  orders: number;
  tickets: number;
  gross_cents: number;
  net_cents: number;
  blup_cents: number;
  cumulative_tickets: number;
}

type Metric = 'tickets' | 'money';

const DAY_NAMES = ['ne', 'po', 'ut', 'st', 'št', 'pi', 'so'];

export function SalesChart({
  data,
  currency = 'EUR',
}: {
  data: SalesPoint[];
  currency?: string;
}) {
  const [metric, setMetric] = useState<Metric>('tickets');
  const [selected, setSelected] = useState<number | null>(null);

  const value = (point: SalesPoint) =>
    metric === 'tickets' ? point.tickets : point.net_cents;

  const peak = useMemo(
    () => Math.max(1, ...data.map((point) => value(point))),
    [data, metric],
  );

  const totals = useMemo(
    () => ({
      tickets: data.reduce((sum, point) => sum + point.tickets, 0),
      net: data.reduce((sum, point) => sum + point.net_cents, 0),
      blup: data.reduce((sum, point) => sum + point.blup_cents, 0),
      best: data.reduce<SalesPoint | null>(
        (best, point) => (!best || point.tickets > best.tickets ? point : best),
        null,
      ),
    }),
    [data],
  );

  const point = selected !== null ? data[selected] : null;

  if (data.length === 0) return null;

  return (
    <View style={styles.card}>
      {/* --- what is being plotted ---------------------------------------- */}
      <View style={styles.head}>
        <View style={styles.flex}>
          <Text style={styles.headValue}>
            {metric === 'tickets'
              ? `${totals.tickets} ${plural(totals.tickets)}`
              : formatMoney(totals.net, currency)}
          </Text>
          <Text style={styles.headLabel}>
            {metric === 'tickets' ? 'predaných za obdobie' : 'tvoja tržba za obdobie'}
          </Text>
        </View>

        <View style={styles.toggle}>
          {(['tickets', 'money'] as Metric[]).map((option) => (
            <Pressable
              key={option}
              onPress={() => { setMetric(option); setSelected(null); }}
              style={[styles.toggleItem, metric === option && styles.toggleItemOn]}
            >
              <Text style={[styles.toggleLabel, metric === option && styles.toggleLabelOn]}>
                {option === 'tickets' ? 'Vstupenky' : 'Tržba'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* --- the plot ------------------------------------------------------ */}
      <View style={styles.plot}>
        <View style={styles.axis}>
          <Text style={styles.axisLabel}>
            {metric === 'tickets' ? String(peak) : formatMoney(peak, currency)}
          </Text>
          <Text style={styles.axisLabel}>0</Text>
        </View>

        <View style={styles.bars}>
          {data.map((entry, index) => {
            const height = Math.round((value(entry) / peak) * 100);
            const on = selected === index;

            return (
              <Pressable
                key={entry.day}
                style={styles.barSlot}
                onPress={() => setSelected(on ? null : index)}
                accessibilityRole="button"
                accessibilityLabel={`${entry.day}: ${entry.tickets} vstupeniek`}
              >
                <View style={styles.barTrack}>
                  <View
                    style={[
                      styles.bar,
                      { height: `${Math.max(height, value(entry) > 0 ? 3 : 1)}%` },
                      value(entry) === 0 && styles.barEmpty,
                      on && styles.barOn,
                    ]}
                  />
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* --- the x axis, thinned so the labels never collide --------------- */}
      <View style={styles.ticks}>
        {data.map((entry, index) => {
          const step = Math.ceil(data.length / 7);
          const show = index % step === 0 || index === data.length - 1;
          const date = new Date(`${entry.day}T00:00:00Z`);

          return (
            <View key={entry.day} style={styles.tickSlot}>
              {show ? (
                <Text style={styles.tick}>
                  {DAY_NAMES[date.getUTCDay()]} {date.getUTCDate()}.
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>

      {/* --- the selected day --------------------------------------------- */}
      {point ? (
        <View style={styles.detail}>
          <Text style={styles.detailDay}>{formatDay(point.day)}</Text>
          <View style={styles.detailRow}>
            <Detail label="Vstupenky" value={String(point.tickets)} />
            <Detail label="Objednávky" value={String(point.orders)} />
            <Detail label="Tvoja tržba" value={formatMoney(point.net_cents, currency)} />
            <Detail label="BLUP" value={formatMoney(point.blup_cents, currency)} />
          </View>
        </View>
      ) : (
        <View style={styles.detail}>
          <Text style={styles.hint}>
            {totals.best && totals.best.tickets > 0
              ? `Najsilnejší deň: ${formatDay(totals.best.day)} — ${totals.best.tickets} ${plural(totals.best.tickets)}.`
              : 'Zatiaľ žiadny predaj v tomto období.'}
            {' '}Klikni na stĺpec pre detail dňa.
          </Text>
        </View>
      )}
    </View>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailCell}>
      <Text style={styles.detailValue}>{value}</Text>
      <Text style={styles.detailLabel}>{label}</Text>
    </View>
  );
}

function plural(count: number): string {
  if (count === 1) return 'vstupenka';
  if (count >= 2 && count <= 4) return 'vstupenky';
  return 'vstupeniek';
}

function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return new Intl.DateTimeFormat('sk-SK', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  }).format(date);
}

const styles = StyleSheet.create({
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    padding: spacing.lg,
    gap: spacing.md,
  },

  head: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  headValue: { ...typography.title, color: colors.text },
  headLabel: { ...typography.metaSm, color: colors.textTertiary, marginTop: 2 },

  toggle: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.chip,
    padding: 3,
  },
  toggleItem: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.chip },
  toggleItemOn: { backgroundColor: colors.accent },
  toggleLabel: { ...typography.chip, fontSize: 12, color: colors.textSecondary },
  toggleLabelOn: { color: '#FFFFFF' },

  plot: { flexDirection: 'row', gap: spacing.sm, height: 132 },
  axis: { justifyContent: 'space-between', paddingVertical: 2 },
  axisLabel: { ...typography.monoSm, color: colors.textMuted },

  bars: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  barSlot: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  barTrack: { height: '100%', justifyContent: 'flex-end' },
  bar: {
    borderRadius: 3,
    backgroundColor: colors.accent,
    minHeight: 2,
  },
  // A quiet day is still a day: it keeps a visible baseline tick so the axis
  // reads as a row of dates rather than a gap in the data.
  barEmpty: { backgroundColor: colors.border, minHeight: 3 },
  barOn: { backgroundColor: colors.purple },

  ticks: { flexDirection: 'row', gap: 2, paddingLeft: 34 },
  tickSlot: { flex: 1, alignItems: 'center' },
  tick: { ...typography.monoSm, fontSize: 9, color: colors.textMuted },

  detail: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
    gap: spacing.sm,
  },
  detailDay: { ...typography.bodyStrong, color: colors.text, textTransform: 'capitalize' },
  detailRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
  detailCell: { minWidth: 74 },
  detailValue: { ...typography.subheading, color: colors.text },
  detailLabel: { ...typography.metaSm, color: colors.textTertiary },

  hint: { ...typography.metaSm, color: colors.textTertiary },
});
