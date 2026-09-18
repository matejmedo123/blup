import React, { useEffect, useState } from 'react';
import {
  Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getMySeatHolds, getSeatMap, getSectionSeats, holdSeat, holdSeats, releaseSeat, suggestSeats,
  SEAT_KIND_LABEL, SECTION_KIND_LABEL, type Seat, type SeatKind, type Section,
} from '@/api/seating';
import { addToCart } from '@/api/cart';
import { messageFor } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import {
  Badge, Body, Button, Caption, Chip, EmptyState, ErrorState, LoadingState, Notice, Screen,
  SectionHeader,
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
 *
 * The seats come per sector rather than with the plan. A stadium is eight
 * thousand of them and several megabytes; the screen only ever shows one sector
 * at a time, so that is what it asks for. The plan itself is a couple of
 * kilobytes of rectangles, counts, and the landmarks — the stage, the bar, the
 * entrance — which are drawn so somebody can find themselves on it and are not
 * for sale.
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
  /** Which row of a big sector is being looked at. Null = the whole sector. */
  const [openRow, setOpenRow] = useState<string | null>(null);
  /** Ticks once a second so the hold clock counts down rather than sitting still. */
  const [now, setNow] = useState(() => Date.now());

  const seatMap = useQuery({
    queryKey: ['event', id, 'seatmap'],
    queryFn: () => getSeatMap(id!),
    enabled: Boolean(id),
  });

  const openSeats = useQuery({
    queryKey: ['event', id, 'seatmap', openId],
    queryFn: () => getSectionSeats(id!, openId!),
    enabled: Boolean(id) && Boolean(openId),
  });

  // The basket clock. Asked for directly rather than found by scanning the
  // plan, which no longer carries the seats — and should not have to, to answer
  // "how long have I got".
  const holds = useQuery({
    queryKey: ['event', id, 'holds'],
    queryFn: () => getMySeatHolds(id!),
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

  // The basket is one basket and the clock on it is one clock, wherever on the
  // plan the seats are.
  const heldEverywhere = holds.data ?? [];

  const holdEndsAt = heldEverywhere
    .map((hold) => Date.parse(hold.expires_at))
    .filter((t) => Number.isFinite(t))
    .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);

  const secondsLeft = Number.isFinite(holdEndsAt)
    ? Math.max(0, Math.round((holdEndsAt - now) / 1000))
    : 0;

  const seats = openSeats.data ?? [];

  /**
   * The price legend above the plan.
   *
   * A plan is read by colour before it is read by name — "the green ones are
   * 990" — so the colours have to be explained once, at the top, or the buyer is
   * left guessing which rectangle costs what. Built from the sectors actually on
   * this plan rather than from the ticket types, because a type with no sector
   * drawn for it is not on the picture and putting it in the key would be a
   * colour that matches nothing.
   */
  const legend: { price: number; colour: string; available: number }[] = [];
  for (const section of sections) {
    if (section.landmark || section.price_cents === null) continue;
    const seen = legend.find((row) => row.price === section.price_cents);
    if (seen) seen.available += section.available;
    else legend.push({ price: section.price_cents, colour: section.colour, available: section.available });
  }
  legend.sort((a, b) => a.price - b.price);

  /** How many seats each row actually holds, for centring the short ones. */
  const seatsPerRow = new Map<number, number>();
  for (const seat of seats) {
    seatsPerRow.set(seat.row_index, (seatsPerRow.get(seat.row_index) ?? 0) + 1);
  }

  // The plan is drawn at whatever width there is; the sectors are fractions of
  // it, so one scale factor positions all of them.
  const planWidth = Math.min(width - spacing.gutter * 2, 720);
  const planHeight = planWidth * (map.image_height / map.image_width);

  // The opened sector, scaled to the full width. Its own proportions, so a long
  // shallow stand stays long and shallow — clamped so a very deep one does not
  // push everything else off the screen.
  const zoomHeight = open && open.width > 0
    ? Math.max(180, Math.min(planWidth * ((open.height * planHeight) / (open.width * planWidth)), 560))
    : planHeight;

  /**
   * Whether the opened sector can be drawn as dots at all.
   *
   * The limit is not how many seats there are — it is how wide the widest row
   * is against the screen. Fifty across fits on a laptop at fourteen pixels a
   * seat and does not fit on a phone at seven, and the same stand should behave
   * differently on the two. Below the hittable size the sector is taken a row at
   * a time instead, which is also how somebody thinks about a stand: "rad 12,
   * niekde v strede".
   */
  const dotPitch = open ? planWidth / Math.max(open.row_width, 1) : 0;
  const rowPitch = open ? zoomHeight / Math.max(open.rows, 1) : 0;
  const tooManyForDots = Boolean(open?.numbered) && Math.min(dotPitch, rowPitch) < 13;

  const rowsInOpen: string[] = [];
  for (const seat of seats) if (!rowsInOpen.includes(seat.row)) rowsInOpen.push(seat.row);

  const shownSeats = tooManyForDots
    ? seats.filter((seat) => seat.row === (openRow ?? rowsInOpen[0]))
    : seats;

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['event', id, 'seatmap'] });
    await queryClient.invalidateQueries({ queryKey: ['event', id, 'holds'] });
  };

  const pick = async (section: Section) => {
    setError(null);
    setNote(null);

    // A stage is not a product. Saying what it is beats a tap that does nothing.
    if (section.landmark) {
      setNote(section.note ?? `${section.name} — ${SECTION_KIND_LABEL[section.kind] ?? 'orientačný bod'}.`);
      return;
    }

    if (section.available === 0) {
      setError(`${section.name} je vypredaný.`);
      return;
    }
    if (section.numbered) { setOpenId(section.id); setOpenRow(null); return; }

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
      for (const hold of heldEverywhere) await releaseSeat(hold.seat_id);
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
        Klepni na sektor. Otvorí sa cez celý plán a až vtedy uvidíš jednotlivé miesta —
        naraz teda nikdy nie viac ako jeden sektor.
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
                .map((hold) => `${hold.section} · ${hold.row}${hold.number}`)
                .join(' · ')}
            </Caption>
          </View>
          <Text style={[styles.clock, secondsLeft <= 60 && styles.clockLow]}>
            {secondsLeft > 0 ? mmss(secondsLeft) : '—'}
          </Text>
        </View>
      ) : null}

      {/* The key, only on the whole plan — inside a sector the colour of the
          dots means something else entirely. */}
      {!open && legend.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.legendStrip}>
          {legend.map((row) => (
            <View key={row.price} style={styles.legendChip}>
              <View style={[styles.legendSwatchSquare, { backgroundColor: row.colour }]} />
              <Text style={styles.legendPrice}>{formatMoney(row.price, 'EUR')}</Text>
              <Caption>{row.available > 0 ? `${row.available} voľných` : 'vypredané'}</Caption>
            </View>
          ))}
        </ScrollView>
      ) : null}

      {/* One sector at a time.
          On the whole plan there are no dots at all — a stadium would be eight
          thousand of them, and even a theatre's four hundred are sub-pixel
          inside a rectangle that is a fifth of the screen. Opening a sector
          zooms to it: the same rectangle, scaled to the full width, with its
          seats laid out at a size a thumb can hit. Nothing else is drawn, so
          there is never more than one sector's worth of dots on screen. */}
      {/* Which sector you are inside, and what it costs. Without it the zoom is
          a field of dots with no name on it. */}
      {open && open.numbered ? (
        <View style={styles.zoomHead}>
          <View style={styles.flex}>
            <View style={styles.rowTitle}>
              <Text style={styles.rowName}>{open.name}</Text>
              {open.kind !== 'standard' ? (
                <Badge label={(SECTION_KIND_LABEL[open.kind] ?? open.kind).toUpperCase()}
                       tone={open.kind === 'vip' || open.kind === 'box' ? 'accent' : 'neutral'} />
              ) : null}
            </View>
            <Caption>
              {open.available > 0 ? `${open.available} voľných z ${open.seat_count}` : 'vypredané'}
            </Caption>
            {open.note ? <Caption>{open.note}</Caption> : null}
          </View>
          {open.price_cents !== null ? (
            <Text style={styles.price}>{formatMoney(open.price_cents, 'EUR')}</Text>
          ) : null}
        </View>
      ) : null}

      {open && open.numbered && !tooManyForDots ? (
        <View style={[styles.plan, { width: planWidth, height: zoomHeight }]}>
          <View style={[styles.zoomFill, { backgroundColor: `${open.colour}1F`, borderColor: open.colour }]} />

          {seats.map((seat) => {
            const across = Math.max(open.row_width, 1);
            const down = Math.max(open.rows, 1);
            const cellW = planWidth / across;
            const cellH = zoomHeight / down;
            const size = Math.max(12, Math.min(30, Math.min(cellW, cellH) - 4));
            const inRow = seatsPerRow.get(seat.row_index) ?? across;
            const indent = ((across - inRow) / 2) * cellW;

            return (
              <Pressable
                key={seat.id}
                disabled={busy || (!seat.free && !seat.mine)}
                onPress={() => tapSeat(seat)}
                accessibilityRole="button"
                accessibilityLabel={seatLabel(seat)}
                hitSlop={4}
                style={[
                  styles.dot,
                  {
                    width: size,
                    height: size,
                    borderRadius: size / 2,
                    left: indent + (seat.number - 0.5) * cellW - size / 2,
                    top: (seat.row_index + 0.5) * cellH - size / 2,
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
          })}

          {openSeats.isLoading ? (
            <View style={styles.planEmpty}><Caption>Načítavam miesta…</Caption></View>
          ) : null}

          {/* Which way the stage is, so "rad A" means something. */}
          <Text style={styles.zoomFront}>▲ k pódiu</Text>
        </View>
      ) : (
      <View
        nativeID="blup-plan-view"
        style={[styles.plan, { width: planWidth, height: planHeight }]}
      >
        {map.image_url ? (
          // Same reason as the editor: on web this is an <img>, and a browser
          // will happily start dragging the picture out of the page when
          // somebody presses on a sector.
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <Image
              source={{ uri: map.image_url }}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
            />
          </View>
        ) : (
          <View style={styles.planEmpty}>
            <Caption>Organizátor nenahral obrázok plánu — sektory sú nižšie.</Caption>
          </View>
        )}

        {sections.map((section) => {
          const soldOut = !section.landmark && section.available === 0;
          return (
            <Pressable
              key={section.id}
              onPress={() => pick(section)}
              accessibilityRole="button"
              accessibilityLabel={
                section.landmark
                  ? `${section.name} — ${SECTION_KIND_LABEL[section.kind] ?? 'orientačný bod'}`
                  : `${section.name}, voľných ${section.available}`
              }
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
                // A stage is not a thing to pick. Drawn flat and dashed so it
                // reads as part of the room rather than as something on sale.
                section.landmark && styles.sectorLandmark,
              ]}
            >
              <Text style={styles.sectorName} numberOfLines={1}>{section.name}</Text>
              {section.landmark ? null : (
                <Text style={[styles.sectorFree, soldOut && styles.sectorGone]}>
                  {soldOut ? 'vypredané' : `${section.available} voľných`}
                </Text>
              )}
            </Pressable>
          );
        })}

      </View>
      )}

      {open ? (
        <Button
          title="Späť na celý plán"
          variant="ghost"
          onPress={() => { setOpenId(null); setOpenRow(null); }}
        />
      ) : null}

      <SectionHeader title="Sektory" />
      {sections.filter((section) => !section.landmark).map((section) => (
        <View key={section.id} style={styles.sectionCard}>
          <Pressable style={styles.row} onPress={() => pick(section)} disabled={busy}>
            <View style={[styles.swatch, { backgroundColor: section.colour }]} />
            <View style={styles.flex}>
              <View style={styles.rowTitle}>
                <Text style={styles.rowName}>{section.name}</Text>
                {section.kind !== 'standard' ? (
                  <Badge label={(SECTION_KIND_LABEL[section.kind] ?? section.kind).toUpperCase()}
                         tone={section.kind === 'vip' || section.kind === 'box' ? 'accent' : 'neutral'} />
                ) : null}
              </View>
              <Caption>
                {section.available === 0
                  ? 'vypredané'
                  : `${section.available} voľných${section.numbered ? ' · číslované' : ''}`}
              </Caption>
              {section.note ? <Caption>{section.note}</Caption> : null}
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

      {/* The stage, the bar, the entrance: on the plan they are what lets
          somebody work out where row A actually is. In the list they would only
          look like sectors that cannot be bought, so they are named once here
          instead. */}
      {sections.some((section) => section.landmark) ? (
        <Caption style={styles.landmarks}>
          {'Na pláne ešte nájdeš: '}
          {sections.filter((s2) => s2.landmark).map((s2) => s2.name).join(', ')}.
        </Caption>
      ) : null}

      {open ? (
        <>
          <SectionHeader title={`${open.name} · miesta`} />
          <Caption style={styles.legend}>
            {tooManyForDots
              ? `${open.seat_count} miest je priveľa na to, aby sa zmestili na plán ako `
                + 'guličky — vyber si rad a v ňom miesto. Držíme ti ho 15 minút.'
              : 'Klepni na guličku na pláne. Držíme ti miesto 15 minút; klepnutím na svoje ho pustíš.'}
          </Caption>

          {/* A stand, a row at a time. The same three states as the dots, at a
              size somebody can actually hit with a thumb. */}
          {tooManyForDots ? (
            <>
              <View style={styles.rowStrip}>
                {rowsInOpen.map((label) => (
                  <Chip
                    key={label}
                    label={`Rad ${label}`}
                    selected={(openRow ?? rowsInOpen[0]) === label}
                    onPress={() => setOpenRow(label)}
                  />
                ))}
              </View>

              <View style={styles.seatLine}>
                {shownSeats.map((seat) => (
                  <Pressable
                    key={seat.id}
                    disabled={busy || (!seat.free && !seat.mine)}
                    onPress={() => tapSeat(seat)}
                    accessibilityRole="button"
                    accessibilityLabel={seatLabel(seat)}
                    style={[
                      styles.seatChip,
                      seat.mine_claim === 'held' ? styles.seatChipMine
                        : seat.mine ? styles.seatChipBought
                          : seat.taken ? styles.seatChipTaken
                            : !seat.sellable ? styles.seatChipBlocked
                              : seat.kind !== 'standard' ? styles.seatChipSpecial
                                : null,
                    ]}
                  >
                    <Text style={styles.seatChipLabel}>{seat.number}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}

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
          {seats.some((seat) => seat.kind !== 'standard' && seat.free) ? (
            <View style={styles.specialBox}>
              {seats.filter((seat) => seat.kind !== 'standard' && seat.free).map((seat) => (
                <Caption key={seat.id}>
                  {`rad ${seat.row}, miesto ${seat.number} — `}
                  {SEAT_KIND_LABEL[seat.kind] ?? seat.kind}
                  {seat.note ? ` (${seat.note})` : ''}
                </Caption>
              ))}
            </View>
          ) : null}

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
  sectorLandmark: { borderStyle: 'dashed', backgroundColor: 'rgba(255,255,255,0.03)' },
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
  rowTitle: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  rowName: { ...typography.bodyStrong, color: colors.text },
  landmarks: { marginTop: spacing.xs, marginBottom: spacing.md },
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

  legendStrip: { marginBottom: spacing.sm },
  legendChip: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.xs,
    paddingVertical: spacing.xs, paddingHorizontal: spacing.sm,
    borderRadius: radius.pill, backgroundColor: colors.surface, marginRight: spacing.sm,
  },
  legendSwatchSquare: { width: 12, height: 12, borderRadius: 3 },
  legendPrice: { ...typography.bodyStrong, color: colors.text },

  zoomHead: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    padding: spacing.md, borderRadius: radius.md,
    backgroundColor: colors.surface, marginBottom: spacing.sm,
  },

  zoomFill: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    borderWidth: 2, borderRadius: radius.lg,
  },
  zoomFront: {
    position: 'absolute', top: 6, alignSelf: 'center',
    ...typography.caption, color: colors.textSecondary,
  },

  rowStrip: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.md },
  seatLine: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: spacing.md },
  seatChip: {
    minWidth: 38, height: 38, borderRadius: radius.sm,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6,
    borderWidth: 1, borderColor: colors.textSecondary,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  seatChipMine: { backgroundColor: colors.accent, borderColor: '#FFFFFF' },
  seatChipBought: { backgroundColor: colors.success, borderColor: '#FFFFFF' },
  seatChipTaken: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, opacity: 0.55 },
  seatChipBlocked: { backgroundColor: 'transparent', borderColor: colors.border, opacity: 0.4 },
  seatChipSpecial: { borderColor: colors.warning },
  seatChipLabel: { ...typography.caption, color: colors.text },

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
