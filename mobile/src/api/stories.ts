import { supabase } from '@/lib/supabase';

/**
 * Príbehy — 24 hodín.
 *
 * Every read here is already filtered by `expires_at` in the database, so
 * nothing this module returns can be older than a day even if a caller forgets
 * to check. A cron job then removes the rows outright; expiry is not merely
 * hiding.
 */

export interface StoryRing {
  author_id: string;
  organization_id: string | null;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
  story_count: number;
  unseen_count: number;
  latest_at: string;
  is_mine: boolean;
}

export interface Story {
  id: string;
  author_id: string;
  organization_id: string | null;
  image_url: string;
  caption: string | null;
  event_id: string | null;
  event_title: string | null;
  event_slug: string | null;
  created_at: string;
  expires_at: string;
  /** Zero for everybody but the author — watching is not a public act. */
  view_count: number;
  seen_by_me: boolean;
}

export interface StoryViewer {
  viewer_id: string;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
  seen_at: string;
}

/** The row of circles above the feed: unwatched first, yours at the front. */
export async function getStoryRings(limit = 30): Promise<StoryRing[]> {
  const { data, error } = await supabase.rpc('story_rings', { p_limit: limit });
  if (error) throw error;
  return (data ?? []) as StoryRing[];
}

/** One author's live stories, in the order they are watched. */
export async function getStoriesOf(authorId: string): Promise<Story[]> {
  const { data, error } = await supabase.rpc('stories_of', { p_author: authorId });
  if (error) throw error;
  return (data ?? []) as Story[];
}

export async function createStory(params: {
  imageUrl: string;
  caption?: string | null;
  eventId?: string | null;
  /** Post under an organization's name. Checked against membership server-side. */
  organizationId?: string | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc('create_story', {
    p_image_url: params.imageUrl,
    p_caption: params.caption ?? null,
    p_event_id: params.eventId ?? null,
    p_organization: params.organizationId ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function deleteStory(storyId: string): Promise<void> {
  const { error } = await supabase.rpc('delete_story', { p_story: storyId });
  if (error) throw error;
}

/**
 * Marks one as watched.
 *
 * Deliberately swallows its error: a ring that stays coloured because the mark
 * did not land is a cosmetic problem, and it is not worth interrupting somebody
 * mid-story with a red banner about it.
 */
export async function markStorySeen(storyId: string): Promise<void> {
  await supabase.rpc('mark_story_seen', { p_story: storyId });
}

/** Who watched one of mine. The server refuses this for anybody else's story. */
export async function getStoryViewers(storyId: string): Promise<StoryViewer[]> {
  const { data, error } = await supabase.rpc('story_viewers', {
    p_story: storyId,
    p_limit: 100,
  });
  if (error) throw error;
  return (data ?? []) as StoryViewer[];
}
