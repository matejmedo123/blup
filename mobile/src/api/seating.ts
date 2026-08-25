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
  /** Held by you right now. Clicking again gives it back. */
  mine: boolean;
  /** Sold, or held by somebody else. */
  taken: boolean;
  free: boolean;
}

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
  expires_at: string;
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
