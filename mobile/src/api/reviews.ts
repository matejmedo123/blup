import { supabase } from '@/lib/supabase';
import type { Profile } from '@/types/models';

/**
 * Post-event feedback ("feedback po evente").
 *
 * A review can only be written through review_event(), which checks that the
 * event has started and that you were actually going — so a rating on BLUP
 * always comes from somebody who was there.
 */

export interface EventReview {
  id: string;
  event_id: string;
  user_id: string;
  rating: number;
  body: string | null;
  created_at: string;
  updated_at: string;
  author?: Pick<Profile, 'id' | 'display_name' | 'username' | 'avatar_url'> | null;
}

export interface EventRating {
  count: number;
  average: number;
}

export async function getEventRating(eventId: string): Promise<EventRating> {
  const { data, error } = await supabase.rpc('event_rating', { p_event: eventId });
  if (error) throw error;

  const value = (data ?? { count: 0, average: 0 }) as { count: number; average: number | string };
  return { count: Number(value.count ?? 0), average: Number(value.average ?? 0) };
}

export async function getEventReviews(eventId: string, limit = 20): Promise<EventReview[]> {
  const { data, error } = await supabase
    .from('event_reviews')
    .select('*, author:profiles!event_reviews_user_id_fkey (id, display_name, username, avatar_url)')
    .eq('event_id', eventId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as unknown as EventReview[];
}

export async function getMyReview(eventId: string): Promise<EventReview | null> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return null;

  const { data, error } = await supabase
    .from('event_reviews')
    .select('*')
    .eq('event_id', eventId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return (data as EventReview) ?? null;
}

export async function reviewEvent(
  eventId: string,
  rating: number,
  body?: string | null,
): Promise<string> {
  const { data, error } = await supabase.rpc('review_event', {
    p_event: eventId,
    p_rating: rating,
    p_body: body?.trim() || null,
  });

  if (error) throw error;
  return data as string;
}

export async function deleteMyReview(eventId: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const { error } = await supabase
    .from('event_reviews')
    .delete()
    .eq('event_id', eventId)
    .eq('user_id', userId);

  if (error) throw error;
}
