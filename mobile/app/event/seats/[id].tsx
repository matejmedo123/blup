import React, { useEffect, useState } from 'react';
import {
  Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getMySeatHolds, getSeatMap, getSectionSeats, holdSeat, holdSeats, releaseSeat, suggestSeats,
  SEAT_KIND_LABEL, SECTION_KIND_LABEL, type Seat, type SeatKind, type SeatMap, type Section,
} from '@/api/seating';
import { addToCart } from '@/api/cart';
import { messageFor } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import {
  Badge, Body, Button, Caption, EmptyState, ErrorState, LoadingState, Notice, Screen,
  SectionHeader,
} from '@/components/ui';
import { SectorShape, sectorLabelStyle, sectorRadius, shapeMetrics } from '@/components/SectorShape';
import { ZoomPan, type ZoomPanHandle } from '@/components/ZoomPan';
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
  /**
   * How many seats together, PER SECTOR.
   *
   * It used to be one number shared by every sector on the screen, and the
   * screenshot said it better than I can: two sectors, each with its own
   * stepper, both reading 2, both moving when either one was pressed — while
   * only the sector you acted on went into the basket. One counter drawn in
   * several places is a promise that they are separate.
   */
  const [parties, setParties] = useState<Record<string, number>>({});
  const partyFor = (sectionId: string) => parties[sectionId] ?? 2;
  const setPartyFor = (sectionId: string, value: number) =>
    setParties((current) => ({ ...current, [sectionId]: value }));
  /** Which row of a big sector is being looked at. Null = the whole sector. */
  const planRef = React.useRef<ZoomPanHandle>(null);
  /**
   * How far in the plan currently is, reported by the surface itself.
   *
   * Up here with the rest of the state on purpose: the screen returns early
   * while the map loads, and a hook below that return changes the hook count
   * between renders — React then tears the tree down with #310.
   */
  const [planScale, setPlanScale] = useState(1);
  /**
   * Which seat the pointer is over.
   *
   * A dot on a plan says "there is a seat here" and nothing else — not which
   * row, not what it costs, not whether it is the one by the aisle with the
   * pillar in front of it. All of that is already in the data; it just had
   * nowhere to be shown. On a mouse it follows the pointer, on a finger it
   * appears on touch-down, before the tap does anything.
   */
  const [peek, setPeek] = useState<Seat | null>(null);
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
   * differently on the two.
   */
  /**
   * How big a seat has to be drawn, and therefore how far in the plan starts.
   *
   * A stand with four hundred seats cannot be both legible and fully visible on
   * a phone, and the old answer was to stop drawing a plan at all: pick a row
   * from a list of chips, then a seat from a strip of numbers. It worked and it
   * told you nothing about where you would be sitting.
   *
   * So the plan stays a plan. When the seats would come out too small to hit,
   * it opens already zoomed to the point where they are — and you move around
   * it. 24 points is roughly a fingertip.
   */
  const dotPitch = open ? planWidth / Math.max(open.row_width, 1) : 0;
  const rowPitch = open ? zoomHeight / Math.max(open.rows, 1) : 0;
  const naturalPitch = open ? Math.min(dotPitch, rowPitch) : 0;
  /**
   * The seats appear once they are actually big enough to aim at.
   *
   * Drawing four hundred sub-pixel dots is not a plan of anything — it is grey
   * noise, and on a stadium it is eight thousand views the phone has to lay
   * out. Zoomed out you get the shape of the stand and where the rows run;
   * zoom in and the seats are there.
   */
  const seatSize = naturalPitch * planScale;
  const seatsVisible = seatSize >= 14;

  const rowsInOpen: string[] = [];
  for (const seat of seats) if (!rowsInOpen.includes(seat.row)) rowsInOpen.push(seat.row);

  /**
   * Puts what the server just told us straight into the cache.
   *
   * Every tap used to end with two awaited invalidations, which meant two
   * further round trips — the WHOLE plan and the whole open sector, refetched
   * because one dot changed — with the screen spinning until both came back.
   * On a sector with two thousand seats that is the "strašne dlho" in the
   * report.
   *
   * The hold call already returned the authoritative answer, so the cache can
   * be corrected from it without asking again. Anything somebody else changed
   * meanwhile arrives from the background refresh below.
   */
  const applyLocally = (seatIds: string[], sectionId: string | null, held: boolean, until: string | null) => {
    const ids = new Set(seatIds);

    if (sectionId) {
      queryClient.setQueryData<Seat[]>(['event', id, 'seatmap', sectionId], (current) => (
        current?.map((seat) => (ids.has(seat.id)
          ? { ...seat, mine: held, mine_claim: held ? 'held' : null, hold_until: held ? until : null }
          : seat))
      ));
    }

    // The plan shows how many are left in each sector, so it moves too.
    queryClient.setQueryData<SeatMap | null>(['event', id, 'seatmap'], (current) => {
      if (!current || !sectionId) return current;
      return {
        ...current,
        sections: current.sections.map((section) => (section.id === sectionId
          ? {
            ...section,
            available: Math.max(0, section.available + (held ? -ids.size : ids.size)),
          }
          : section)),
      };
    });
  };

  /**
   * Catches up with everybody else, without holding the screen.
   *
   * Deliberately not awaited: the cache already has the right answer for what
   * THIS person just did, and the only thing left to learn is what other people
   * did — which is not worth a spinner.
   */
  const refreshInBackground = () => {
    void queryClient.invalidateQueries({ queryKey: ['event', id, 'seatmap'] });
    void queryClient.invalidateQueries({ queryKey: ['event', id, 'holds'] });
    // The basket badge. Never invalidated here before, so adding a seat left
    // the counter in the corner showing the old number.
    void queryClient.invalidateQueries({ queryKey: ['cart'] });
  };

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['event', id, 'seatmap'] }),
      queryClient.invalidateQueries({ queryKey: ['event', id, 'holds'] }),
      queryClient.invalidateQueries({ queryKey: ['cart'] }),
    ]);
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
    if (section.numbered) { setOpenId(section.id); return; }

    if (!section.ticket_type_id) { setError('Tento sektor zatiaľ nie je v predaji.'); return; }
    setBusy(true);
    try {
      await addToCart(section.ticket_type_id, 1);
      setNote(`${section.name} pridaný do košíka.`);
      // One fewer left in that sector — known without asking again.
      queryClient.setQueryData<SeatMap | null>(['event', id, 'seatmap'], (current) => (
        current
          ? {
            ...current,
            sections: current.sections.map((item) => (item.id === section.id
              ? { ...item, available: Math.max(0, item.available - 1) }
              : item)),
          }
          : current
      ));
      refreshInBackground();
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
        applyLocally([seat.id], openId, false, null);
      } else {
        const held = await holdSeat(seat.id);
        applyLocally([seat.id], openId, true, held.expires_at);
        setNote(`Držíme ti ${held.section}, rad ${held.row}, miesto ${held.number}.`);
      }
      refreshInBackground();
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
      const wanted = partyFor(section.id);
      const found = await suggestSeats(section.id, wanted);
      if (found.length === 0) {
        setError(
          `V sektore ${section.name} už nie je ${wanted} voľných miest vedľa seba. `
          + 'Skús menej miest alebo iný sektor.',
        );
        return;
      }

      const batch = await holdSeats(found.map((s) => s.seat_id));
      applyLocally(found.map((s) => s.seat_id), section.id, true, batch.expires_at);
      setNote(
        `Držíme ti rad ${found[0].row_label}, miesta `
        + `${found.map((s) => s.seat_number).join(', ')}.`,
      );
      setOpenId(section.id);
      refreshInBackground();
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
      // In parallel: giving four seats back is one action, not four waits.
      await Promise.all(heldEverywhere.map((hold) => releaseSeat(hold.seat_id)));
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

      {open && open.numbered ? (
        <ZoomPan
          ref={planRef}
          contentWidth={planWidth}
          contentHeight={zoomHeight}
          minScale={1}
          maxScale={8}
          onScaleChange={setPlanScale}
          style={[styles.plan, { width: planWidth, height: zoomHeight }]}
        >
          {/* A sector drawn as a shape keeps it when you zoom into it. Filling
              the whole rectangle instead would tell the buyer the stand runs
              into the corners, and the seats deliberately do not. */}
          {open.shape ? (
            <SectorShape
              shape={open.shape}
              bounds={{ x: open.x, y: open.y, width: open.width, height: open.height }}
              planWidth={planWidth / Math.max(open.width, 0.0001)}
              planHeight={zoomHeight / Math.max(open.height, 0.0001)}
              colour={open.colour}
            />
          ) : (
            <View style={[styles.zoomFill, { backgroundColor: `${open.colour}1F`, borderColor: open.colour }]} />
          )}

          {/* Zoomed out: the rows as bands, so the stand has a shape and it is
              obvious which way it runs. No dots — at this size they would be
              grey noise, and on a stadium eight thousand of them. */}
          {!seatsVisible ? rowsInOpen.map((label, index) => (
            <View
              key={label}
              style={[
                styles.rowBand,
                {
                  top: (index + 0.12) * (zoomHeight / Math.max(open.rows, 1)),
                  height: Math.max(2, (zoomHeight / Math.max(open.rows, 1)) * 0.76),
                  backgroundColor: `${open.colour}55`,
                },
              ]}
            />
          )) : null}

          {seatsVisible ? seats.map((seat) => {
            const across = Math.max(open.row_width, 1);
            const down = Math.max(open.rows, 1);
            const cellW = planWidth / across;
            const cellH = zoomHeight / down;
            const size = Math.max(12, Math.min(30, Math.min(cellW, cellH) - 4));
            /*
             * Where the seat sits across the row.
             *
             * In a plain rectangle a short row is centred — a back row of nine
             * in a stand fourteen wide belongs in the middle, not squashed
             * left. In a sector that was drawn as a shape the seat number IS
             * the column of the grid the shape was cut out of, so centring it
             * would slide the row off the part of the stand it belongs to.
             */
            const inRow = seatsPerRow.get(seat.row_index) ?? across;
            const indent = open.shape ? 0 : ((across - inRow) / 2) * cellW;

            return (
              <Pressable
                key={seat.id}
                disabled={busy || (!seat.free && !seat.mine)}
                onPress={() => tapSeat(seat)}
                // A seat you cannot buy is still a seat you may want to read,
                // so the card is wired outside the disabled press.
                onHoverIn={() => setPeek(seat)}
                onHoverOut={() => setPeek((current) => (current?.id === seat.id ? null : current))}
                onPressIn={() => setPeek(seat)}
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
          }) : null}

          {/* What that dot actually is.
              Anchored to the seat inside the zoom, so it follows the plan when
              you pan — but counter-scaled, so the text stays the size text
              should be however far in you are. */}
          {peek && seatsVisible ? (() => {
            const across = Math.max(open.row_width, 1);
            const down = Math.max(open.rows, 1);
            const cellW = planWidth / across;
            const cellH = zoomHeight / down;
            const inRow = seatsPerRow.get(peek.row_index) ?? across;
            const indent = open.shape ? 0 : ((across - inRow) / 2) * cellW;
            const state = peek.mine_claim === 'held' ? 'držíš v košíku'
              : peek.mine ? 'máš kúpené'
                : peek.taken ? 'obsadené'
                  : !peek.sellable ? 'nepredáva sa'
                    : 'voľné';
            return (
              <View
                pointerEvents="none"
                style={[
                  styles.peek,
                  {
                    left: indent + (peek.number - 0.5) * cellW,
                    top: (peek.row_index + 0.5) * cellH,
                    transform: [{ scale: 1 / Math.max(planScale, 0.2) }],
                  },
                ]}
              >
                <Text style={styles.peekSeat}>{`${open.name} · rad ${peek.row} · miesto ${peek.number}`}</Text>
                <Text style={styles.peekState}>
                  {open.price_cents !== null ? `${formatMoney(open.price_cents, 'EUR')} · ${state}` : state}
                </Text>
                {peek.kind !== 'standard' ? (
                  <Text style={styles.peekNote}>{SEAT_KIND_LABEL[peek.kind]}</Text>
                ) : null}
                {peek.note ? <Text style={styles.peekNote}>{peek.note}</Text> : null}
              </View>
            );
          })() : null}

          {openSeats.isLoading ? (
            <View style={styles.planEmpty}><Caption>Načítavam miesta…</Caption></View>
          ) : null}

          {/* Which way the stage is, so "rad A" means something. */}
          <Text style={styles.zoomFront}>▲ k pódiu</Text>
        </ZoomPan>
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
        ) : null}

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
                  // A shaped sector paints its own outline below, so the box
                  // itself stays invisible — otherwise a curved stand would sit
                  // inside a rectangle nobody drew.
                  borderColor: section.shape ? 'transparent'
                    : soldOut ? colors.border : section.colour,
                  backgroundColor: section.shape ? 'transparent'
                    : soldOut ? 'rgba(255,255,255,0.04)' : `${section.colour}33`,
                  // The angle the sector was drawn at. A stand that leans in the
                  // hall and sits square on the plan is a plan of somewhere
                  // else.
                  transform: [{ rotate: section.shape ? '0deg' : `${section.rotation ?? 0}deg` }],
                  borderRadius: sectorRadius(section.width * planWidth, section.height * planHeight),
                },
                // A stage is not a thing to pick. Drawn flat and dashed so it
                // reads as part of the room rather than as something on sale.
                section.landmark && styles.sectorLandmark,
              ]}
            >
              {section.shape ? (
                <SectorShape
                  shape={section.shape}
                  bounds={section}
                  planWidth={planWidth}
                  planHeight={planHeight}
                  colour={section.colour}
                  dimmed={soldOut}
                />
              ) : null}
              {(() => {
                /*
                 * The name goes where the sector actually is.
                 *
                 * Centred in the box, a corner stand's label lands out on the
                 * pitch, and on a bowl of sixty wedges they pile on top of one
                 * another. The centroid is inside the shape by construction,
                 * and the size comes from the shape's area — a thin curved
                 * stand has a big box and almost no room to write in.
                 */
                const m = section.shape
                  ? shapeMetrics(section.shape, section)
                  : { cx: section.x + section.width / 2, cy: section.y + section.height / 2,
                      roomW: section.width, roomH: section.height };
                const roomW = m.roomW * planWidth;
                const roomH = m.roomH * planHeight;
                return (
                  <View
                    pointerEvents="none"
                    style={[styles.sectorLabel, {
                      left: (m.cx - section.x) * planWidth,
                      top: (m.cy - section.y) * planHeight,
                    }]}
                  >
                    {/* Only the name. The count used to sit under it, and on a
                        bowl of sixty stands it was sixty small numbers nobody
                        reads, overlapping each other. What is left of it is
                        where it belongs: the key above the plan says how many
                        are free at each price, the colour says sold out, and
                        opening a sector says the number for that sector
                        exactly. */}
                    <Text style={[styles.sectorName, sectorLabelStyle(roomW, roomH)]} numberOfLines={1}>
                      {section.name}
                    </Text>
                  </View>
                );
              })()}
            </Pressable>
          );
        })}

      </View>
      )}

      {open ? (
        <Button
          title="Späť na celý plán"
          variant="ghost"
          onPress={() => { setOpenId(null); }}
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
            {/* "44,00 €" beside a stepper showing 2 reads as a line total. It
                is the price of one seat, so it says so. */}
            {section.price_cents !== null ? (
              <View style={styles.priceCell}>
                <Text style={styles.price}>{formatMoney(section.price_cents, 'EUR')}</Text>
                <Caption>za miesto</Caption>
              </View>
            ) : null}
          </Pressable>

          {section.numbered && section.available > 0 ? (
            <View style={styles.together}>
              {/* On its own line. As a flex child beside the stepper and a
                  long button it shrank until it wrapped one letter per line —
                  which is exactly what the phone screenshot showed. */}
              <Caption style={styles.togetherLabel}>Koľkí idete?</Caption>
              <View style={styles.togetherControls}>
                <Stepper
                  value={partyFor(section.id)}
                  onChange={(next) => setPartyFor(section.id, next)}
                  min={1}
                  max={10}
                  disabled={busy}
                />
                <Button
                  title="Nájdi nám miesta vedľa seba"
                  variant="secondary"
                  style={styles.togetherButton}
                  compact
                  onPress={() => findTogether(section)}
                  disabled={busy}
                />
              </View>
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

          {/* Two buttons, because a mouse has no second finger and a phone
              should not have to guess that pinching is allowed. */}
          <View style={styles.zoomBar}>
            <Button title="−" variant="secondary" compact onPress={() => planRef.current?.zoomBy(1 / 1.6)} />
            <Button title="+" variant="secondary" compact onPress={() => planRef.current?.zoomBy(1.6)} />
            <Button
              title="Celý sektor"
              variant="ghost"
              compact
              onPress={() => planRef.current?.reset()}
            />
          </View>

          <Caption style={styles.legend}>
            {seatsVisible
              ? 'Klepni na miesto. Držíme ti ho 15 minút; klepnutím na svoje ho pustíš. Ťahaním sa po pláne posúvaš.'
              : `${open.seat_count} miest — priblíž si plán a miesta sa objavia. Ťahaním sa po ňom posúvaš.`}
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
  /* Anchored at the sector's centroid: translated by half its own size so the
     text is centred on that point rather than starting at it. */
  sectorLabel: { position: 'absolute', alignItems: 'center', transform: [{ translateX: -60 }, { translateY: -8 }], width: 120 },
  sectorName: { color: colors.text, fontWeight: '700', fontSize: 12, textAlign: 'center' },
  sectorLandmark: { borderStyle: 'dashed', backgroundColor: 'rgba(255,255,255,0.03)' },

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
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  togetherLabel: { marginBottom: 2 },
  togetherControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  // minWidth 0 so the label inside can shrink and wrap by word rather than
  // pushing the row wider than the card.
  togetherButton: { flex: 1, minWidth: 0 },
  swatch: { width: 14, height: 14, borderRadius: 4 },
  rowTitle: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  rowName: { ...typography.bodyStrong, color: colors.text },
  landmarks: { marginTop: spacing.xs, marginBottom: spacing.md },
  rowBand: { position: 'absolute', left: '6%', right: '6%', borderRadius: 2 },
  zoomBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.xs },
  priceCell: { alignItems: 'flex-end' },
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

  /* The card that says what a dot is. Lifted clear of the seat and pinned by
     its bottom-left so it never sits under the pointer, and never under the
     finger that just touched the seat. */
  peek: {
    position: 'absolute',
    marginLeft: 14,
    marginTop: -14,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceElevated,
    minWidth: 170,
    zIndex: 40,
  },
  peekSeat: { ...typography.bodyStrong, color: colors.text },
  peekState: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  peekNote: { ...typography.caption, color: colors.accent, marginTop: 2 },

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
