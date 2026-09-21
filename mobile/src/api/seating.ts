import { supabase } from '@/lib/supabase';

/**
 * One seat in a numbered sector.
 *
 * Three states rather than a boolean, because a seat you are holding must not
 * look like one you cannot have — on a plan drawn as dots, that difference is
 * the entire feedback for the click.
 */
export interface Seat {
  id: string;
  row: string;
  number: number;
  /** Which row it is in, counted from 0 — the dots are laid out from this. */
  row_index: number;
  /**
   * Which point of the sector's grid it stands on: twice its distance from the
   * middle of its row, in spacings. Always a whole number, and neighbours
   * differ by two.
   *
   * Stored rather than worked out from the seat's number and how many the row
   * holds, because that stops being true the moment somebody adds a seat to a
   * row by hand — every other seat in it would move. Null on plans made
   * before seats remembered this; then it is worked out the old way.
   */
  slot: number | null;
  sellable: boolean;
  /** Yours by any route — in your basket, on your order, or already paid for. */
  mine: boolean;
  /**
   * Which of those three, when it is yours.
   *
   * The picker needs the difference: tapping a seat you are holding gives it
   * back, and tapping one you have already paid for must do nothing at all.
   * They look identical on a plan, so the plan has to be told.
   */
  mine_claim: 'held' | 'ordered' | 'sold' | null;
  /** When your hold on it runs out, so the screen can count it down. */
  hold_until: string | null;
  /** What kind of place it is — a wheelchair space is not a chair. */
  kind: SeatKind;
  /** Why it is that kind, in the organizer's words: "za stĺpom". */
  note: string | null;
  /** Sold, or held by somebody else. */
  taken: boolean;
  free: boolean;
}

export type SeatKind = 'standard' | 'wheelchair' | 'companion' | 'limited_view';

/** What each kind is called on screen. The database holds the four values. */
export const SEAT_KIND_LABEL: Record<SeatKind, string> = {
  standard: 'Bežné miesto',
  wheelchair: 'Miesto pre vozík',
  companion: 'Miesto pre sprievod',
  limited_view: 'Obmedzený výhľad',
};

/**
 * What a sector is, which decides both how it reads and whether it sells.
 *
 * The last four are drawn so a buyer can find themselves on the plan — a hall
 * plan without the stage on it is a grid of rectangles nobody can orient
 * themselves in — and nothing about them is for sale.
 */
export type SectionKind =
  | 'standard' | 'vip' | 'box' | 'standing' | 'wheelchair'
  | 'stage' | 'bar' | 'entrance' | 'other';

export const SECTION_KIND_LABEL: Record<SectionKind, string> = {
  standard: 'Sedenie',
  vip: 'VIP',
  box: 'Lóža',
  standing: 'Státie',
  wheelchair: 'Miesta pre vozík',
  stage: 'Pódium',
  bar: 'Bar',
  entrance: 'Vstup',
  other: 'Iné',
};

/** True for the kinds that exist to orient people rather than to be bought. */
export const LANDMARK_KINDS: SectionKind[] = ['stage', 'bar', 'entrance', 'other'];

export interface Section {
  id: string;
  name: string;
  colour: string;
  kind: SectionKind;
  /** The organizer's own line about it: "Vlastný vstup, obsluha pri stole". */
  note: string | null;
  /** Drawn for orientation, never sold. The database decides this, not the app. */
  landmark: boolean;
  /** Fractions of the plan image, 0..1 — so the shape survives any resize. */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Degrees. A stand is rarely square to the room, and one drawn at an angle
   * but rendered square is a plan of a different hall.
   */
  rotation: number;
  /**
   * The outline, when the sector is not a rectangle — a corner stand that
   * curves, a terrace behind a goal, a balcony. Null for the ordinary case.
   * x/y/width/height stay the bounding box of these points.
   */
  shape: { x: number; y: number }[] | null;
  /**
   * The distance between two seats along a row, in fractions of the plan.
   *
   * A property of the sector, not of its first row: worked out from the first
   * row instead, adding one seat to that row would shift every seat in the
   * sector. Null on plans made before this was stored.
   */
  seat_pitch: number | null;
  ticket_type_id: string | null;
  price_cents: number | null;
  numbered: boolean;
  available: number;
  seat_count: number;
  /** How many rows, and the widest of them — the dot grid is sized from these. */
  rows: number;
  row_width: number;
}

export interface SeatMap {
  map: { id: string; name: string; image_url: string | null; image_width: number; image_height: number };
  sections: Section[];
}

export interface SeatHold {
  seat_id: string;
  section: string;
  row: string;
  number: number;
  kind: SeatKind;
  expires_at: string;
}

export interface SeatHoldBatch {
  expires_at: string;
  seats: Omit<SeatHold, 'expires_at'>[];
}

export interface SuggestedSeat {
  seat_id: string;
  row_label: string;
  seat_number: number;
}

/**
 * The plan: its shape, its sectors and their counts — but not their seats.
 *
 * Eight thousand seat objects is several megabytes, built on every open of the
 * screen, to draw one sector. The seats of the sector somebody actually opened
 * come from getSectionSeats(), which is also how the screen already worked.
 *
 * Null for an event that sells without a plan, which is most of them.
 */
export async function getSeatMap(eventId: string): Promise<SeatMap | null> {
  const { data, error } = await supabase.rpc('seat_map_for_event', { p_event_id: eventId });
  if (error) throw error;
  return (data as SeatMap) ?? null;
}

/** The seats of one sector, with the three states a dot can be in. */
export async function getSectionSeats(eventId: string, sectionId: string): Promise<Seat[]> {
  const { data, error } = await supabase.rpc('section_seats', {
    p_event_id: eventId,
    p_section_id: sectionId,
  });
  if (error) throw error;
  return (data ?? []) as Seat[];
}

/**
 * Takes a seat off the market for the basket window.
 *
 * The same hold ticket types use, so a seat counts against the 20-per-order
 * ceiling, expires with the rest of the basket, and is released by the same
 * sweep. Throws SEAT_HELD, SEAT_TAKEN or SEAT_NOT_SELLABLE — all of which
 * mean "pick another one" and are worded for that in lib/errors.
 */
export async function holdSeat(seatId: string): Promise<SeatHold> {
  const { data, error } = await supabase.rpc('cart_hold_seat', { p_seat_id: seatId });
  if (error) throw error;
  return data as SeatHold;
}

export async function releaseSeat(seatId: string): Promise<void> {
  const { error } = await supabase.rpc('cart_release_seat', { p_seat_id: seatId });
  if (error) throw error;
}

/**
 * Holds several seats at once, or none of them.
 *
 * Four separate holds are four chances to lose the fourth and end up sitting
 * apart, and four error messages for a person who asked one question. The
 * database does the whole set in one transaction.
 */
export async function holdSeats(seatIds: string[]): Promise<SeatHoldBatch> {
  const { data, error } = await supabase.rpc('cart_hold_seats', { p_seat_ids: seatIds });
  if (error) throw error;
  return data as SeatHoldBatch;
}

/**
 * The best block of `count` seats next to each other in one sector.
 *
 * Empty when the sector cannot seat the group together — which the screen says
 * plainly, rather than offering a worse answer as if it were the one asked for.
 */
export async function suggestSeats(sectionId: string, count: number): Promise<SuggestedSeat[]> {
  const { data, error } = await supabase.rpc('suggest_seats', {
    p_section_id: sectionId,
    p_count: count,
  });
  if (error) throw error;
  return (data ?? []) as SuggestedSeat[];
}

export interface ManifestRow {
  section: string;
  row_label: string;
  seat_number: number;
  kind: SeatKind;
  seat_note: string | null;
  ticket_id: string | null;
  code: string | null;
  status: string | null;
  holder_name: string | null;
  checked_in_at: string | null;
}

/** Who sits where, in the order the room is walked. Organizers only. */
export async function getSeatManifest(eventId: string): Promise<ManifestRow[]> {
  const { data, error } = await supabase.rpc('event_seat_manifest', { p_event_id: eventId });
  if (error) throw error;
  return (data ?? []) as ManifestRow[];
}

export interface SeatHoldLine {
  seat_id: string;
  section_id: string;
  section: string;
  row: string;
  number: number;
  kind: SeatKind;
  expires_at: string;
}

/**
 * Everything this person is holding on this event, for the clock.
 *
 * Asked for directly rather than found by scanning the plan: the plan no longer
 * carries the seats, and a stadium should not have to be downloaded to discover
 * that you are holding two of them.
 */
export async function getMySeatHolds(eventId: string): Promise<SeatHoldLine[]> {
  const { data, error } = await supabase.rpc('my_seat_holds', { p_event_id: eventId });
  if (error) throw error;
  return (data ?? []) as SeatHoldLine[];
}
