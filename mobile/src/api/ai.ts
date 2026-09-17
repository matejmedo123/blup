import { callFunction, supabase } from '@/lib/supabase';
import type { Coordinates, EventFeedItem, PeopleMatch, ScoreBreakdown } from '@/types/models';

/**
 * AI / discovery API.
 *
 * Two layers, on purpose:
 *  1. `recommend_events` — a deterministic SQL ranker that works with no API key
 *     at all. This is what actually orders the feed.
 *  2. `ai-recommendations` — the Edge Function that adds a natural-language
 *     "why" on top (LLM for premium users, template otherwise) and logs the run.
 *
 * If the Edge Function is unreachable we fall back to layer 1, so discovery
 * never goes dark because of an external provider.
 */

export interface RecommendationResponse {
  events: (EventFeedItem & { explanation?: string })[];
  engine: string;
  explanations_by: string;
  premium?: boolean;
  empty_reason?: string;
}

export async function getAIRecommendations(params: {
  coords?: Coordinates | null;
  radiusM?: number;
  limit?: number;
  context?: string;
}): Promise<RecommendationResponse> {
  try {
    return await callFunction<RecommendationResponse>('ai-recommendations', {
      lat: params.coords?.latitude ?? null,
      lon: params.coords?.longitude ?? null,
      radius_m: params.radiusM ?? 50000,
      limit: params.limit ?? 20,
      context: params.context ?? 'for_you',
    });
  } catch (error) {
    if (__DEV__) console.warn('ai-recommendations unavailable, using SQL ranker:', error);

    const events = await getRankedEvents(params);
    return { events, engine: 'sql_ranker_v1', explanations_by: 'fallback_direct_rpc' };
  }
}

/** Direct call to the ranker — used by the fallback path and the debug screen. */
export async function getRankedEvents(params: {
  coords?: Coordinates | null;
  radiusM?: number;
  limit?: number;
  offset?: number;
}): Promise<EventFeedItem[]> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;

  // A guest has no history to rank against, and used to get an empty section
  // for it. What is on near you, soon, that people are going to is not a
  // personal recommendation — but it is a real answer, and it is what the
  // section is for.
  if (!userId) {
    const { data, error } = await supabase.rpc('discover_events', {
      p_lat: params.coords?.latitude ?? null,
      p_lon: params.coords?.longitude ?? null,
      p_radius_m: params.radiusM ?? 50000,
      p_limit: params.limit ?? 12,
    });
    if (error) throw error;
    return (data ?? []) as EventFeedItem[];
  }

  const { data, error } = await supabase.rpc('recommend_events', {
    p_user_id: userId,
    p_lat: params.coords?.latitude ?? null,
    p_lon: params.coords?.longitude ?? null,
    p_radius_m: params.radiusM ?? 50000,
    p_limit: params.limit ?? 30,
    p_offset: params.offset ?? 0,
  });

  if (error) throw error;
  return (data ?? []) as EventFeedItem[];
}

/** "People like you" — shared interests, mutual events and mutual follows. */
export async function getPeopleRecommendations(params: {
  eventId?: string | null;
  limit?: number;
} = {}): Promise<PeopleMatch[]> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return [];

  const { data, error } = await supabase.rpc('recommend_people', {
    p_user_id: userId,
    p_event_id: params.eventId ?? null,
    p_limit: params.limit ?? 20,
  });

  if (error) throw error;
  return (data ?? []) as PeopleMatch[];
}

/**
 * Why this person, in the words somebody would actually use.
 *
 * Ordered by how much the evidence is worth, which is the same order the ranker
 * uses: somebody who already follows you, then a community you are both in,
 * then the people you both know. Shared interests come last on purpose —
 * "you both like techno" is true of forty thousand people in one city, and
 * leading with it is what made the old suggestions feel random.
 *
 * Never more than two reasons: a card that lists five is a card nobody reads.
 */
export function describeMatch(match: PeopleMatch): string {
  const facts = match.score_breakdown?.facts ?? {};
  const communities = facts.shared_community_names ?? [];
  const parts: string[] = [];

  if (facts.follows_me) parts.push('Sleduje ťa');
  if (communities.length > 0) {
    parts.push(
      communities.length === 1
        ? `Obaja ste v ${communities[0]}`
        : `${communities.length} spoločné komunity`,
    );
  }
  if ((facts.shared_crews ?? 0) > 0) parts.push('Boli ste v jednej partii');
  if (match.mutual_follows > 0) {
    parts.push(
      match.mutual_follows === 1
        ? '1 spoločný známy'
        : `${match.mutual_follows} spoločných známych`,
    );
  }
  if (match.same_event) parts.push('Idete obaja');
  if (match.mutual_events > 0) {
    parts.push(
      match.mutual_events === 1 ? '1 spoločný event' : `${match.mutual_events} spoločných eventov`,
    );
  }
  if (match.shared_interests > 0) {
    parts.push(
      match.shared_interests === 1
        ? '1 spoločný záujem'
        : `${match.shared_interests} ${match.shared_interests < 5 ? 'spoločné záujmy' : 'spoločných záujmov'}`,
    );
  }

  // No fallback sentence. The ranker no longer returns people with nothing in
  // common, so "Návrh pre teba" would only ever have been a way of saying
  // "we do not know either".
  return parts.slice(0, 2).join(' · ');
}

/** Somebody you were suggested and passed on stops being suggested. */
export async function dismissPerson(userId: string): Promise<void> {
  const { error } = await supabase.rpc('dismiss_person', { p_user_id: userId });
  if (error) throw error;
}

/**
 * People you may know, inside one community.
 *
 * Members only — the database refuses a non-member outright rather than
 * returning an empty list, because a private community's roll is not a
 * directory.
 */
export interface CommunityPerson {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  mutual_follows: number;
  mutual_events: number;
  role: string;
  reason: 'follows_you' | 'together' | 'community';
}

export async function getCommunityPeople(
  communityId: string,
  limit = 12,
): Promise<CommunityPerson[]> {
  const { data, error } = await supabase.rpc('community_people_you_may_know', {
    p_community_id: communityId,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as CommunityPerson[];
}

export function describeCommunityPerson(person: CommunityPerson): string {
  if (person.reason === 'follows_you') return 'Sleduje ťa';
  if (person.mutual_follows > 0) {
    return person.mutual_follows === 1
      ? '1 spoločný známy'
      : `${person.mutual_follows} spoločných známych`;
  }
  if (person.mutual_events > 0) {
    return person.mutual_events === 1 ? 'Boli ste na tom istom evente' : 'Viackrát ste sa minuli';
  }
  return 'V tej istej komunite';
}

// --- debug / observability (spec §39) ---------------------------------------

export interface RecommendationRun {
  id: string;
  context: string;
  params: Record<string, unknown>;
  engine: string;
  created_at: string;
}

export interface RecommendationRunItem {
  event_id: string;
  rank: number;
  score: number;
  breakdown: ScoreBreakdown;
  event: { id: string; title: string; category: string } | null;
}

export async function getRecentRecommendationRuns(limit = 10): Promise<RecommendationRun[]> {
  const { data, error } = await supabase
    .from('ai_recommendation_runs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as RecommendationRun[];
}

export async function getRecommendationRunItems(runId: string): Promise<RecommendationRunItem[]> {
  const { data, error } = await supabase
    .from('ai_recommendation_items')
    .select('event_id, rank, score, breakdown, event:events (id, title, category)')
    .eq('run_id', runId)
    .order('rank', { ascending: true });

  if (error) throw error;
  return (data ?? []) as unknown as RecommendationRunItem[];
}

/** Ordered component list for the "why was this recommended?" panel. */
export function explainBreakdown(
  breakdown: ScoreBreakdown | null,
): { label: string; value: number; weight: number; contribution: number }[] {
  if (!breakdown?.components) return [];

  const labels: Record<string, string> = {
    interest_match: 'Zhoda záujmov',
    distance_score: 'Vzdialenosť',
    social_relevance: 'Sociálna relevancia',
    past_behaviour: 'Tvoje správanie',
    popularity: 'Popularita',
    time_relevance: 'Časová relevancia',
  };

  return Object.entries(breakdown.components)
    .map(([key, value]) => {
      const weight = breakdown.weights?.[key] ?? 0;
      return {
        label: labels[key] ?? key,
        value: Number(value),
        weight,
        contribution: Number(value) * weight,
      };
    })
    .sort((a, b) => b.contribution - a.contribution);
}
