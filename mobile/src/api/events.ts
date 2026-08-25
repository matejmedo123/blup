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
  organization: { id: string; name: string; logo_url: string | null; verification_status: string } | null;
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
         organization:organizations (id, name, logo_url, verification_status),
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

export interface CreateEventInput {
  /** Set when the event sells by sector or seat. */
  venueMapId?: string | null;
  title: string;
  description?: string;
  category: string;
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
  const { error } = await supabase.from('events').delete().eq('id', eventId);
  if (error) throw error;
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
