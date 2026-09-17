import { supabase } from '@/lib/supabase';
import type {
  BlupEvent, Comment, EventFeedItem, TicketType, Coordinates, AttendeeStatus, Profile,
} from '@/types/models';
import { recordSignal } from './signals';

/**
 * Event API — discovery, detail, creation, RSVP and saves.
 * Every function here maps 1:1 to something the UI does.
 */

export interface NearbyParams extends Partial<Coordinates> {
  radiusM?: number;
  from?: Date;
  to?: Date;
  categories?: string[];
  freeOnly?: boolean;
  limit?: number;
  offset?: number;
}

export async function getNearbyEvents(params: NearbyParams): Promise<EventFeedItem[]> {
  if (params.latitude === undefined || params.longitude === undefined) return [];

  const { data, error } = await supabase.rpc('events_nearby', {
    p_lat: params.latitude,
    p_lon: params.longitude,
    p_radius_m: params.radiusM ?? 25000,
    p_from: (params.from ?? new Date()).toISOString(),
    p_to: params.to?.toISOString() ?? null,
    p_categories: params.categories?.length ? params.categories : null,
    p_free_only: params.freeOnly ?? false,
    p_limit: params.limit ?? 50,
    p_offset: params.offset ?? 0,
  });

  if (error) throw error;
  return (data ?? []) as EventFeedItem[];
}

/**
 * The feed the home screen and the deck show.
 *
 * With coordinates it is the geo query; without them (permission denied, or a
 * browser that never asked) it degrades to the plain upcoming list instead of
 * returning nothing — a visitor who says no to location still came to see what
 * is on, and an empty screen would be a lie about the city.
 */
export async function getFeedEvents(params: NearbyParams): Promise<EventFeedItem[]> {
  if (params.latitude !== undefined && params.longitude !== undefined) {
    return getNearbyEvents(params);
  }

  return searchEvents({
    from: params.from,
    to: params.to,
    categories: params.categories,
    freeOnly: params.freeOnly,
    sort: 'start_at',
    limit: params.limit,
    offset: params.offset,
  });
}

export interface SearchParams extends Partial<Coordinates> {
  query?: string;
  radiusM?: number;
  from?: Date;
  to?: Date;
  categories?: string[];
  freeOnly?: boolean;
  maxPriceCents?: number;
  sort?: 'start_at' | 'distance' | 'popularity';
  limit?: number;
  offset?: number;
}

export async function searchEvents(params: SearchParams): Promise<EventFeedItem[]> {
  const { data, error } = await supabase.rpc('search_events', {
    p_query: params.query?.trim() || null,
    p_lat: params.latitude ?? null,
    p_lon: params.longitude ?? null,
    p_radius_m: params.radiusM ?? null,
    p_from: (params.from ?? new Date()).toISOString(),
    p_to: params.to?.toISOString() ?? null,
    p_categories: params.categories?.length ? params.categories : null,
    p_free_only: params.freeOnly ?? false,
    p_max_price_cents: params.maxPriceCents ?? null,
    p_sort: params.sort ?? 'start_at',
    p_limit: params.limit ?? 40,
    p_offset: params.offset ?? 0,
  });

  if (error) throw error;
  return (data ?? []) as EventFeedItem[];
}

export interface EventDetail extends BlupEvent {
  creator: Pick<Profile, 'id' | 'username' | 'display_name' | 'avatar_url'> | null;
  organization: {
    id: string;
    name: string;
    logo_url: string | null;
    verification_status: string;
    /** Ticket prices are always gross; this only decides whether we say so. */
    is_vat_payer: boolean;
    vat_rate_bps: number;
  } | null;
  gallery: { id: string; url: string }[];
  ticket_types: TicketType[];
  my_rsvp: AttendeeStatus | null;
  is_saved: boolean;
  is_liked: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The address bar carries either a slug or the uuid we used to hand out.
 * Both have to work: a link someone pasted into a chat last month must not
 * start 404-ing because the addresses got readable.
 */
export async function getEvent(ref: string): Promise<EventDetail> {
  const column = UUID.test(ref) ? 'id' : 'slug';

  const [{ data: event, error }, { data: userData }] = await Promise.all([
    supabase
      .from('events')
      .select(
        `*,
         creator:profiles!events_creator_id_fkey (id, username, display_name, avatar_url),
         organization:organizations (id, name, logo_url, verification_status, is_vat_payer, vat_rate_bps),
         gallery:event_images (id, url, sort_order),
         ticket_types (*)`,
      )
      .eq(column, ref)
      .single(),
    supabase.auth.getUser(),
  ]);

  if (error) throw error;

  // Everything below keys off the real id, whichever form the address used.
  const eventId = (event as { id: string }).id;

  const userId = userData?.user?.id;
  let myRsvp: AttendeeStatus | null = null;
  let isSaved = false;
  let isLiked = false;

  if (userId) {
    const [attendee, saved, liked] = await Promise.all([
      supabase
        .from('event_attendees')
        .select('status')
        .eq('event_id', eventId)
        .eq('user_id', userId)
        .maybeSingle(),
      supabase
        .from('saved_events')
        .select('event_id')
        .eq('event_id', eventId)
        .eq('user_id', userId)
        .maybeSingle(),
      supabase
        .from('event_likes')
        .select('event_id')
        .eq('event_id', eventId)
        .eq('user_id', userId)
        .maybeSingle(),
    ]);

    myRsvp = (attendee.data?.status as AttendeeStatus) ?? null;
    isSaved = Boolean(saved.data);
    isLiked = Boolean(liked.data);
  }

  // NOTE: opening an event is deliberately *not* recorded here. This function
  // is a React Query fetcher and runs on every refetch, and it also backs the
  // checkout, edit, promo and seat-plan screens — recording here counted views
  // the visitor never made. The detail screen records its own view once.

  const raw = event as Record<string, unknown>;
  const gallery = ((raw.gallery ?? []) as { id: string; url: string; sort_order: number }[]).sort(
    (a, b) => a.sort_order - b.sort_order,
  );

  return {
    ...(event as unknown as BlupEvent),
    creator: (raw.creator ?? null) as EventDetail['creator'],
    organization: (raw.organization ?? null) as EventDetail['organization'],
    gallery,
    ticket_types: ((raw.ticket_types ?? []) as TicketType[]).filter((t) => t.is_active),
    my_rsvp: myRsvp,
    is_saved: isSaved,
    is_liked: isLiked,
  };
}

/**
 * Whether the organizer behind an event is registered for VAT, and at what rate.
 *
 * Only for the "s DPH 23 %" note next to a price — buyers are shown one number,
 * the full one. The basket knows its event but not its organizer, and this is
 * cheaper than widening the basket's SQL function for a label.
 */
export async function getEventVatInfo(
  eventId: string,
): Promise<{ isVatPayer: boolean; rateBps: number }> {
  const { data, error } = await supabase
    .from('events')
    .select('organization:organizations (is_vat_payer, vat_rate_bps)')
    .eq('id', eventId)
    .maybeSingle();

  if (error) throw error;

  const organization = (data as { organization?: { is_vat_payer?: boolean; vat_rate_bps?: number } } | null)
    ?.organization;

  return {
    isVatPayer: Boolean(organization?.is_vat_payer),
    rateBps: organization?.vat_rate_bps ?? 2300,
  };
}

export interface CreateEventInput {
  /** Set when the event sells by sector or seat. */
  venueMapId?: string | null;
  title: string;
  description?: string;
  category: string;
  /** Up to three, primary first. Defaults to just `category`. */
  categories?: string[];
  /** Staff only: BLUP listed this on somebody else's behalf. See migration 0048. */
  listedByPlatform?: boolean;
  externalOrganizerName?: string | null;
  externalSourceUrl?: string | null;
  tags?: string[];
  latitude: number;
  longitude: number;
  address?: string;
  venueName?: string;
  city?: string;
  country?: string;
  startAt: Date;
  endAt?: Date | null;
  capacity?: number | null;
  isFree: boolean;
  priceCents?: number;
  currency?: string;
  coverImageUrl?: string | null;
  organizationId?: string | null;
  /** Hosting community — makes this a micro-event. Membership is enforced in SQL. */
  communityId?: string | null;
  visibility?: 'public' | 'followers' | 'private' | 'unlisted';
  status?: 'draft' | 'published';
}

export async function createEvent(input: CreateEventInput): Promise<BlupEvent> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const { data, error } = await supabase
    .from('events')
    .insert({
      creator_id: userId,
      organization_id: input.organizationId ?? null,
      community_id: input.communityId ?? null,
      title: input.title.trim(),
      description: input.description?.trim() || null,
      category: input.category,
      // The primary leads; the database re-seats the list if it does not.
      categories: input.categories ?? [input.category],
      listed_by_platform: input.listedByPlatform ?? false,
      external_organizer_name: input.externalOrganizerName ?? null,
      external_source_url: input.externalSourceUrl ?? null,
      tags: input.tags ?? [],
      latitude: input.latitude,
      longitude: input.longitude,
      address: input.address ?? null,
      venue_name: input.venueName ?? null,
      city: input.city ?? null,
      country: input.country ?? null,
      start_at: input.startAt.toISOString(),
      end_at: input.endAt ? input.endAt.toISOString() : null,
      capacity: input.capacity ?? null,
      is_free: input.isFree,
      price_cents: input.isFree ? 0 : (input.priceCents ?? 0),
      currency: input.currency ?? 'EUR',
      cover_image_url: input.coverImageUrl ?? null,
      visibility: input.visibility ?? 'public',
      status: input.status ?? 'published',
    })
    .select()
    .single();

  if (error) throw error;
  return data as BlupEvent;
}

/** One ticket type, as typed into the create form. */
export interface NewTicketType {
  name: string;
  description?: string;
  priceCents: number;
  quantityTotal: number;
  maxPerOrder?: number;
}

/**
 * Creates an event together with everything it needs to sell.
 *
 * Ticket types used to be a second screen reached from an alert after the
 * event already existed, so a dismissed alert left a paid event with nothing
 * on sale. The database does both in one transaction and refuses the halfway
 * states outright, which is why this goes through an RPC rather than two
 * inserts from here.
 */
export async function createEventWithTickets(
  input: CreateEventInput,
  ticketTypes: NewTicketType[] = [],
): Promise<BlupEvent> {
  const { data, error } = await supabase.rpc('create_event_with_tickets', {
    p_event: {
      organization_id: input.organizationId ?? null,
      community_id: input.communityId ?? null,
      title: input.title.trim(),
      description: input.description?.trim() || null,
      category: input.category,
      tags: input.tags ?? [],
      latitude: input.latitude,
      longitude: input.longitude,
      address: input.address ?? null,
      venue_name: input.venueName ?? null,
      city: input.city ?? null,
      country: input.country ?? null,
      start_at: input.startAt.toISOString(),
      end_at: input.endAt ? input.endAt.toISOString() : null,
      capacity: input.capacity ?? null,
      is_free: input.isFree,
      currency: input.currency ?? 'EUR',
      cover_image_url: input.coverImageUrl ?? null,
      visibility: input.visibility ?? 'public',
      status: input.status ?? 'published',
    },
    p_ticket_types: ticketTypes.map((t) => ({
      name: t.name.trim(),
      description: t.description?.trim() || null,
      price_cents: t.priceCents,
      quantity_total: t.quantityTotal,
      max_per_order: t.maxPerOrder ?? null,
    })),
  });

  if (error) throw error;
  return data as BlupEvent;
}

export async function updateEvent(
  eventId: string,
  patch: Partial<CreateEventInput>,
): Promise<BlupEvent> {
  const payload: Record<string, unknown> = {};

  if (patch.title !== undefined) payload.title = patch.title.trim();
  if (patch.description !== undefined) payload.description = patch.description?.trim() || null;
  if (patch.category !== undefined) payload.category = patch.category;
  // The trigger re-seats the list around the primary, so sending both is safe
  // in either order.
  if (patch.categories !== undefined) payload.categories = patch.categories;
  if (patch.tags !== undefined) payload.tags = patch.tags;
  if (patch.latitude !== undefined) payload.latitude = patch.latitude;
  if (patch.longitude !== undefined) payload.longitude = patch.longitude;
  if (patch.address !== undefined) payload.address = patch.address;
  if (patch.venueName !== undefined) payload.venue_name = patch.venueName;
  if (patch.startAt !== undefined) payload.start_at = patch.startAt.toISOString();
  if (patch.endAt !== undefined) payload.end_at = patch.endAt ? patch.endAt.toISOString() : null;
  if (patch.capacity !== undefined) payload.capacity = patch.capacity;
  if (patch.coverImageUrl !== undefined) payload.cover_image_url = patch.coverImageUrl;
  if (patch.visibility !== undefined) payload.visibility = patch.visibility;
  if (patch.venueMapId !== undefined) payload.venue_map_id = patch.venueMapId;
  if (patch.status !== undefined) payload.status = patch.status;
  if (patch.isFree !== undefined) {
    payload.is_free = patch.isFree;
    payload.price_cents = patch.isFree ? 0 : (patch.priceCents ?? 0);
  }

  const { data, error } = await supabase
    .from('events')
    .update(payload)
    .eq('id', eventId)
    .select()
    .single();

  if (error) throw error;
  return data as BlupEvent;
}

// --- photos -----------------------------------------------------------------

export interface EventImage {
  id: string;
  event_id: string;
  url: string;
  storage_path: string | null;
  sort_order: number;
  created_at: string;
}

export async function getEventImages(eventId: string): Promise<EventImage[]> {
  const { data, error } = await supabase
    .from('event_images')
    .select('*')
    .eq('event_id', eventId)
    .order('sort_order', { ascending: true });

  if (error) throw error;
  return (data ?? []) as EventImage[];
}

/** Promotes one gallery photo to the event's cover — the card image. */
export async function setEventCover(eventId: string, url: string | null): Promise<void> {
  const { error } = await supabase
    .from('events')
    .update({ cover_image_url: url })
    .eq('id', eventId);

  if (error) throw error;
}

export async function cancelEvent(eventId: string): Promise<void> {
  const { error } = await supabase.from('events').update({ status: 'cancelled' }).eq('id', eventId);
  if (error) throw error;
}

export async function deleteEvent(eventId: string): Promise<void> {
  // `.select()` matters: under RLS a delete the policy refuses is not an error,
  // it is a delete of zero rows. Without reading back what went, "Zmazať
  // natrvalo" would report success over an event that is still there.
  const { data, error } = await supabase
    .from('events')
    .delete()
    .eq('id', eventId)
    .select('id');

  if (error) throw error;
  if (!data || data.length === 0) throw new Error('NOT_AUTHORIZED');
}

// --- RSVP / save / like -----------------------------------------------------

export async function rsvpToEvent(eventId: string, status: AttendeeStatus): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const { error } = await supabase
    .from('event_attendees')
    .upsert({ event_id: eventId, user_id: userId, status }, { onConflict: 'event_id,user_id' });

  if (error) throw error;

  void recordSignal(eventId, status === 'going' ? 'rsvp_going' : 'rsvp_interested');
}

export async function cancelRsvp(eventId: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const { error } = await supabase
    .from('event_attendees')
    .delete()
    .eq('event_id', eventId)
    .eq('user_id', userId);

  if (error) throw error;
  void recordSignal(eventId, 'rsvp_cancel');
}

export async function saveEvent(eventId: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const { error } = await supabase
    .from('saved_events')
    .upsert({ event_id: eventId, user_id: userId }, { onConflict: 'user_id,event_id' });

  if (error) throw error;
  void recordSignal(eventId, 'save');
}

export async function unsaveEvent(eventId: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const { error } = await supabase
    .from('saved_events')
    .delete()
    .eq('event_id', eventId)
    .eq('user_id', userId);

  if (error) throw error;
  void recordSignal(eventId, 'unsave');
}

export async function toggleLike(eventId: string, liked: boolean): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  if (liked) {
    const { error } = await supabase
      .from('event_likes')
      .upsert({ event_id: eventId, user_id: userId }, { onConflict: 'user_id,event_id' });
    if (error) throw error;
    void recordSignal(eventId, 'like');
  } else {
    const { error } = await supabase
      .from('event_likes')
      .delete()
      .eq('event_id', eventId)
      .eq('user_id', userId);
    if (error) throw error;
    void recordSignal(eventId, 'unlike');
  }
}

export async function getSavedEvents(): Promise<EventFeedItem[]> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return [];

  const { data, error } = await supabase
    .from('saved_events')
    .select('event:events (*)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;

  return ((data ?? []) as unknown as { event: BlupEvent | null }[])
    .map((row) => row.event)
    .filter((event): event is BlupEvent => Boolean(event))
    .map((event) => toFeedItem(event));
}

export async function getMyEvents(): Promise<BlupEvent[]> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return [];

  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('creator_id', userId)
    .order('start_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as BlupEvent[];
}

export async function getAttendingEvents(): Promise<BlupEvent[]> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return [];

  const { data, error } = await supabase
    .from('event_attendees')
    .select('status, event:events (*)')
    .eq('user_id', userId)
    .in('status', ['going', 'interested', 'checked_in']);

  if (error) throw error;

  return ((data ?? []) as unknown as { event: BlupEvent | null }[])
    .map((row) => row.event)
    .filter((event): event is BlupEvent => Boolean(event))
    .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
}

/**
 * Has this event finished?
 *
 * The same rule as public.event_has_ended(): with no end time an event is taken
 * to run four hours — long enough that a gig is not called over while people are
 * still inside, short enough that yesterday's is.
 */
export function eventHasEnded(event: { start_at: string; end_at?: string | null }): boolean {
  const ends = event.end_at
    ? new Date(event.end_at).getTime()
    : new Date(event.start_at).getTime() + 4 * 60 * 60 * 1000;
  return Number.isFinite(ends) && ends < Date.now();
}

// --- attendees & comments ---------------------------------------------------

export interface Attendee {
  user_id: string;
  status: AttendeeStatus;
  profile: Pick<Profile, 'id' | 'username' | 'display_name' | 'avatar_url' | 'bio'> | null;
}

export async function getEventAttendees(eventId: string, limit = 50): Promise<Attendee[]> {
  const { data, error } = await supabase
    .from('event_attendees')
    .select('user_id, status, profile:profiles (id, username, display_name, avatar_url, bio)')
    .eq('event_id', eventId)
    .in('status', ['going', 'checked_in'])
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as unknown as Attendee[];
}

/** "5 people you follow are going" — the social proof line on the detail screen. */
export async function getFollowedAttendees(eventId: string): Promise<Attendee[]> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return [];

  const { data: following, error: followError } = await supabase
    .from('follows')
    .select('following_id')
    .eq('follower_id', userId);

  if (followError) throw followError;

  const ids = (following ?? []).map((row) => row.following_id as string);
  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from('event_attendees')
    .select('user_id, status, profile:profiles (id, username, display_name, avatar_url, bio)')
    .eq('event_id', eventId)
    .in('user_id', ids)
    .in('status', ['going', 'checked_in']);

  if (error) throw error;
  return (data ?? []) as unknown as Attendee[];
}

export async function getComments(eventId: string): Promise<Comment[]> {
  const { data, error } = await supabase
    .from('comments')
    .select('*, author:profiles (id, username, display_name, avatar_url)')
    .eq('event_id', eventId)
    .eq('is_deleted', false)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as unknown as Comment[];
}

export async function addComment(eventId: string, body: string): Promise<Comment> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const trimmed = body.trim();
  if (trimmed.length === 0) throw new Error('Najprv niečo napíš.');
  if (trimmed.length > 1000) throw new Error('Komentár môže mať najviac 1000 znakov.');

  const { data, error } = await supabase
    .from('comments')
    .insert({ event_id: eventId, user_id: userId, body: trimmed })
    .select('*, author:profiles (id, username, display_name, avatar_url)')
    .single();

  if (error) throw error;
  void recordSignal(eventId, 'comment');
  return data as unknown as Comment;
}

export async function deleteComment(commentId: string): Promise<void> {
  const { error } = await supabase.from('comments').update({ is_deleted: true }).eq('id', commentId);
  if (error) throw error;
}

/** Adapts a plain events row to the feed shape used by the cards. */
export function toFeedItem(event: BlupEvent, extra: Partial<EventFeedItem> = {}): EventFeedItem {
  return {
    ...event,
    creator_username: null,
    creator_display_name: null,
    creator_avatar_url: null,
    organization_name: null,
    organization_verified: null,
    distance_m: null,
    friends_going: 0,
    is_saved: false,
    is_attending: false,
    score: null,
    score_breakdown: null,
    ...extra,
  } as EventFeedItem;
}

// --- events BLUP listed on somebody else's behalf ----------------------------

/**
 * "This is our event."
 *
 * A request, not a transfer: anyone can press the button, so nothing moves
 * until a person at BLUP agrees. See migration 0048.
 */
export async function claimEvent(
  eventId: string,
  organizationId: string,
  note?: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('claim_event', {
    p_event_id: eventId,
    p_organization_id: organizationId,
    p_note: note ?? null,
  });
  if (error) throw error;
}

/**
 * Events far enough away to need a decision, good enough to be worth one.
 *
 * Discovery stops at the radius, which is right for "what is on tonight" and
 * wrong for everything else — somebody in Nitra never saw the one concert in
 * Bratislava they would have driven to. Deliberately few, and empty rather than
 * padded: an empty section is a better answer than a bad suggestion two hours
 * away. See migration 0054.
 */
export async function getWorthTheTrip(coords?: {
  latitude: number;
  longitude: number;
} | null): Promise<EventFeedItem[]> {
  const { data, error } = await supabase.rpc('events_worth_the_trip', {
    p_lat: coords?.latitude ?? null,
    p_lon: coords?.longitude ?? null,
  });
  if (error) throw error;
  return (data ?? []) as EventFeedItem[];
}

/**
 * Why an event an hour away might still be for you.
 *
 * Returns null when there is nothing to say — the event is nearby, or too far,
 * or over, or simply not a match. The screen then shows nothing, which is the
 * right amount to say about an event that is just an event.
 */
export interface TripPitch {
  distance_m: number;
  city: string | null;
  matches_taste: boolean;
  friends_going: number;
  attendee_count: number;
}

export async function getTripPitch(
  eventId: string,
  coords?: { latitude: number; longitude: number } | null,
): Promise<TripPitch | null> {
  const { data, error } = await supabase.rpc('event_trip_pitch', {
    p_event_id: eventId,
    p_lat: coords?.latitude ?? null,
    p_lon: coords?.longitude ?? null,
  });
  if (error) throw error;
  return (data as TripPitch | null) ?? null;
}

/** The pitch as a sentence, in the words somebody would use to a friend. */
export function tripPitchLine(pitch: TripPitch): string {
  const km = Math.round(pitch.distance_m / 1000);
  const where = pitch.city ?? 'Je to';

  if (pitch.friends_going > 0) {
    return `${where} je ${km} km od teba — ale ide tam ${pitch.friends_going === 1
      ? 'niekto, koho poznáš'
      : `${pitch.friends_going} ľudí, ktorých poznáš`}.`;
  }
  if (pitch.matches_taste && pitch.attendee_count >= 100) {
    return `${where} je ${km} km od teba — sedí to na to, čo ťa baví, a ide tam ${pitch.attendee_count} ľudí.`;
  }
  if (pitch.matches_taste) {
    return `${where} je ${km} km od teba — ale presne toto ťa baví.`;
  }
  return `${where} je ${km} km od teba — ide tam ${pitch.attendee_count} ľudí.`;
}

/**
 * Feed rows for a handful of ids.
 *
 * A sponsored card is an ordinary card, so it needs the ordinary shape —
 * distance, saved, friends going. Reshaping the detail response in the client
 * instead is how two cards of the same event end up looking different.
 */
export async function getEventsForCards(
  ids: string[],
  coords?: { latitude: number; longitude: number } | null,
): Promise<EventFeedItem[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase.rpc('events_for_cards', {
    p_ids: ids,
    p_lat: coords?.latitude ?? null,
    p_lon: coords?.longitude ?? null,
  });
  if (error) throw error;
  return (data ?? []) as EventFeedItem[];
}
