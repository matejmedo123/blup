import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getSeatMap, holdSeat, holdSeats, releaseSeat, suggestSeats,
  SEAT_KIND_LABEL, type Seat, type SeatKind, type Section,
} from '@/api/seating';
import { addToCart } from '@/api/cart';
import { messageFor } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import {
  Body, Button, Caption, EmptyState, ErrorState, LoadingState, Notice, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Picking a place.
 *
 * The plan is a picture the organizer uploaded — a photo of a paper layout is
 * fine, and for a while that is all anyone will have. What matters is the
 * rectangles drawn on it: those are rows in the database, stored as fractions
 * of the image, so re-photographing the plan does not move a single sector.
 *
 * A sector with named seats opens into them; one without is an ordinary ticket
 * type and adds to the basket by count. Both hold stock the same way and for
 * the same fifteen minutes, because a sector *is* a ticket type — which is why
 * the money, the ceiling and the promo split need no special case here.
 *
 * Three things this screen learned since the first version.
 *
 * Almost nobody comes alone, and clicking four dots that turn out to be in four
 * different rows is not a feature. "Nájdi nám miesta vedľa seba" asks the
 * database for the best block and holds all of it or none of it.
 *
 * A hold ends. It used to end silently, and the buyer found out at the till.
 * There is a clock now.
 *
 * And a seat you have already paid for looked exactly like a seat you are
 * holding — same dot, same colour — so tapping it looked like it should give it
 * back, and did nothing. The map says which is which, and so does the plan.
 */
export default function SeatPickerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { width } = useWindowDimensions();

  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [party, setParty] = useState(2);
  /** Ticks once a second so the hold clock counts down rather than sitting still. */
  const [now, setNow] = useState(() => Date.now());

  const seatMap = useQuery({
    queryKey: ['event', id, 'seatmap'],
    queryFn: () => getSeatMap(id!),
    enabled: Boolean(id),
  });

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (seatMap.isLoading) return <Screen><LoadingState label="Načítavam plán…" /></Screen>;
  if (seatMap.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(seatMap.error)} onRetry={() => void seatMap.refetch()} />
      </Screen>
    );
  }

  if (!seatMap.data) {
    return (
      <Screen>
        <EmptyState
          emoji="🎫"
          title="Tento event nemá plán"
          body="Vstupenky sa naň predávajú bez výberu miesta."
          actionLabel="Späť na event"
          onAction={() => router.back()}
        />
      </Screen>
    );
  }

  const { map, sections } = seatMap.data;

  // Held by id rather than by value: the section object is replaced on every
  // refetch, and holding the old one would leave the dots showing the state
  // from before the click that changed them.
  const open = sections.find((section) => section.id === openId) ?? null;

  // Everything being held across the whole plan, not just the open sector — the
  // basket is one basket and the clock on it is one clock.
  const heldEverywhere = sections.flatMap((section) =>
    section.seats.filter((seat) => seat.mine_claim === 'held')
      .map((seat) => ({ section: section.name, seat })));

  const holdEndsAt = heldEverywhere
    .map(({ seat }) => (seat.hold_until ? Date.parse(seat.hold_until) : NaN))
    .filter((t) => Number.isFinite(t))
    .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);

  const secondsLeft = Number.isFinite(holdEndsAt)
    ? Math.max(0, Math.round((holdEndsAt - now) / 1000))
    : 0;

  /** How many seats each row actually holds, for centring the short ones. */
  const seatsPerRow = new Map<number, number>();
  for (const seat of open?.seats ?? []) {
    seatsPerRow.set(seat.row_index, (seatsPerRow.get(seat.row_index) ?? 0) + 1);
  }

  // The plan is drawn at whatever width there is; the sectors are fractions of
  // it, so one scale factor positions all of them.
  const planWidth = Math.min(width - spacing.gutter * 2, 720);
  const planHeight = planWidth * (map.image_height / map.image_width);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['event', id, 'seatmap'] });

  const pick = async (section: Section) => {
    setError(null);
    setNote(null);
    if (section.available === 0) {
      setError(`${section.name} je vypredaný.`);
      return;
    }
    if (section.numbered) { setOpenId(section.id); return; }

    if (!section.ticket_type_id) { setError('Tento sektor zatiaľ nie je v predaji.'); return; }
    setBusy(true);
    try {
      await addToCart(section.ticket_type_id, 1);
      setNote(`${section.name} pridaný do košíka.`);
      await refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const tapSeat = async (seat: Seat) => {
    setError(null);
    setNote(null);

    // Already bought. Nothing to do, and saying so beats a tap that looks
    // broken — which is exactly what this did before the map told them apart.
    if (seat.mine_claim === 'sold' || seat.mine_claim === 'ordered') {
      setNote(`Rad ${seat.row}, miesto ${seat.number} už máš kúpené.`);
      return;
    }

    setBusy(true);
    try {
      if (seat.mine_claim === 'held') {
        await releaseSeat(seat.id);
      } else {
        const held = await holdSeat(seat.id);
        setNote(`Držíme ti ${held.section}, rad ${held.row}, miesto ${held.number}.`);
      }
      await refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  /** "Find us seats next to each other." */
  const findTogether = async (section: Section) => {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const found = await suggestSeats(section.id, party);
      if (found.length === 0) {
        setError(
          `V sektore ${section.name} už nie je ${party} voľných miest vedľa seba. `
          + 'Skús menej miest alebo iný sektor.',
        );
        return;
      }

      await holdSeats(found.map((s) => s.seat_id));
      setNote(
        `Držíme ti rad ${found[0].row_label}, miesta `
        + `${found.map((s) => s.seat_number).join(', ')}.`,
      );
      setOpenId(section.id);
      await refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const releaseAll = async () => {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      for (const { seat } of heldEverywhere) await releaseSeat(seat.id);
      await refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll>
      <Text style={styles.title}>{map.name}</Text>
      <Body muted style={styles.intro}>
        Vyber sektor. Pri číslovaných uvidíš aj konkrétne miesta.
      </Body>

      {error ? <Notice tone="danger" title="Nedá sa" body={error} /> : null}
      {note ? <Notice tone="success" title="Hotovo" body={note} /> : null}

      {/* --- the clock, whenever anything is being held --------------------- */}
      {heldEverywhere.length > 0 ? (
        <View style={styles.holdBar}>
          <View style={styles.flex}>
            <Text style={styles.holdTitle}>
              {heldEverywhere.length === 1
                ? 'Držíme ti 1 miesto'
                : `Držíme ti ${heldEverywhere.length} ${heldEverywhere.length < 5 ? 'miesta' : 'miest'}`}
            </Text>
            <Caption>
              {heldEverywhere
                .map(({ section, seat }) => `${section} · ${seat.row}${seat.number}`)
                .join(' · ')}
            </Caption>
          </View>
          <Text style={[styles.clock, secondsLeft <= 60 && styles.clockLow]}>
            {secondsLeft > 0 ? mmss(secondsLeft) : '—'}
          </Text>
        </View>
      ) : null}

      <View style={[styles.plan, { width: planWidth, height: planHeight }]}>
        {map.image_url ? (
          <Image source={{ uri: map.image_url }} style={StyleSheet.absoluteFill} contentFit="contain" />
        ) : (
          <View style={styles.planEmpty}>
            <Caption>Organizátor nenahral obrázok plánu — sektory sú nižšie.</Caption>
          </View>
        )}

        {sections.map((section) => {
          const soldOut = section.available === 0;
          return (
            <Pressable
              key={section.id}
              onPress={() => pick(section)}
              accessibilityRole="button"
              accessibilityLabel={`${section.name}, voľných ${section.available}`}
              style={[
                styles.sector,
                {
                  left: section.x * planWidth,
                  top: section.y * planHeight,
                  width: section.width * planWidth,
                  height: section.height * planHeight,
                  borderColor: soldOut ? colors.border : section.colour,
                  backgroundColor: soldOut ? 'rgba(255,255,255,0.04)' : `${section.colour}33`,
                },
              ]}
            >
              <Text style={styles.sectorName} numberOfLines={1}>{section.name}</Text>
              <Text style={[styles.sectorFree, soldOut && styles.sectorGone]}>
                {soldOut ? 'vypredané' : `${section.available} voľných`}
              </Text>
            </Pressable>
          );
        })}

        {/* The seats of the open sector, as dots on the plan itself. Laid out
            from the row index and the seat number against the widest row, so a
            short row centres instead of stretching to fill the sector. */}
        {open?.numbered ? open.seats.map((seat) => {
          const across = Math.max(open.row_width, 1);
          const down = Math.max(open.rows, 1);
          const cellW = (open.width * planWidth) / across;
          const cellH = (open.height * planHeight) / down;
          const size = Math.max(9, Math.min(22, Math.min(cellW, cellH) - 3));
          // A row shorter than the widest is centred rather than left-aligned:
          // that is how a stand narrowing towards the front actually looks, and
          // a ragged left edge reads as a mistake.
          const inRow = seatsPerRow.get(seat.row_index) ?? across;
          const indent = ((across - inRow) / 2) * cellW;

          return (
            <Pressable
              key={seat.id}
              disabled={busy || (!seat.free && !seat.mine)}
              onPress={() => tapSeat(seat)}
              accessibilityRole="button"
              accessibilityLabel={seatLabel(seat)}
              hitSlop={6}
              style={[
                styles.dot,
                {
                  width: size,
                  height: size,
                  borderRadius: size / 2,
                  left: open.x * planWidth + indent + (seat.number - 0.5) * cellW - size / 2,
                  top: open.y * planHeight + (seat.row_index + 0.5) * cellH - size / 2,
                },
                seat.mine_claim === 'held' ? styles.dotMine
                  : seat.mine ? styles.dotBought
                    : seat.taken ? styles.dotTaken
                      : !seat.sellable ? styles.dotBlocked
                        : seat.kind !== 'standard' ? styles.dotSpecial
                          : styles.dotFree,
              ]}
            />
          );
        }) : null}
      </View>

      <SectionHeader title="Sektory" />
      {sections.map((section) => (
        <View key={section.id} style={styles.sectionCard}>
          <Pressable style={styles.row} onPress={() => pick(section)} disabled={busy}>
            <View style={[styles.swatch, { backgroundColor: section.colour }]} />
            <View style={styles.flex}>
              <Text style={styles.rowName}>{section.name}</Text>
              <Caption>
                {section.available === 0
                  ? 'vypredané'
                  : `${section.available} voľných${section.numbered ? ' · číslované' : ''}`}
              </Caption>
            </View>
            {section.price_cents !== null ? (
              <Text style={styles.price}>{formatMoney(section.price_cents, 'EUR')}</Text>
            ) : null}
          </Pressable>

          {section.numbered && section.available > 0 ? (
            <View style={styles.together}>
              <Caption style={styles.flex}>Koľkí idete?</Caption>
              <Stepper value={party} onChange={setParty} min={1} max={10} disabled={busy} />
              <Button
                title="Nájdi nám miesta vedľa seba"
                variant="secondary"
                compact
                onPress={() => findTogether(section)}
                disabled={busy}
              />
            </View>
          ) : null}
        </View>
      ))}

      {open ? (
        <>
          <SectionHeader title={`${open.name} · miesta`} />
          <Caption style={styles.legend}>
            Klepni na guličku na pláne. Držíme ti miesto 15 minút; klepnutím na svoje ho pustíš.
          </Caption>

          <View style={styles.legendRow}>
            <LegendDot style={styles.dotFree} label="voľné" />
            <LegendDot style={styles.dotMine} label="držíš" />
            <LegendDot style={styles.dotBought} label="máš kúpené" />
            <LegendDot style={styles.dotTaken} label="obsadené" />
            <LegendDot style={styles.dotSpecial} label="vozík / sprievod / výhľad" />
            <LegendDot style={styles.dotBlocked} label="nepredáva sa" />
          </View>

          {/* Places that are not ordinary chairs, named rather than left as a
              differently coloured dot somebody has to guess at. */}
          {open.seats.some((seat) => seat.kind !== 'standard' && seat.free) ? (
            <View style={styles.specialBox}>
              {open.seats.filter((seat) => seat.kind !== 'standard' && seat.free).map((seat) => (
                <Caption key={seat.id}>
                  {`rad ${seat.row}, miesto ${seat.number} — `}
                  {SEAT_KIND_LABEL[seat.kind] ?? seat.kind}
                  {seat.note ? ` (${seat.note})` : ''}
                </Caption>
              ))}
            </View>
          ) : null}

          <Button title="Zavrieť sektor" variant="ghost" onPress={() => setOpenId(null)} />
        </>
      ) : null}

      {heldEverywhere.length > 0 ? (
        <Button title="Pustiť všetky držané miesta" variant="ghost" onPress={releaseAll} disabled={busy} />
      ) : null}

      <Button title="Do košíka" onPress={() => router.push('/cart')} />
    </Screen>
  );
}

/** "Rad B, miesto 3, držíš" — everything a screen reader needs from one dot. */
function seatLabel(seat: Seat): string {
  const kind = seat.kind !== 'standard' ? `, ${SEAT_KIND_LABEL[seat.kind as SeatKind]}` : '';
  const state = seat.mine_claim === 'held' ? ', držíš'
    : seat.mine ? ', máš kúpené'
      : seat.taken ? ', obsadené'
        : !seat.sellable ? ', nepredáva sa'
          : ', voľné';
  return `Rad ${seat.row}, miesto ${seat.number}${kind}${state}`;
}

function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/** How many of you there are. Small enough to live here rather than in ui.tsx. */
function Stepper({
  value, onChange, min, max, disabled,
}: {
  value: number; onChange: (next: number) => void; min: number; max: number; disabled?: boolean;
}) {
  return (
    <View style={styles.stepper}>
      <Pressable
        onPress={() => onChange(Math.max(min, value - 1))}
        disabled={disabled || value <= min}
        accessibilityRole="button"
        accessibilityLabel="O jedného menej"
        style={[styles.stepperButton, (disabled || value <= min) && styles.stepperOff]}
      >
        <Text style={styles.stepperGlyph}>−</Text>
      </Pressable>
      <Text style={styles.stepperValue}>{value}</Text>
      <Pressable
        onPress={() => onChange(Math.min(max, value + 1))}
        disabled={disabled || value >= max}
        accessibilityRole="button"
        accessibilityLabel="O jedného viac"
        style={[styles.stepperButton, (disabled || value >= max) && styles.stepperOff]}
      >
        <Text style={styles.stepperGlyph}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text },
  intro: { marginTop: spacing.xs, marginBottom: spacing.lg },
  flex: { flex: 1, minWidth: 0 },

  holdBar: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    padding: spacing.md, borderRadius: radius.md,
    backgroundColor: colors.accentSoft, marginBottom: spacing.md,
  },
  holdTitle: { ...typography.bodyStrong, color: colors.text },
  clock: { ...typography.title, color: colors.text, fontVariant: ['tabular-nums'] },
  clockLow: { color: colors.danger },

  plan: {
    alignSelf: 'center',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    marginBottom: spacing.lg,
  },
  planEmpty: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', padding: spacing.lg,
  },

  sector: {
    position: 'absolute',
    borderWidth: 2,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 2,
  },
  sectorName: { color: colors.text, fontWeight: '700', fontSize: 12 },
  sectorFree: { color: colors.text, fontSize: 10, opacity: 0.85 },
  sectorGone: { textDecorationLine: 'line-through' },

  sectionCard: { marginBottom: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  together: {
    flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  swatch: { width: 14, height: 14, borderRadius: 4 },
  rowName: { ...typography.bodyStrong, color: colors.text },
  price: { ...typography.bodyStrong, color: colors.accent },

  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepperButton: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceElevated,
  },
  stepperOff: { opacity: 0.4 },
  stepperGlyph: { ...typography.bodyStrong, color: colors.text },
  stepperValue: { ...typography.bodyStrong, color: colors.text, minWidth: 18, textAlign: 'center' },

  legend: { marginBottom: spacing.sm },
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginBottom: spacing.md },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  legendSwatch: { width: 14, height: 14, borderRadius: 7 },

  specialBox: {
    padding: spacing.md, borderRadius: radius.md,
    backgroundColor: colors.surface, marginBottom: spacing.md, gap: 2,
  },

  dot: { position: 'absolute', borderWidth: 1.5 },
  dotFree: { backgroundColor: 'rgba(255,255,255,0.10)', borderColor: colors.textSecondary },
  dotMine: { backgroundColor: colors.accent, borderColor: '#FFFFFF' },
  dotBought: { backgroundColor: colors.success, borderColor: '#FFFFFF' },
  dotSpecial: { backgroundColor: 'rgba(255,255,255,0.10)', borderColor: colors.warning },
  dotTaken: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, opacity: 0.6 },
  dotBlocked: { backgroundColor: 'transparent', borderColor: colors.border, opacity: 0.4 },
});

/** One entry in the legend: the same dot style, at a readable size. */
function LegendDot({ style, label }: { style: object; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendSwatch, style]} />
      <Caption>{label}</Caption>
    </View>
  );
}
