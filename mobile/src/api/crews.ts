import { supabase } from '@/lib/supabase';
import type { Profile } from '@/types/models';

/**
 * Event crews — the concept document's "spoločné plány": small groups that
 * travel to an event together. A crew belongs to one event, has a size cap, and
 * its creator is added as the first member by a database trigger.
 */

export interface Crew {
  id: string;
  event_id: string;
  name: string;
  description: string | null;
  created_by: string;
  max_size: number;
  is_open: boolean;
  created_at: string;
  members?: {
    user_id: string;
    profile?: Pick<Profile, 'id' | 'display_name' | 'username' | 'avatar_url'> | null;
  }[];
  member_count?: number;
  joined?: boolean;
}

export async function getEventCrews(eventId: string): Promise<Crew[]> {
  const { data, error } = await supabase
    .from('event_crews')
    .select(
      `*, members:event_crew_members (
         user_id,
         profile:profiles (id, display_name, username, avatar_url)
       )`,
    )
    .eq('event_id', eventId)
    .order('created_at', { ascending: true });

  if (error) throw error;

  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;

  return ((data ?? []) as unknown as Crew[]).map((crew) => ({
    ...crew,
    member_count: crew.members?.length ?? 0,
    joined: Boolean(userId && crew.members?.some((member) => member.user_id === userId)),
  }));
}

export async function createCrew(input: {
  eventId: string;
  name: string;
  description?: string | null;
  maxSize?: number;
}): Promise<Crew> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const { data, error } = await supabase
    .from('event_crews')
    .insert({
      event_id: input.eventId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      max_size: input.maxSize ?? 8,
      created_by: userId,
    })
    .select()
    .single();

  if (error) throw error;
  return data as Crew;
}

export async function joinCrew(crewId: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const { error } = await supabase
    .from('event_crew_members')
    .insert({ crew_id: crewId, user_id: userId });

  if (error && error.code !== '23505') throw error;
}

export async function leaveCrew(crewId: string): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const { error } = await supabase
    .from('event_crew_members')
    .delete()
    .eq('crew_id', crewId)
    .eq('user_id', userId);

  if (error) throw error;
}
