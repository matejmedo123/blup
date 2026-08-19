import { supabase } from '@/lib/supabase';

/**
 * Post-event networking — "koho si mohol stretnúť".
 *
 * People who were at the same finished event as you and whom you do not follow
 * yet. The overlap is computed in SQL from real attendance, so a suggestion
 * always has a concrete reason behind it.
 */

export interface PostEventMatch {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  shared_events: number;
  shared_interests: number;
  shared_interest_names: string[];
  last_event_id: string | null;
  last_event_title: string | null;
  last_event_at: string | null;
}

export async function getPostEventMatches(
  { days = 30, limit = 20 }: { days?: number; limit?: number } = {},
): Promise<PostEventMatch[]> {
  const { data, error } = await supabase.rpc('post_event_matches', {
    p_days: days,
    p_limit: limit,
  });

  if (error) throw error;
  return (data ?? []) as PostEventMatch[];
}

/** The sentence under a suggestion — always states the actual overlap. */
export function describeOverlap(match: PostEventMatch): string {
  const parts: string[] = [];

  if (match.shared_events === 1 && match.last_event_title) {
    parts.push(`Boli ste spolu na ${match.last_event_title}`);
  } else if (match.shared_events > 1) {
    parts.push(`${match.shared_events} spoločné eventy`);
  }

  if (match.shared_interests > 0) {
    parts.push(
      match.shared_interests === 1
        ? '1 spoločný záujem'
        : `${match.shared_interests} ${match.shared_interests < 5 ? 'spoločné záujmy' : 'spoločných záujmov'}`,
    );
  }

  return parts.slice(0, 2).join(' · ') || 'Boli ste na tom istom evente';
}
