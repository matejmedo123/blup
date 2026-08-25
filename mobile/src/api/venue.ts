import { supabase } from '@/lib/supabase';
import type { Section } from './seating';

export interface VenueMap {
  id: string;
  organization_id: string;
  name: string;
  image_url: string | null;
  image_width: number;
  image_height: number;
}

export async function getVenueMaps(organizationId: string): Promise<VenueMap[]> {
  const { data, error } = await supabase
    .from('venue_maps')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as VenueMap[];
}

export async function createVenueMap(input: {
  organizationId: string;
  name: string;
  imageUrl?: string | null;
  width?: number;
  height?: number;
}): Promise<VenueMap> {
  const { data: userData } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from('venue_maps')
    .insert({
      organization_id: input.organizationId,
      name: input.name.trim(),
      image_url: input.imageUrl ?? null,
      image_width: input.width ?? 1000,
      image_height: input.height ?? 1000,
      created_by: userData?.user?.id ?? null,
    })
    .select()
    .single();

  if (error) throw error;
  return data as VenueMap;
}

export async function updateVenueMap(
  id: string,
  patch: Partial<Pick<VenueMap, 'name' | 'image_url' | 'image_width' | 'image_height'>>,
): Promise<void> {
  const { error } = await supabase.from('venue_maps').update(patch).eq('id', id);
  if (error) throw error;
}

/** Sections as stored — the buyer's view goes through seat_map_for_event. */
export async function getVenueSections(venueMapId: string): Promise<Section[]> {
  const { data, error } = await supabase
    .from('venue_sections')
    .select('*, venue_seats(count)')
    .eq('venue_map_id', venueMapId)
    .order('sort_order');

  if (error) throw error;

  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    name: row.name as string,
    colour: row.colour as string,
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    ticket_type_id: (row.ticket_type_id as string) ?? null,
    price_cents: null,
    numbered: ((row.venue_seats as { count: number }[])?.[0]?.count ?? 0) > 0,
    available: 0,
    rows: 0,
    row_width: 0,
    seats: [],
  }));
}

export async function createSection(input: {
  venueMapId: string;
  ticketTypeId: string | null;
  name: string;
  colour: string;
  x: number;
  y: number;
  width: number;
  height: number;
  sortOrder?: number;
}): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('venue_sections')
    .insert({
      venue_map_id: input.venueMapId,
      ticket_type_id: input.ticketTypeId,
      name: input.name.trim(),
      colour: input.colour,
      // Clamped and rounded to the five decimals the column holds, so a shape
      // dragged a pixel past the edge is trimmed rather than refused by a check.
      x: round5(clamp(input.x)),
      y: round5(clamp(input.y)),
      width: round5(Math.min(clamp(input.width), 1 - clamp(input.x))),
      height: round5(Math.min(clamp(input.height), 1 - clamp(input.y))),
      sort_order: input.sortOrder ?? 0,
    })
    .select('id')
    .single();

  if (error) throw error;
  return data as { id: string };
}

export async function deleteSection(id: string): Promise<void> {
  const { error } = await supabase.from('venue_sections').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Fills a section with rows of seats.
 *
 * Rows are lettered A, B, C… and seats numbered from 1. Anything already there
 * is replaced, because "regenerate" is what an organizer means when they change
 * the shape of a stand — and a half-old, half-new grid is worse than either.
 */
export async function generateSeats(input: {
  sectionId: string;
  rows: number;
  perRow: number;
}): Promise<number> {
  await supabase.from('venue_seats').delete().eq('venue_section_id', input.sectionId);

  const seats: { venue_section_id: string; row_label: string; seat_number: number }[] = [];
  for (let r = 0; r < input.rows; r++) {
    for (let n = 1; n <= input.perRow; n++) {
      seats.push({
        venue_section_id: input.sectionId,
        row_label: rowLabel(r),
        seat_number: n,
      });
    }
  }

  const { error } = await supabase.from('venue_seats').insert(seats);
  if (error) throw error;
  return seats.length;
}

/** A, B … Z, then AA, AB — a stand with 27 rows is unusual but not impossible. */
function rowLabel(index: number): string {
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const round5 = (v: number) => Math.round(v * 1e5) / 1e5;
