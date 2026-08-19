import { supabase } from '@/lib/supabase';
import type { Profile } from '@/types/models';

/**
 * Interest communities ("záujmové komunity") and their feed.
 *
 * A community is a themed group — Tech meetups, Indie music lovers — with its
 * own member list and post feed. Membership and posting are governed by the RLS
 * policies on `communities`, `community_members` and `posts`.
 */

export interface Community {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  cover_url: string | null;
  category: string;
  city: string | null;
  is_private: boolean;
  created_by: string;
  member_count: number;
  created_at: string;
  my_role?: string | null;
}

export interface CommunityPost {
  id: string;
  author_id: string;
  community_id: string | null;
  event_id: string | null;
  body: string;
  image_url: string | null;
  like_count: number;
  comment_count: number;
  created_at: string;
  author?: Pick<Profile, 'id' | 'display_name' | 'username' | 'avatar_url'> | null;
  event?: { id: string; title: string; category: string } | null;
  event_rating?: { count: number; average: number } | null;
  liked_by_me?: boolean;
}

export async function getCommunities(params: {
  query?: string;
  category?: string;
  city?: string;
  limit?: number;
} = {}): Promise<Community[]> {
  let request = supabase
    .from('communities')
    .select('*')
    .order('member_count', { ascending: false })
    .limit(params.limit ?? 40);

  if (params.query && params.query.trim().length >= 2) {
    request = request.ilike('name', `%${params.query.trim()}%`);
  }
  if (params.category) request = request.eq('category', params.category);
  if (params.city) request = request.eq('city', params.city);

  const { data, error } = await request;
  if (error) throw error;
  return (data ?? []) as Community[];
}

export async function getMyCommunities(): Promise<Community[]> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return [];

  const { data, error } = await supabase
    .from('community_members')
    .select('role, community:communities (*)')
    .eq('user_id', userId);

  if (error) throw error;

  return ((data ?? []) as unknown as { role: string; community: Community }[])
    .filter((row) => row.community)
    .map((row) => ({ ...row.community, my_role: row.role }));
}

export async function getCommunity(id: string): Promise<Community | null> {
  const { data, error } = await supabase
    .from('communities')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return (data as Community) ?? null;
}

export async function isCommunityMember(communityId: string): Promise<boolean> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return false;

  const { count, error } = await supabase
    .from('community_members')
    .select('*', { count: 'exact', head: true })
    .eq('community_id', communityId)
    .eq('user_id', userId);

  if (error) throw error;
  return (count ?? 0) > 0;
}

export async function joinCommunity(communityId: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const { error } = await supabase
    .from('community_members')
    .insert({ community_id: communityId, user_id: userId });

  if (error && error.code !== '23505') throw error;
}

export async function leaveCommunity(communityId: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const { error } = await supabase
    .from('community_members')
    .delete()
    .eq('community_id', communityId)
    .eq('user_id', userId);

  if (error) throw error;
}

export interface CommunityMember {
  role: string;
  created_at: string;
  profile: Pick<Profile, 'id' | 'display_name' | 'username' | 'avatar_url'> | null;
}

export async function getCommunityMembers(
  communityId: string,
  limit = 50,
): Promise<CommunityMember[]> {
  const { data, error } = await supabase
    .from('community_members')
    .select('role, created_at, profile:profiles (id, display_name, username, avatar_url)')
    .eq('community_id', communityId)
    .limit(limit);

  if (error) throw error;

  // PostgREST types an embedded one-to-one as an array; flatten it once here so
  // the screens do not each have to cast.
  return ((data ?? []) as unknown as (Omit<CommunityMember, 'profile'> & {
    profile: CommunityMember['profile'] | CommunityMember['profile'][];
  })[]).map((row) => ({
    ...row,
    profile: Array.isArray(row.profile) ? (row.profile[0] ?? null) : row.profile,
  }));
}

export async function createCommunity(input: {
  name: string;
  slug: string;
  description?: string | null;
  category: string;
  city?: string | null;
  isPrivate?: boolean;
}): Promise<Community> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const { data, error } = await supabase
    .from('communities')
    .insert({
      name: input.name.trim(),
      slug: input.slug.trim().toLowerCase(),
      description: input.description?.trim() || null,
      category: input.category,
      city: input.city?.trim() || null,
      is_private: input.isPrivate ?? false,
      created_by: userId,
    })
    .select()
    .single();

  if (error) throw error;

  // The founder is the first member; the DB trigger only maintains the count.
  await joinCommunity((data as Community).id);
  return data as Community;
}

// --- micro-events -----------------------------------------------------------

/**
 * Events hosted by a community — the concept document's "micro-eventy":
 * small workshops and meetups organised inside an interest group rather than
 * by a ticketing organizer.
 */
export async function getCommunityEvents(communityId: string, limit = 20) {
  const { data, error } = await supabase.rpc('community_events', {
    p_community: communityId,
    p_limit: limit,
  });

  if (error) throw error;
  return (data ?? []) as import('@/types/models').EventFeedItem[];
}

// --- feed -------------------------------------------------------------------

/**
 * The feed. `communityId` scopes it to one community, `eventId` to one event;
 * with neither it returns posts from the communities you belong to.
 */
export async function getPosts(params: {
  communityId?: string;
  eventId?: string;
  limit?: number;
} = {}): Promise<CommunityPost[]> {
  let request = supabase
    .from('posts')
    .select('*, author:profiles!posts_author_id_fkey (id, display_name, username, avatar_url)')
    .eq('is_deleted', false)
    .order('created_at', { ascending: false })
    .limit(params.limit ?? 50);

  if (params.communityId) request = request.eq('community_id', params.communityId);
  if (params.eventId) request = request.eq('event_id', params.eventId);

  const { data, error } = await request;
  if (error) throw error;

  const posts = (data ?? []) as unknown as CommunityPost[];

  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId || posts.length === 0) return posts;

  const { data: likes } = await supabase
    .from('post_likes')
    .select('post_id')
    .eq('user_id', userId)
    .in('post_id', posts.map((post) => post.id));

  const liked = new Set((likes ?? []).map((like) => like.post_id as string));
  return posts.map((post) => ({ ...post, liked_by_me: liked.has(post.id) }));
}

/**
 * The main feed: posts from people you follow and from communities you are in,
 * newest first. Falls back to the public feed for a brand-new account so the
 * screen is not empty before you follow anybody.
 */
export async function getFeed(limit = 50): Promise<CommunityPost[]> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;

  const { data, error } = await supabase
    .from('posts')
    .select(
      `*,
       author:profiles!posts_author_id_fkey (id, display_name, username, avatar_url),
       event:events (id, title, category)`,
    )
    .eq('is_deleted', false)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  const posts = (data ?? []) as unknown as CommunityPost[];
  if (!userId || posts.length === 0) return posts;

  const [{ data: likes }, ratings] = await Promise.all([
    supabase
      .from('post_likes')
      .select('post_id')
      .eq('user_id', userId)
      .in('post_id', posts.map((post) => post.id)),
    ratingsFor(posts),
  ]);

  const liked = new Set((likes ?? []).map((like) => like.post_id as string));

  return posts.map((post) => ({
    ...post,
    liked_by_me: liked.has(post.id),
    event_rating: post.event ? (ratings[post.event.id] ?? null) : null,
  }));
}

/** One rating lookup per distinct event, rather than one per post. */
async function ratingsFor(
  posts: CommunityPost[],
): Promise<Record<string, { count: number; average: number }>> {
  const eventIds = [...new Set(posts.map((post) => post.event?.id).filter(Boolean))] as string[];
  if (eventIds.length === 0) return {};

  const { data, error } = await supabase
    .from('event_reviews')
    .select('event_id, rating')
    .in('event_id', eventIds);

  if (error) return {};

  const buckets: Record<string, number[]> = {};
  for (const row of (data ?? []) as { event_id: string; rating: number }[]) {
    (buckets[row.event_id] ??= []).push(row.rating);
  }

  return Object.fromEntries(
    Object.entries(buckets).map(([id, values]) => [
      id,
      { count: values.length, average: values.reduce((a, b) => a + b, 0) / values.length },
    ]),
  );
}

export async function createPost(input: {
  body: string;
  communityId?: string | null;
  eventId?: string | null;
  imageUrl?: string | null;
}): Promise<CommunityPost> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const { data, error } = await supabase
    .from('posts')
    .insert({
      author_id: userId,
      body: input.body.trim(),
      community_id: input.communityId ?? null,
      event_id: input.eventId ?? null,
      image_url: input.imageUrl ?? null,
    })
    .select()
    .single();

  if (error) throw error;
  return data as CommunityPost;
}

export async function togglePostLike(postId: string, liked: boolean): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  if (liked) {
    const { error } = await supabase
      .from('post_likes')
      .delete()
      .eq('post_id', postId)
      .eq('user_id', userId);
    if (error) throw error;
    return;
  }

  const { error } = await supabase
    .from('post_likes')
    .insert({ post_id: postId, user_id: userId });

  if (error && error.code !== '23505') throw error;
}

export async function deletePost(postId: string): Promise<void> {
  const { error } = await supabase
    .from('posts')
    .update({ is_deleted: true })
    .eq('id', postId);

  if (error) throw error;
}
