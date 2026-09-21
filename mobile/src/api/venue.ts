import { supabase } from '@/lib/supabase';
import { LANDMARK_KINDS, type Section, type SectionKind } from './seating';

export interface VenueMap {
  id: string;
  organization_id: string;
  name: string;
  image_url: string | null;
  image_width: number;
  image_height: number;
  /**
   * The picture is something to trace over, not the plan itself.
   *
   * Default. An organizer photographs the hall, draws the sectors on top of it
   * and the buyer sees the sectors — not the photograph. Turning it off
   * publishes the image as the background of the plan people buy from, which
   * is only worth doing when it is a real seating chart rather than a snapshot.
   */
  image_is_backdrop: boolean;
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
      rotation: Number(row.rotation ?? 0),
      shape: (row.shape as { x: number; y: number }[]) ?? null,
      holes: (row.holes as { x: number; y: number }[][]) ?? null,
      seat_pitch: row.seat_pitch === null || row.seat_pitch === undefined
        ? null : Number(row.seat_pitch),
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
  /**
   * How the rows are named, so the plan matches what is painted in the hall.
   * Theatres letter them; stadiums number them.
   */
  rowStyle?: 'letters' | 'numbers';
  /** For halls whose rows read "S1", "C-1" and so on. */
  rowPrefix?: string;
  /** First seat number in a row. A sector numbered 101–140 starts at 101. */
  seatStart?: number;
}): Promise<{ total: number; created: number; removed: number }> {
  const { data, error } = await supabase.rpc('generate_section_seats', {
    p_section_id: input.sectionId,
    p_rows: input.rows,
    p_per_row: input.perRow,
    p_start_row: input.startRow ?? 0,
    p_row_style: input.rowStyle ?? 'letters',
    p_row_prefix: input.rowPrefix ?? null,
    p_seat_start: input.seatStart ?? 1,
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
    /** Degrees. A stand is rarely square to the room. */
    rotation?: number;
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
    p_rotation: patch.rotation ?? null,
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

/**
 * Cutting a hole in a sector, or filling it back in.
 *
 * A stairway into the middle of a block, a pillar, the mouth of a tunnel. It
 * is deliberately not part of the outline: a sector is a band, and a notch in
 * the middle of one of its long edges leaves a shape with no two long edges,
 * at which point its rows stop lining up at all. The outline says where the
 * stand is; a hole says where inside it nobody sits.
 *
 * Seats already standing in a hole are not removed here — reflowSeats does
 * that, because it is the one that knows what has been sold.
 */
export async function setSectionHoles(
  sectionId: string,
  holes: { x: number; y: number }[][] | null,
): Promise<number> {
  const { data, error } = await supabase.rpc('set_section_holes', {
    p_section_id: sectionId,
    p_holes: holes && holes.length > 0 ? holes : null,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

/**
 * One more seat in a row, or one fewer — by hand.
 *
 * Stands are not regular. A row runs a seat longer on one side, one is missing
 * by the stairway, a wheelchair space takes the width of two. A generated grid
 * has no way of knowing any of that, so the organizer has to be able to say
 * it.
 *
 * The seat goes on the next point of the sector's grid past the end of the
 * row, left or right, so every other seat in the row stays exactly where it
 * was. The row is then renumbered in order, which is why it cannot be done in
 * a row that has anything sold or held in it — somebody's seat number would
 * change under them.
 */
export async function addSectionSeat(
  sectionId: string,
  rowLabel: string,
  side: 'left' | 'right' = 'right',
  /**
   * An exact point of the sector's grid, for placing a seat by pointing at the
   * plan rather than extending a row. Twice its distance from the middle of
   * the row, in spacings — the same number a seat stores.
   */
  slot?: number,
): Promise<{
  seat_id: string; row: string; number: number; slot: number;
  renumbered: boolean; total: number;
}> {
  const { data, error } = await supabase.rpc('add_section_seat', {
    p_section_id: sectionId,
    p_row_label: rowLabel,
    p_side: side,
    p_slot: slot ?? null,
  });

  if (error) throw error;
  return data as {
    seat_id: string; row: string; number: number; slot: number;
    renumbered: boolean; total: number;
  };
}

/**
 * A copy of a sector: same size, colour, kind, rotation and seat layout.
 *
 * A stadium has four identical stands. Drawing them four times produces four
 * slightly different rectangles, and on a plan that is visible.
 *
 * The copy gets no ticket type — a sector that sells, duplicated, would be two
 * sectors selling the same stock at the same price.
 */
export async function duplicateSection(sectionId: string): Promise<Section> {
  const { data, error } = await supabase.rpc('duplicate_section', {
    p_section_id: sectionId,
  });
  if (error) throw error;
  return data as Section;
}

/**
 * Deletes seats that are not there — a pillar in the middle, a gangway.
 *
 * Different from taking a seat out of sale: a seat that exists and is not sold
 * should stay visible on the plan, because somebody sits next to it and can see
 * it is empty. A seat that does not exist should be gone.
 *
 * Refuses when any of them is sold or held.
 */
export async function deleteSeats(seatIds: string[]): Promise<number> {
  const { data, error } = await supabase.rpc('delete_seats', { p_seat_ids: seatIds });
  if (error) throw error;
  return (data as number) ?? 0;
}

/** Renames one row, keeping the seats — and so keeping sold tickets attached. */
export async function renameRow(
  sectionId: string,
  oldLabel: string,
  newLabel: string,
): Promise<number> {
  const { data, error } = await supabase.rpc('rename_section_row', {
    p_section_id: sectionId,
    p_old_label: oldLabel,
    p_new_label: newLabel,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

/**
 * Gives a sector an outline, or takes it away again.
 *
 * Its own call rather than another field on updateSection(): a shape also moves
 * x/y/width/height to its bounding box, so a call carrying both would be
 * arguing with itself.
 */
export async function setSectionShape(
  sectionId: string,
  shape: { x: number; y: number }[] | null,
): Promise<Section> {
  const { data, error } = await supabase.rpc('set_section_shape', {
    p_section_id: sectionId,
    p_shape: shape && shape.length >= 3 ? shape : null,
  });
  if (error) throw error;
  return data as Section;
}

/** Whether the uploaded picture is only for tracing, or is the published plan. */
export async function setBackdropOnly(mapId: string, backdropOnly: boolean): Promise<void> {
  const { error } = await supabase
    .from('venue_maps')
    .update({ image_is_backdrop: backdropOnly })
    .eq('id', mapId);
  if (error) throw error;
}

/** Every seat of a sector, for the editor's own list. */
export interface EditableSeat {
  id: string;
  row_label: string;
  seat_number: number;
  is_sellable: boolean;
  kind: string;
  note: string | null;
  /** Which point of the sector's grid it stands on. Null on older plans. */
  slot: number | null;
}

export async function getSectionSeats(sectionId: string): Promise<EditableSeat[]> {
  const { data, error } = await supabase
    .from('venue_seats')
    .select('id, row_label, seat_number, is_sellable, kind, note, slot')
    .eq('venue_section_id', sectionId)
    .order('row_label')
    .order('seat_number');

  if (error) throw error;
  return (data ?? []) as EditableSeat[];
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

/**
 * Drops the background picture, leaving every sector exactly where it is.
 *
 * The rectangles are fractions of the image rather than pixels, which is what
 * makes this safe — a badly photographed plan can be replaced and nothing
 * moves. That is the whole reason they are stored that way.
 */
export async function clearVenueMapImage(mapId: string): Promise<void> {
  const { error } = await supabase.rpc('clear_venue_map_image', { p_map_id: mapId });
  if (error) throw error;
}

export interface PlanRemoval {
  detached: boolean;
  deleted: boolean;
  /** The plan stayed because another night in the same hall is using it. */
  used_elsewhere?: boolean;
}

/**
 * Takes the plan off the event, and deletes it when nothing wants it.
 *
 * `keepPlan` is the safe way out once something has sold: the event goes back
 * to selling by count and every sold ticket still resolves the seat printed on
 * it. Deleting is refused in that case, because sectors and seats go with the
 * map and the foreign key on tickets is ON DELETE SET NULL — the row and number
 * would quietly vanish off tickets people had paid for.
 */
export async function removeVenuePlan(input: {
  eventId: string;
  keepPlan?: boolean;
}): Promise<PlanRemoval> {
  const { data, error } = await supabase.rpc('delete_venue_map', {
    p_event_id: input.eventId,
    p_keep_plan: input.keepPlan ?? false,
  });

  if (error) throw error;
  return data as PlanRemoval;
}

/** One of the ready-made hall shapes. */
export interface VenuePreset {
  code: string;
  name: string;
  description: string;
  sections: {
    name: string; kind: SectionKind; colour: string;
    x: number; y: number; width: number; height: number; rotation: number;
  }[];
}

export async function getVenuePresets(): Promise<VenuePreset[]> {
  const { data, error } = await supabase.rpc('venue_presets');
  if (error) throw error;
  return (data ?? []) as VenuePreset[];
}

/**
 * Draws a ready-made hall onto an event that has no plan yet.
 *
 * Drawing a hall from nothing is the hardest part of setting up seating and
 * the least interesting: a theatre has stalls and a balcony, a stadium has
 * four stands around a pitch. The shapes are always the same and nobody wants
 * to click them out again.
 *
 * Sectors arrive with no ticket type unless their name matches one exactly.
 * Guessing by order or by price would sell the cheap seats at the dear price.
 */
export async function applyVenuePreset(eventId: string, preset: string): Promise<string> {
  const { data, error } = await supabase.rpc('apply_venue_preset', {
    p_event_id: eventId,
    p_preset: preset,
  });
  if (error) throw error;
  return data as string;
}
