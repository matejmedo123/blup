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

export interface Section {
  id: string;
  name: string;
  colour: string;
  /** Fractions of the plan image, 0..1 — so the shape survives any resize. */
  x: number;
  y: number;
  width: number;
  height: number;
  ticket_type_id: string | null;
  price_cents: number | null;
  numbered: boolean;
  available: number;
  /** How many rows, and the widest of them — the dot grid is sized from these. */
  rows: number;
  row_width: number;
  seats: Seat[];
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

/** Null for an event that sells without a plan, which is most of them. */
export async function getSeatMap(eventId: string): Promise<SeatMap | null> {
  const { data, error } = await supabase.rpc('seat_map_for_event', { p_event_id: eventId });
  if (error) throw error;
  return (data as SeatMap) ?? null;
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
