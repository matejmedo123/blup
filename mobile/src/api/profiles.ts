import { supabase } from '@/lib/supabase';
import type { EventFeedItem, Interest, Profile } from '@/types/models';

/** Profile, interests and the follow graph. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Takes whatever the address bar holds: a uuid, @handle, or a bare handle.
 * Handles are citext, so case does not matter.
 */
export async function getProfile(ref: string): Promise<Profile | null> {
  const handle = ref.startsWith('@') ? ref.slice(1) : ref;
  const query = UUID.test(ref)
    ? supabase.from('profiles').select('*').eq('id', ref)
    : supabase.from('profiles').select('*').eq('username', handle);

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as Profile) ?? null;
}

export async function getProfileByUsername(username: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('username', username.toLowerCase())
    .maybeSingle();
  if (error) throw error;
  return (data as Profile) ?? null;
}

export interface ProfileUpdate {
  display_name?: string;
  username?: string;
  bio?: string | null;
  city?: string | null;
  country?: string | null;
  avatar_url?: string | null;
  is_private?: boolean;
  show_location?: boolean;
  anonymous_mode?: boolean;
  allow_dm?: boolean;
  onboarding_completed?: boolean;
  locale?: string;
}

export async function updateProfile(patch: ProfileUpdate): Promise<Profile> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  if (patch.username !== undefined) {
    const username = patch.username.trim().toLowerCase();
    if (!/^[a-z0-9_.]{3,24}$/.test(username)) {
      throw new Error('Meno musí mať 3–24 znakov: písmená, čísla, _ alebo bodka.');
    }
    patch.username = username;
  }

  if (patch.bio && patch.bio.length > 300) {
    throw new Error('O mne môže mať najviac 300 znakov.');
  }

  const { data, error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', userId)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') throw new Error('Toto používateľské meno už niekto má.');
    throw error;
  }

  return data as Profile;
}

export async function isUsernameAvailable(username: string): Promise<boolean> {
  const candidate = username.trim().toLowerCase();
  if (!/^[a-z0-9_.]{3,24}$/.test(candidate)) return false;

  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('profiles')
    .select('id')
    .eq('username', candidate)
    .maybeSingle();

  if (error) throw error;
  return !data || data.id === userData?.user?.id;
}

/** Stores the device position so distance ranking works for this user. */
export async function updateMyLocation(coords: {
  latitude: number;
  longitude: number;
  city?: string | null;
  country?: string | null;
}): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return;

  const { error } = await supabase
    .from('profiles')
    .update({
      latitude: coords.latitude,
      longitude: coords.longitude,
      city: coords.city ?? undefined,
      country: coords.country ?? undefined,
      location_updated_at: new Date().toISOString(),
    })
    .eq('id', userId);

  if (error) throw error;
}

// --- interests --------------------------------------------------------------

export async function getInterests(): Promise<Interest[]> {
  const { data, error } = await supabase
    .from('interests')
    .select('*')
    .order('sort_order', { ascending: true });

  if (error) throw error;
  return (data ?? []) as Interest[];
}

export async function getMyInterests(): Promise<string[]> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return [];

  const { data, error } = await supabase
    .from('user_interests')
    .select('interest_id')
    .eq('user_id', userId);

  if (error) throw error;
  return (data ?? []).map((row) => row.interest_id as string);
}

export async function setMyInterests(interestIds: string[]): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  // Replace the whole set: simplest correct semantics for a picker screen.
  const { error: deleteError } = await supabase
    .from('user_interests')
    .delete()
    .eq('user_id', userId);

  if (deleteError) throw deleteError;
  if (interestIds.length === 0) return;

  const { error } = await supabase
    .from('user_interests')
    .insert(interestIds.map((id) => ({ user_id: userId, interest_id: id })));

  if (error) throw error;
}

export async function getInterestsFor(userId: string): Promise<Interest[]> {
  const { data, error } = await supabase
    .from('user_interests')
    .select('interest:interests (*)')
    .eq('user_id', userId);

  if (error) throw error;
  return ((data ?? []) as unknown as { interest: Interest | null }[])
    .map((row) => row.interest)
    .filter((interest): interest is Interest => Boolean(interest));
}

// --- follows ----------------------------------------------------------------

export async function followUser(targetId: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');
  if (userId === targetId) throw new Error('Sám seba sledovať nemôžeš.');

  const { error } = await supabase
    .from('follows')
    .upsert(
      { follower_id: userId, following_id: targetId },
      { onConflict: 'follower_id,following_id' },
    );

  if (error) throw error;
}

export async function unfollowUser(targetId: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const { error } = await supabase
    .from('follows')
    .delete()
    .eq('follower_id', userId)
    .eq('following_id', targetId);

  if (error) throw error;
}

export async function isFollowing(targetId: string): Promise<boolean> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return false;

  const { data, error } = await supabase
    .from('follows')
    .select('following_id')
    .eq('follower_id', userId)
    .eq('following_id', targetId)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}

export async function getFollowCounts(userId: string): Promise<{ followers: number; following: number }> {
  const [followers, following] = await Promise.all([
    supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', userId),
    supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', userId),
  ]);

  return { followers: followers.count ?? 0, following: following.count ?? 0 };
}

export async function getFollowers(userId: string): Promise<Profile[]> {
  const { data, error } = await supabase
    .from('follows')
    .select('profile:profiles!follows_follower_id_fkey (*)')
    .eq('following_id', userId)
    .limit(100);

  if (error) throw error;
  return ((data ?? []) as unknown as { profile: Profile | null }[])
    .map((row) => row.profile)
    .filter((profile): profile is Profile => Boolean(profile));
}

export async function getFollowing(userId: string): Promise<Profile[]> {
  const { data, error } = await supabase
    .from('follows')
    .select('profile:profiles!follows_following_id_fkey (*)')
    .eq('follower_id', userId)
    .limit(100);

  if (error) throw error;
  return ((data ?? []) as unknown as { profile: Profile | null }[])
    .map((row) => row.profile)
    .filter((profile): profile is Profile => Boolean(profile));
}

/** Public events created by a user, for their profile screen. */
export async function getEventsByCreator(userId: string): Promise<EventFeedItem[]> {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('creator_id', userId)
    .eq('status', 'published')
    .order('start_at', { ascending: true });

  if (error) throw error;

  return ((data ?? []) as unknown as EventFeedItem[]).map((event) => ({
    ...event,
    friends_going: 0,
    is_saved: false,
    is_attending: false,
    distance_m: null,
    score: null,
    score_breakdown: null,
  }));
}

export async function searchProfiles(query: string, limit = 20): Promise<Profile[]> {
  const term = query.trim();
  if (term.length < 2) return [];

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .or(`username.ilike.%${term}%,display_name.ilike.%${term}%`)
    .eq('is_suspended', false)
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as Profile[];
}

/**
 * Is this handle free?
 *
 * Asked while somebody types, so it answers about one handle and nothing else —
 * it is not a search. Saves finding out through a failed save.
 */
export async function checkUsername(username: string): Promise<{
  ok: boolean;
  reason: 'TOO_SHORT' | 'TOO_LONG' | 'BAD_CHARACTERS' | 'TAKEN' | null;
}> {
  const { data, error } = await supabase.rpc('username_available', { p_username: username });
  if (error) throw error;
  return data as never;
}

/** The handle we would suggest for a name — the same folding the server does. */
export function suggestUsername(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 20);
}
