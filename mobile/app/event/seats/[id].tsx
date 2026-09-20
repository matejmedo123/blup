import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getMySeatHolds, getSeatMap, getSectionSeats, holdSeat, holdSeats, releaseSeat, suggestSeats,
  SEAT_KIND_LABEL, SECTION_KIND_LABEL, type Seat, type SeatKind, type SeatMap, type Section,
} from '@/api/seating';
import { addToCart } from '@/api/cart';
import { messageFor } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import {
  Badge, Body, Button, Caption, EmptyState, ErrorState, Input, LoadingState, Notice, Screen,
} from '@/components/ui';
import { BottomSheet } from '@/components/BottomSheet';
import { SectorShape, rowExtent, sectorLabelStyle, sectorRadius, shapeMetrics } from '@/components/SectorShape';
import { ZoomPan, type ZoomPanHandle, type ZoomPanView } from '@/components/ZoomPan';
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
  /**
   * Which seat the pointer is over.
   *
   * A dot on a plan says "there is a seat here" and nothing else — not which
   * row, not what it costs, not whether it is the one by the aisle with the
   * pillar in front of it. All of that is already in the data; it just had
   * nowhere to be shown. On a mouse it follows the pointer, on a finger it
   * appears on touch-down, before the tap does anything.
   */
  const [peek, setPeek] = useState<{ seat: Seat; section: Section } | null>(null);

  /**
   * The sector picked from the list, and whether that list is open.
   *
   * A stadium has sixty-one of them and scrolling to "D205" past sixty cards
   * is not finding it. So the list is a dropdown you open, filter by name —
   * the name printed on the ticket — and pick from; picking takes the plan to
   * that sector, and the card under the plan is that sector alone.
   */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState('');
  const [chosenId, setChosenId] = useState<string | null>(null);
  /** Ticks once a second so the hold clock counts down rather than sitting still. */
  const [now, setNow] = useState(() => Date.now());

  const seatMap = useQuery({
    queryKey: ['event', id, 'seatmap'],
    queryFn: () => getSeatMap(id!),
    enabled: Boolean(id),
  });

  /**
   * The transform of the plan, and the frame it sits in.
   *
   * Everything below — which stands show their seats, which ones are worth
   * fetching, how big a name is drawn — comes from this. It is the one number
   * that says how much room a seat has on screen, and that is the whole rule.
   */
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const onViewChange = useCallback((next: ZoomPanView, size: { width: number; height: number }) => {
    setView(next);
    setFrame(size);
  }, []);

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

  // Everything from here to the end of this block is derived state, and it all
  // has to be above the early returns below: a hook that runs only once the
  // plan has loaded does not run in the same order on the render before it,
  // and React refuses that. So it reads the plan defensively instead.
  const map = seatMap.data?.map ?? null;
  const sections = useMemo(() => seatMap.data?.sections ?? [], [seatMap.data]);

  // The plan is drawn at whatever width there is; the sectors are fractions of
  // it, so one scale factor positions all of them.
  const planWidth = Math.min(width - spacing.gutter * 2, 720);
  const planHeight = planWidth * ((map?.image_height ?? 3) / (map?.image_width ?? 4));
  const scale = view.scale;

  /**
   * How much room one seat has on screen, in a given sector, right now.
   *
   * This is the only rule in the screen. Not how many seats there are, not
   * what kind of hall it is: how many pixels one chair gets. A stand fifty
   * across fits on a laptop at fourteen pixels a seat and does not fit on a
   * phone at seven, and the same stand should behave differently on the two.
   */
  const pitchOf = useCallback((section: Section) => {
    if (!section.numbered) return 0;
    const acrossPx = (section.width * planWidth * scale) / Math.max(section.row_width, 1);
    const downPx = (section.height * planHeight * scale) / Math.max(section.rows, 1);
    return Math.min(acrossPx, downPx);
  }, [planWidth, planHeight, scale]);

  /**
   * Is any part of this sector on screen?
   *
   * The plan is centred in its frame, then moved and scaled about that centre.
   * A sector that is off the edge has no business costing a fetch or a few
   * hundred views — and on a stadium at full zoom, all but two or three are.
   */
  const onScreen = useCallback((section: Section) => {
    if (frame.width === 0) return false;
    const left = frame.width / 2 + view.x + (section.x * planWidth - planWidth / 2) * scale;
    const top = frame.height / 2 + view.y + (section.y * planHeight - planHeight / 2) * scale;
    const w = section.width * planWidth * scale;
    const h = section.height * planHeight * scale;
    // A screen's worth of margin, so dragging does not arrive at a blank stand.
    const pad = 200;
    return left + w > -pad && left < frame.width + pad
        && top + h > -pad && top < frame.height + pad;
  }, [frame, view, planWidth, planHeight, scale]);

  /** 13 points is about the smallest dot a finger can aim at. */
  const showsSeats = useCallback(
    (section: Section) => pitchOf(section) >= 13 && onScreen(section),
    [pitchOf, onScreen],
  );

  /**
   * Which sectors are worth asking the server about.
   *
   * Only what is on screen and big enough to be drawn, and never more than a
   * handful at once: a stadium has sixty-seven stands and nobody is looking at
   * sixty-seven of them.
   */
  const wanted = useMemo(
    () => sections.filter((section) => showsSeats(section)).slice(0, 8).map((section) => section.id),
    [sections, showsSeats],
  );

  const seatQueries = useQueries({
    queries: wanted.map((sectionId) => ({
      queryKey: ['event', id, 'seatmap', sectionId],
      queryFn: () => getSectionSeats(id!, sectionId),
      enabled: Boolean(id),
      // Seats change under you — somebody else buys one. Kept briefly so
      // dragging back and forth across a stand does not refetch it each time.
      staleTime: 15_000,
    })),
  });

  const seatsBySection = useMemo(() => {
    const out = new Map<string, Seat[]>();
    wanted.forEach((sectionId, index) => {
      const rows = seatQueries[index]?.data;
      if (rows) out.set(sectionId, rows);
    });
    return out;
  }, [wanted, seatQueries]);

  /** How many seats each row actually holds, for centring the short ones. */
  const rowWidths = useMemo(() => {
    const out = new Map<string, Map<number, number>>();
    for (const [sectionId, rows] of seatsBySection) {
      const counts = new Map<number, number>();
      for (const seat of rows) counts.set(seat.row_index, (counts.get(seat.row_index) ?? 0) + 1);
      out.set(sectionId, counts);
    }
    return out;
  }, [seatsBySection]);
  const seatsPerRow = useCallback(
    (sectionId: string) => rowWidths.get(sectionId) ?? new Map<number, number>(),
    [rowWidths],
  );

  /**
   * Which place in its row each seat is, and how many the row holds.
   *
   * A shaped sector's rows are laid across the sector's width at that row, so
   * what matters is a seat's position among the seats that actually exist in
   * its row — not its number, which keeps the column of the grid the shape was
   * cut from and may start at four.
   */
  const seatOrders = useMemo(() => {
    const out = new Map<string, Map<string, { index: number; of: number }>>();
    for (const [sectionId, rows] of seatsBySection) {
      const byRow = new Map<number, Seat[]>();
      for (const seat of rows) {
        const list = byRow.get(seat.row_index);
        if (list) list.push(seat);
        else byRow.set(seat.row_index, [seat]);
      }
      const places = new Map<string, { index: number; of: number }>();
      for (const list of byRow.values()) {
        list.sort((a, b) => a.number - b.number);
        list.forEach((seat, index) => places.set(seat.id, { index, of: list.length }));
      }
      out.set(sectionId, places);
    }
    return out;
  }, [seatsBySection]);
  const seatOrder = useCallback(
    (sectionId: string) => seatOrders.get(sectionId) ?? new Map<string, { index: number; of: number }>(),
    [seatOrders],
  );

  /**
   * What the pointer is over, worked out once for the whole plan.
   *
   * Not Pressable's own onHoverIn: inside the zoomed plan the browser does not
   * deliver pointerenter to the seats at all — dispatching one by hand shows
   * the card appearing, so the handler is fine and the event never arrives.
   * Rather than fight that, the plan asks the document what is under the
   * cursor and reads the seat's id off it. One listener instead of several
   * hundred, and it does not care how the library models hover.
   */
  const planHost = React.useRef<View>(null);
  const seatIndex = useMemo(() => {
    const out = new Map<string, { seat: Seat; section: Section }>();
    for (const [sectionId, rows] of seatsBySection) {
      const section = sections.find((one) => one.id === sectionId);
      if (!section) continue;
      for (const seat of rows) out.set(seat.id, { seat, section });
    }
    return out;
  }, [seatsBySection, sections]);

  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const node = planHost.current as unknown as HTMLElement | null;
    if (!node) return undefined;

    const onMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const dot = under?.closest?.('[id^="seat-"]') as HTMLElement | null;
      const id = dot?.id?.slice(5);
      const hit = id ? seatIndex.get(id) ?? null : null;
      setPeek((current) => (current?.seat.id === hit?.seat.id ? current : hit));
    };
    const onLeave = () => setPeek(null);

    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerleave', onLeave);
    return () => {
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerleave', onLeave);
    };
  }, [seatIndex]);

  /**
   * Where one seat sits inside its sector, in the plan's own coordinates.
   *
   * For a plain rectangle this is the grid it always was, with short rows
   * centred. For a sector drawn as a shape it is the grid clipped to the
   * outline: the row is laid across the sector's width AT THAT ROW, so a stand
   * that narrows towards the pitch has rows that narrow with it. Laid across
   * the bounding box instead, the rows run straight through the sloping edge
   * and the chairs end up outside the stand they belong to.
   */
  const seatSpot = useCallback((section: Section, seat: Seat) => {
    const across = Math.max(section.row_width, 1);
    const down = Math.max(section.rows, 1);
    const width = section.width * planWidth;
    const height = section.height * planHeight;
    const cellH = height / down;
    const top = (seat.row_index + 0.5) * cellH;

    if (!section.shape) {
      const cellW = width / across;
      const inRow = seatsPerRow(section.id).get(seat.row_index) ?? across;
      const indent = ((across - inRow) / 2) * cellW;
      return {
        left: indent + (seat.number - 0.5) * cellW,
        top,
        size: Math.min(cellW * 0.82, cellH * 0.78),
      };
    }

    // In plan fractions, because that is what the outline is stored in.
    const y = section.y + (seat.row_index + 0.5) / down * section.height;
    const span = rowExtent(section.shape, y);
    if (!span) return null;

    const order = seatOrder(section.id).get(seat.id);
    if (!order) return null;
    const rowWidth = (span.x1 - span.x0) * planWidth;
    const cellW = rowWidth / Math.max(order.of, 1);
    return {
      left: (span.x0 - section.x) * planWidth + (order.index + 0.5) * cellW,
      top,
      size: Math.min(cellW * 0.82, cellH * 0.78),
    };
  }, [planWidth, planHeight, seatsPerRow, seatOrder]);

  /**
   * The sector named in the card above the plan.
   *
   * Whichever one fills most of the screen, so the card follows the drag
   * instead of having to be dismissed. Null when you are far enough out that
   * no single stand is what you are looking at.
   */
  const focused = useMemo(() => {
    if (frame.width === 0) return null;
    let best: Section | null = null;
    let bestDistance = Infinity;
    for (const section of sections) {
      if (section.landmark || pitchOf(section) < 13 || !onScreen(section)) continue;
      // Nearest to the middle of the frame — not the biggest. The biggest is
      // whichever has the largest bounding box, which on a stadium is a corner
      // wedge you are not even looking at.
      const cx = frame.width / 2 + view.x
        + ((section.x + section.width / 2) * planWidth - planWidth / 2) * scale;
      const cy = frame.height / 2 + view.y
        + ((section.y + section.height / 2) * planHeight - planHeight / 2) * scale;
      const distance = Math.hypot(cx - frame.width / 2, cy - frame.height / 2);
      if (distance < bestDistance) { best = section; bestDistance = distance; }
    }
    return best;
  }, [sections, onScreen, pitchOf, frame, view, planWidth, planHeight, scale]);

  /**
   * The sectors the dropdown shows.
   *
   * Filtered by what you typed, landmarks left out — you cannot buy the pitch
   * — and sold-out ones kept, because "is B204 gone?" is a question the list
   * should answer rather than dodge.
   */
  const pickerList = useMemo(() => {
    const needle = pickerFilter.trim().toLowerCase();
    return sections.filter((section) => (
      !section.landmark && (needle === '' || section.name.toLowerCase().includes(needle))
    ));
  }, [sections, pickerFilter]);

  /**
   * The sector the card under the plan is about.
   *
   * What you picked from the list, for as long as you are still looking at it;
   * otherwise whatever is in the middle of the frame. Dragging away from your
   * choice should change the card, not leave it lying about a stand that is no
   * longer on screen.
   */
  const shown = useMemo(() => {
    const picked = chosenId ? sections.find((section) => section.id === chosenId) ?? null : null;
    // What you picked while you are still there; once you have dragged away,
    // whatever is now in the middle of the frame. The pick is also what shows
    // in the moment between choosing it and the plan arriving, when nothing is
    // focused yet — otherwise the dropdown would blink back to its placeholder
    // exactly as you used it.
    if (picked && onScreen(picked)) return picked;
    return focused ?? picked;
  }, [chosenId, sections, onScreen, focused]);


  /**
   * Go to a sector: put it in the middle, zoomed until a seat is a fingertip.
   *
   * Not "open" it — everything else stays drawn where it is, one drag away.
   */
  const zoomToSection = useCallback((section: Section) => {
    /*
     * Enough that the stand fills most of the frame — and then, only if its
     * seats would still be too small to aim at, a little more.
     *
     * Aiming straight for a fixed number of pixels per seat overshoots badly:
     * a stand fourteen seats across in a stadium of sixty-seven is a sliver of
     * the plan, and 20 points a seat means zooming until nothing but half of
     * it is on screen.
     */
    const acrossPx = (section.width * planWidth) / Math.max(section.row_width, 1);
    const downPx = (section.height * planHeight) / Math.max(section.rows, 1);
    const natural = section.numbered ? Math.min(acrossPx, downPx) : 0;

    // Just far enough that a seat is comfortably tappable — NOT far enough to
    // fill the frame with the stand. A stand in a stadium is a thirtieth of
    // the plan wide; filling the frame with it means scale 22, and then the
    // screen is one sector and you are back to where this started. At a
    // readable seat you get the stand and three or four of its neighbours,
    // which is what a plan is for.
    const target = natural > 0
      ? Math.min(18, Math.max(1, 16 / natural))
      : Math.min(6, Math.max(1, 0.7 / Math.max(section.width, section.height)));
    planRef.current?.focus(
      { x: (section.x + section.width / 2) * planWidth, y: (section.y + section.height / 2) * planHeight },
      target,
    );
  }, [planWidth, planHeight]);


  if (seatMap.isLoading) return <Screen><LoadingState label="Načítavam plán…" /></Screen>;
  if (seatMap.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(seatMap.error)} onRetry={() => void seatMap.refetch()} />
      </Screen>
    );
  }

  if (!seatMap.data || !map) {
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
    // Numbered: go to it on the plan rather than opening it somewhere else.
    if (section.numbered) { zoomToSection(section); return; }

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

  const tapSeat = async (seat: Seat, section: Section) => {
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
        applyLocally([seat.id], section.id, false, null);
      } else {
        const held = await holdSeat(seat.id);
        applyLocally([seat.id], section.id, true, held.expires_at);
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
      zoomToSection(section);
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
        Klepni na sektor alebo si plán priblíž. Miesta sa objavia, keď na ne bude
        miesto — a plán zostane plánom, takže sa po ňom posúvaš aj k susedným.
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

      {/* ONE plan, however big the hall is.
          It used to be two screens: the whole plan with no seats on it, and —
          once you tapped a sector — that sector alone, blown up to the full
          width with everything else gone. It answered "which seat" and lost
          "where in the hall", which on a stadium is the question. You could
          not see the stand next door, and you could not drag to it.
          Now the plan is the plan. Zoom in and the seats appear in the stands
          that are big enough on screen to hold them; drag and the neighbours
          are there, with their seats, exactly where they are in the hall.
          Nothing here is about football: it is the same rule for a theatre,
          a cinema or a club, because it is a rule about how much room a seat
          has on screen, not about what the hall is for. */}
      {/* Pick a sector by its name — the one on the ticket.
          A list of sixty-one cards is not a way to find D205; a list you open,
          type into and pick from is. Picking takes the plan to that sector and
          the card below the plan becomes that sector alone. */}
      <Pressable style={styles.picker} onPress={() => setPickerOpen(true)}>
        <View style={styles.flex}>
          <Caption>Sektor</Caption>
          <Text style={styles.pickerValue}>
            {shown ? shown.name : 'Vyber si sektor alebo klepni do plánu'}
          </Text>
        </View>
        <Text style={styles.pickerChevron}>⌄</Text>
      </Pressable>

      <View ref={planHost} style={styles.planHost}>
      <ZoomPan
        ref={planRef}
        contentWidth={planWidth}
        contentHeight={planHeight}
        minScale={1}
        maxScale={18}
        onViewChange={onViewChange}
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
          const seats = seatsBySection.get(section.id) ?? [];
          const showing = showsSeats(section);
          const left = section.x * planWidth;
          const top = section.y * planHeight;
          const width = section.width * planWidth;
          const height = section.height * planHeight;

          const m = section.shape
            ? shapeMetrics(section.shape, section)
            : { cx: section.x + section.width / 2, cy: section.y + section.height / 2,
                roomW: section.width, roomH: section.height };

          return (
            <Pressable
              key={section.id}
              /*
               * While its seats are drawn, the sector is not the thing you aim
               * at — the seats are. `disabled` looked like the way to say that
               * and is not: on web it takes pointer events away from the whole
               * subtree, so the seats inside stopped receiving hover and the
               * card that says what a seat is never appeared. `box-none` is
               * the right word: not a target itself, children still are.
               */
              pointerEvents={showing ? 'box-none' : 'auto'}
              disabled={section.landmark}
              onPress={() => { if (!showing) zoomToSection(section); }}
              accessibilityRole="button"
              accessibilityLabel={
                section.landmark
                  ? `${section.name} — ${SECTION_KIND_LABEL[section.kind] ?? 'orientačný bod'}`
                  : `${section.name}, voľných ${section.available}`
              }
              style={[
                styles.sector,
                {
                  left,
                  top,
                  width,
                  height,
                  borderColor: section.shape ? 'transparent'
                    : soldOut ? colors.border : section.colour,
                  backgroundColor: section.shape ? 'transparent'
                    : soldOut ? 'rgba(255,255,255,0.04)' : `${section.colour}33`,
                  transform: [{ rotate: section.shape ? '0deg' : `${section.rotation ?? 0}deg` }],
                  borderRadius: sectorRadius(width, height),
                  borderWidth: section.shape ? 0 : Math.min(2, 2 / Math.max(scale, 0.2)),
                },
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
                  strokeWidth={Math.min(2, 2 / Math.max(scale, 0.2))}
                />
              ) : null}

              {/* The name sits at the sector's centroid and is sized from its
                  area. Centred in the bounding box, a corner wedge's label
                  lands out on the pitch, and sixty of them pile up. It fades
                  out once the seats are drawn — by then the name is in the
                  card above and the label is just something over the chairs. */}
              {showing ? null : (
                <View
                  pointerEvents="none"
                  style={[styles.sectorLabel, {
                    left: (m.cx - section.x) * planWidth,
                    top: (m.cy - section.y) * planHeight,
                  }]}
                >
                  <Text
                    style={[styles.sectorName, sectorLabelStyle(m.roomW * planWidth * scale, m.roomH * planHeight * scale)]}
                    numberOfLines={1}
                  >
                    {section.name}
                  </Text>
                </View>
              )}

              {/* The seats, drawn in the plan's own coordinates so the zoom
                  carries them. No sizing maths per dot: a seat is a fraction
                  of its sector, the sector is a fraction of the plan, and the
                  plan is what is being scaled. */}
              {showing ? seats.map((seat) => {
                const at = seatSpot(section, seat);
                if (!at) return null;
                return (
                  <Pressable
                    key={seat.id}
                    // The id is how the plan's own pointer handler works out
                    // which seat is under the cursor. See peekAt below.
                    nativeID={`seat-${seat.id}`}
                    disabled={busy || (!seat.free && !seat.mine)}
                    onPress={() => tapSeat(seat, section)}
                    onPressIn={() => setPeek({ seat, section })}
                    accessibilityRole="button"
                    accessibilityLabel={seatLabel(seat)}
                    style={[
                      styles.dot,
                      {
                        width: at.size,
                        height: at.size,
                        borderRadius: at.size / 2,
                        left: at.left - at.size / 2,
                        top: at.top - at.size / 2,
                        // Drawn thin enough that the zoom brings it back to
                        // about a pixel, and never thicker than a third of
                        // the dot.
                        borderWidth: Math.min(at.size / 3, 1.4 / Math.max(scale, 0.2)),
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
            </Pressable>
          );
        })}

        {/* What that dot actually is.
            Anchored to the seat in plan coordinates so it travels with the
            plan, and counter-scaled so the text stays the size text should be
            however far in you are. */}
        {peek ? (() => {
          const section = peek.section;
          const at = seatSpot(section, peek.seat);
          const state = peek.seat.mine_claim === 'held' ? 'držíš v košíku'
            : peek.seat.mine ? 'máš kúpené'
              : peek.seat.taken ? 'obsadené'
                : !peek.seat.sellable ? 'nepredáva sa'
                  : 'voľné';
          return (
            <View
              pointerEvents="none"
              testID="seat-peek"
              style={[
                styles.peek,
                {
                  left: section.x * planWidth + (at?.left ?? 0),
                  top: section.y * planHeight + (at?.top ?? 0),
                  transform: [{ scale: 1 / Math.max(scale, 0.2) }],
                },
              ]}
            >
              <Text style={styles.peekSeat}>
                {`${section.name} · rad ${peek.seat.row} · miesto ${peek.seat.number}`}
              </Text>
              <Text style={styles.peekState}>
                {section.price_cents !== null
                  ? `${formatMoney(section.price_cents, 'EUR')} · ${state}`
                  : state}
              </Text>
              {peek.seat.kind !== 'standard' ? (
                <Text style={styles.peekNote}>{SEAT_KIND_LABEL[peek.seat.kind]}</Text>
              ) : null}
              {peek.seat.note ? <Text style={styles.peekNote}>{peek.seat.note}</Text> : null}
            </View>
          );
        })() : null}
      </ZoomPan>
      </View>

      {/* No "back to the whole plan" button any more: you never left it.
          Zooming out is the way back, and it is the same gesture that got you
          in. */}

      {/* One sector under the plan: the one you picked, or the one you have
          dragged to the middle. Sixty-one cards under a plan is a wall, and
          sixty of them are about stands nobody is looking at. */}
      {shown ? (
        <View style={styles.zoomHead}>
          <View style={styles.flex}>
            <View style={styles.rowTitle}>
              <Text style={styles.rowName}>{shown.name}</Text>
              {shown.kind !== 'standard' ? (
                <Badge label={(SECTION_KIND_LABEL[shown.kind] ?? shown.kind).toUpperCase()}
                       tone={shown.kind === 'vip' || shown.kind === 'box' ? 'accent' : 'neutral'} />
              ) : null}
            </View>
            <Caption>
              {shown.available > 0
                ? `${shown.available} voľných${shown.numbered ? ` z ${shown.seat_count}` : ''}`
                : 'vypredané'}
            </Caption>
            {shown.note ? <Caption>{shown.note}</Caption> : null}
          </View>
          {shown.price_cents !== null ? (
            <View style={styles.priceCell}>
              <Text style={styles.price}>{formatMoney(shown.price_cents, 'EUR')}</Text>
              <Caption>{shown.numbered ? 'za miesto' : 'za vstupenku'}</Caption>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* "Find us seats next to each other", once, for that sector. */}
      {shown && shown.numbered && shown.available > 0 ? (
        <View style={styles.together}>
          <Caption style={styles.togetherLabel}>{`Koľkí idete do ${shown.name}?`}</Caption>
          <View style={styles.togetherControls}>
            <Stepper
              value={partyFor(shown.id)}
              onChange={(next) => setPartyFor(shown.id, next)}
              min={1}
              max={10}
              disabled={busy}
            />
            <Button
              title="Nájdi nám miesta vedľa seba"
              variant="secondary"
              style={styles.togetherButton}
              compact
              onPress={() => findTogether(shown)}
              disabled={busy}
            />
          </View>
        </View>
      ) : null}

      {/* A sector sold by the count rather than by seat: it has no dots to
          tap, so it needs a button. */}
      {shown && !shown.numbered && shown.available > 0 && shown.ticket_type_id ? (
        <Button
          title={`Pridať ${shown.name} do košíka`}
          variant="secondary"
          onPress={() => pick(shown)}
          disabled={busy}
        />
      ) : null}

      {/* The sector list, in the dropdown rather than down the page. */}
      <BottomSheet
        visible={pickerOpen}
        onClose={() => { setPickerOpen(false); setPickerFilter(''); }}
        title="Vyber sektor"
        subtitle="Píš názov tak, ako ho máš na vstupenke — A106, B204, V03."
      >
        <Input
          placeholder="Hľadaj sektor"
          value={pickerFilter}
          onChangeText={setPickerFilter}
          autoCapitalize="characters"
          autoCorrect={false}
        />
        {pickerList.length === 0 ? (
          <Caption>Žiadny sektor sa tomu nepodobá.</Caption>
        ) : null}
        {pickerList.map((section) => (
          <Pressable
            key={section.id}
            testID={`sector-option-${section.name}`}
            style={styles.row}
            disabled={busy}
            onPress={() => {
              setChosenId(section.id);
              setPickerOpen(false);
              setPickerFilter('');
              zoomToSection(section);
            }}
          >
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
            </View>
            {section.price_cents !== null ? (
              <View style={styles.priceCell}>
                <Text style={styles.price}>{formatMoney(section.price_cents, 'EUR')}</Text>
              </View>
            ) : null}
          </Pressable>
        ))}
      </BottomSheet>

      {/* The stage, the bar, the entrance used to be listed here by name. On a
          stadium that is a line reading "Hracia plocha, Skybox, Brána A, Brána
          B, Brána C, Brána D" under the sectors, which tells a buyer nothing
          they cannot see on the plan itself — where those things are drawn,
          labelled, and in the right place. */}

      {/* The key to the dots. Always here, not only while a sector is
          "open" — there is no open sector any more, just a plan you are
          further into or less far into. */}
      <View style={styles.zoomBar}>
        <Button title="−" variant="secondary" compact onPress={() => planRef.current?.zoomBy(1 / 1.6)} />
        <Button title="+" variant="secondary" compact onPress={() => planRef.current?.zoomBy(1.6)} />
      </View>

      <Caption style={styles.legend}>
        {focused
          ? 'Klepni na miesto. Držíme ti ho 15 minút.'
          : 'Klepni na sektor alebo si plán priblíž — miesta sa objavia, keď na ne bude miesto.'}
      </Caption>

      {focused ? (
        <View style={styles.legendRow}>
          <LegendDot style={styles.dotFree} label="voľné" />
          <LegendDot style={styles.dotMine} label="držíš" />
          <LegendDot style={styles.dotBought} label="máš kúpené" />
          <LegendDot style={styles.dotTaken} label="obsadené" />
        </View>
      ) : null}

      {/* Places that are not ordinary chairs, named rather than left as a
          differently coloured dot somebody has to guess at. Only for the
          sector you are actually looking at. */}
      {focused && (seatsBySection.get(focused.id) ?? []).some((seat) => seat.kind !== 'standard' && seat.free) ? (
        <View style={styles.specialBox}>
          {(seatsBySection.get(focused.id) ?? [])
            .filter((seat) => seat.kind !== 'standard' && seat.free)
            .map((seat) => (
              <Caption key={seat.id}>
                {`rad ${seat.row}, miesto ${seat.number} — `}
                {SEAT_KIND_LABEL[seat.kind]}
                {seat.note ? ` (${seat.note})` : ''}
              </Caption>
            ))}
        </View>
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

  planHost: { alignSelf: 'center' },
  plan: {
    alignSelf: 'center',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    marginBottom: spacing.lg,
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

  /* The sector dropdown. Reads as a field because it behaves like one: it has
     a label, a value and something to press. */
  picker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceInput,
    marginBottom: spacing.sm,
  },
  pickerValue: { ...typography.bodyStrong, color: colors.text },
  pickerChevron: { ...typography.body, color: colors.textSecondary, fontSize: 18 },

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

  /* No borderWidth here: it is set per dot from the zoom. Everything inside
     the plan is drawn in the plan's own units and then scaled, so a 1.5pt
     outline becomes a 12pt ring at eight times in — the seats turn into
     touching doughnuts. */
  dot: { position: 'absolute' },
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
