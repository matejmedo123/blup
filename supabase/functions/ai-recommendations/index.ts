/**
 * POST /functions/v1/ai-recommendations
 *
 * Returns ranked events for the current user with an explanation for each one.
 *
 * The ranking is the deterministic SQL ranker (works with zero API keys). The
 * LLM only writes the one-line "why", and only for premium users — free users
 * get the same ranking with a locally generated explanation. Every run is
 * persisted so the debug screen shows the exact scores that were served.
 *
 * Body: { lat?, lon?, radius_m?, limit?, context? }
 */
import {
  adminClient, errorResponse, handleOptions, json, rateLimit, readJson, requireUser,
} from '../_shared/http.ts';
import { aiConfigured, aiProvider, explainLocally } from '../_shared/ai.ts';

interface RecommendationRequest {
  lat?: number;
  lon?: number;
  radius_m?: number;
  limit?: number;
  context?: string;
}

interface ScoredEvent {
  id: string;
  title: string;
  category: string;
  start_at: string;
  distance_m: number | null;
  friends_going: number;
  score: number;
  score_breakdown: {
    components: Record<string, number>;
    facts: Record<string, unknown>;
  };
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const user = await requireUser(req);
    rateLimit(`ai-rec:${user.id}`, 30, 60_000);

    const body = await readJson<RecommendationRequest>(req);
    const limit = Math.min(Math.max(Number(body.limit ?? 20), 1), 50);
    const db = adminClient();
    const started = Date.now();

    const { data: events, error } = await db.rpc('recommend_events', {
      p_user_id: user.id,
      p_lat: body.lat ?? null,
      p_lon: body.lon ?? null,
      p_radius_m: body.radius_m ?? 50000,
      p_limit: limit,
      p_offset: 0,
    });

    if (error) throw error;

    const ranked = (events ?? []) as ScoredEvent[];

    // Zero state is a real, expected answer — not an error.
    if (ranked.length === 0) {
      return json({
        events: [],
        engine: 'sql_ranker_v1',
        explanations_by: 'none',
        empty_reason: 'NO_EVENTS_MATCH',
      });
    }

    const { data: premium } = await db.rpc('is_premium', { uid: user.id });
    const usellm = Boolean(premium) && aiConfigured();

    let explanations: Record<string, string> = {};
    let explanationSource = 'local_template';

    // Local, deterministic explanation for everyone as the baseline.
    for (const event of ranked) {
      explanations[event.id] = explainLocally(event.score_breakdown);
    }

    if (usellm) {
      try {
        const provider = aiProvider();
        const summary = ranked.slice(0, 10).map((event) => ({
          id: event.id,
          title: event.title,
          category: event.category,
          starts: event.start_at,
          distance_km: event.distance_m ? Number((event.distance_m / 1000).toFixed(1)) : null,
          friends_going: event.friends_going,
          signals: event.score_breakdown.components,
        }));

        const result = await provider.complete({
          system:
            'You write one-line reasons why an event was recommended in a social discovery app. ' +
            'Use only the supplied signals, never invent facts. Max 14 words, no emoji, no marketing fluff. ' +
            'Reply with a JSON object mapping event id to the sentence, nothing else.',
          messages: [{ role: 'user', content: JSON.stringify(summary) }],
          maxTokens: 700,
        });

        const parsed = JSON.parse(
          result.text.slice(result.text.indexOf('{'), result.text.lastIndexOf('}') + 1),
        ) as Record<string, string>;

        explanations = { ...explanations, ...parsed };
        explanationSource = `${result.provider}:${result.model}`;

        await db.from('ai_requests').insert({
          user_id: user.id,
          kind: 'recommendation_explanations',
          provider: result.provider,
          model: result.model,
          tokens_in: result.tokensIn,
          tokens_out: result.tokensOut,
          latency_ms: result.latencyMs,
        });
      } catch (aiError) {
        // The LLM is an enhancement: never fail the feed because of it.
        await db.from('ai_requests').insert({
          user_id: user.id,
          kind: 'recommendation_explanations',
          error: aiError instanceof Error ? aiError.message : String(aiError),
        });
      }
    }

    // Persist what was actually served (spec §39).
    await db.rpc('log_recommendation_run', {
      p_context: body.context ?? 'for_you',
      p_params: {
        lat: body.lat ?? null,
        lon: body.lon ?? null,
        radius_m: body.radius_m ?? 50000,
        limit,
        explanations_by: explanationSource,
      },
      p_items: ranked.map((event, index) => ({
        event_id: event.id,
        rank: index + 1,
        score: event.score,
        breakdown: event.score_breakdown,
      })),
    });

    return json({
      events: ranked.map((event) => ({ ...event, explanation: explanations[event.id] })),
      engine: 'sql_ranker_v1',
      explanations_by: explanationSource,
      premium: Boolean(premium),
      latency_ms: Date.now() - started,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
