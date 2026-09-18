import { supabase } from '@/lib/supabase';
import { LANDMARK_KINDS, type Section, type SectionKind } from './seating';

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

/** One plan, with the proportions both the editor and the picker draw it at. */
export async function getVenueMap(id: string): Promise<VenueMap | null> {
  const { data, error } = await supabase
    .from('venue_maps')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return (data as VenueMap) ?? null;
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

  return (data ?? []).map((row: Record<string, unknown>) => {
    const kind = ((row.kind as SectionKind) ?? 'standard');
    const seats = (row.venue_seats as { count: number }[])?.[0]?.count ?? 0;

    return {
      id: row.id as string,
      name: row.name as string,
      colour: row.colour as string,
      kind,
      note: (row.note as string) ?? null,
      landmark: LANDMARK_KINDS.includes(kind),
      x: Number(row.x),
      y: Number(row.y),
      width: Number(row.width),
      height: Number(row.height),
      ticket_type_id: (row.ticket_type_id as string) ?? null,
      // The editor reads the sectors as stored; price and availability are the
      // buyer's view and come from seat_map_for_event().
      price_cents: null,
      numbered: seats > 0,
      available: 0,
      seat_count: seats,
      rows: 0,
      row_width: 0,
    };
  });
}

export async function createSection(input: {
  venueMapId: string;
  ticketTypeId: string | null;
  name: string;
  colour: string;
  kind?: SectionKind;
  note?: string;
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
      // A landmark is not a product, and the table refuses one that carries a
      // ticket type rather than trusting this screen to remember.
      ticket_type_id: LANDMARK_KINDS.includes(input.kind ?? 'standard') ? null : input.ticketTypeId,
      name: input.name.trim(),
      colour: input.colour,
      kind: input.kind ?? 'standard',
      note: input.note?.trim() || null,
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
 * This used to delete every seat in the sector from the client and insert a
 * fresh grid. RLS allowed it, and it was still wrong: tickets point at seats
 * with ON DELETE SET NULL, so regenerating a stand mid-sale quietly wiped the
 * row and number off tickets people had already paid for — no error, no trace,
 * and a buyer who turns up with a ticket for nowhere.
 *
 * The database does it now. It refuses to remove a seat somebody holds or has
 * bought, keeps the ids (and so the kinds) of the seats that survive, and says
 * what it changed.
 */
export async function generateSeats(input: {
  sectionId: string;
  rows: number;
  perRow: number;
  /** Where the lettering starts, for a stand whose first row is not A. */
  startRow?: number;
}): Promise<{ total: number; created: number; removed: number }> {
  const { data, error } = await supabase.rpc('generate_section_seats', {
    p_section_id: input.sectionId,
    p_rows: input.rows,
    p_per_row: input.perRow,
    p_start_row: input.startRow ?? 0,
  });

  if (error) throw error;
  return data as { total: number; created: number; removed: number };
}

/**
 * Renaming, recolouring or re-pricing a sector.
 *
 * Until now a sector drawn in the wrong place could only be deleted — taking
 * its seats with it, and the seat off every ticket sold from it. Undefined
 * means "leave this one alone", so the editor sends one field at a time.
 */
export async function updateSection(
  sectionId: string,
  patch: {
    name?: string;
    colour?: string;
    kind?: SectionKind;
    note?: string;
    ticketTypeId?: string | null;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    sortOrder?: number;
  },
): Promise<void> {
  const { error } = await supabase.rpc('update_section', {
    p_section_id: sectionId,
    p_name: patch.name ?? null,
    p_colour: patch.colour ?? null,
    p_ticket_type_id: patch.ticketTypeId ?? null,
    p_x: patch.x ?? null,
    p_y: patch.y ?? null,
    p_width: patch.width ?? null,
    p_height: patch.height ?? null,
    p_sort_order: patch.sortOrder ?? null,
    p_kind: patch.kind ?? null,
    p_note: patch.note ?? null,
  });

  if (error) throw error;
}

/**
 * The same hall, the next night.
 *
 * A sector is tied to a ticket type and a ticket type belongs to one event, so
 * without this an arena gets redrawn for every night it runs. Sectors are
 * matched to the new event's ticket types **by name** — matching by position or
 * by price would be a guess, and a wrong guess here sells the cheap seats at the
 * expensive price.
 */
export async function cloneVenueMap(input: {
  sourceMapId: string;
  eventId: string;
  name?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc('clone_venue_map', {
    p_source_map_id: input.sourceMapId,
    p_event_id: input.eventId,
    p_name: input.name ?? null,
  });

  if (error) throw error;
  return data as string;
}

/**
 * Takes seats out of sale, or says what they are.
 *
 * A pillar, a wheelchair space, a seat the fire officer took away — all of
 * these are seats that exist and must not be sold as ordinary chairs. Null
 * leaves a field as it was.
 */
export async function setSeatState(
  seatIds: string[],
  patch: { sellable?: boolean; kind?: string; note?: string },
): Promise<number> {
  const { data, error } = await supabase.rpc('set_seat_state', {
    p_seat_ids: seatIds,
    p_sellable: patch.sellable ?? null,
    p_kind: patch.kind ?? null,
    p_note: patch.note ?? null,
  });

  if (error) throw error;
  return (data as number) ?? 0;
}

/** Every seat of a sector, for the editor's own list. */
export async function getSectionSeats(sectionId: string): Promise<{
  id: string; row_label: string; seat_number: number; is_sellable: boolean; kind: string; note: string | null;
}[]> {
  const { data, error } = await supabase
    .from('venue_seats')
    .select('id, row_label, seat_number, is_sellable, kind, note')
    .eq('venue_section_id', sectionId)
    .order('row_label')
    .order('seat_number');

  if (error) throw error;
  return (data ?? []) as {
    id: string; row_label: string; seat_number: number; is_sellable: boolean; kind: string; note: string | null;
  }[];
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

export interface ReusablePlan {
  event_id: string;
  venue_map_id: string;
  title: string;
  start_at: string;
}

/**
 * Plans this organization already has, to copy onto a new night.
 *
 * Offered on an event that has none, which is the direction this actually goes:
 * you are setting up Saturday and last month's plan of the same hall is right
 * there. The other direction — pushing a plan forward onto events you have not
 * opened yet — is a way to overwrite one by accident.
 */
export async function getReusablePlans(input: {
  organizationId: string;
  excludeEventId: string;
}): Promise<ReusablePlan[]> {
  const { data, error } = await supabase
    .from('events')
    .select('id, title, start_at, venue_map_id')
    .eq('organization_id', input.organizationId)
    .not('venue_map_id', 'is', null)
    .neq('id', input.excludeEventId)
    .order('start_at', { ascending: false })
    .limit(20);

  if (error) throw error;
  return (data ?? []).map((row) => ({
    event_id: row.id as string,
    venue_map_id: row.venue_map_id as string,
    title: row.title as string,
    start_at: row.start_at as string,
  }));
}
