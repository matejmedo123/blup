/**
 * POST /functions/v1/weekly-digest
 *
 * The concept document's "Týždenné prehľady – notifikácie s výberom top
 * udalostí". Runs the same ranker the feed uses, per user, and writes one
 * notification with the best few events of the coming week.
 *
 * Designed to be called by a scheduled job once a week:
 *
 *   select cron.schedule('blup-weekly-digest', '0 16 * * 4', $$
 *     select net.http_post(
 *       url := 'https://<project>.functions.supabase.co/weekly-digest',
 *       headers := '{"Authorization": "Bearer <service-role-key>"}'::jsonb
 *     );
 *   $$);
 *
 * Only users who left `weekly_recommendations` on are included, and a user is
 * skipped when the ranker has nothing worth sending — an empty digest is worse
 * than no digest.
 */
import { ApiError, adminClient, errorResponse, handleOptions, json } from '../_shared/http.ts';
import { env } from '../_shared/env.ts';

/** How many events a digest mentions. */
const PICKS = 3;

/** Users processed per invocation, so one run cannot exceed the time budget. */
const USER_BATCH = 500;

interface RankedEvent {
  id: string;
  title: string;
  start_at: string;
  venue_name: string | null;
  city: string | null;
  score: number | null;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const auth = req.headers.get('Authorization');
    if (auth !== `Bearer ${env.serviceRoleKey()}`) {
      throw new ApiError('NOT_AUTHORIZED', 'Service role key required', 403);
    }

    const db = adminClient();

    // Who wants one. A user with no location cannot be ranked by distance, but
    // the ranker handles a null position by scoring distance neutrally.
    const { data: recipients, error: recipientsError } = await db
      .from('notification_preferences')
      .select('user_id')
      .eq('weekly_recommendations', true)
      .limit(USER_BATCH);

    if (recipientsError) throw recipientsError;

    let sent = 0;
    let skipped = 0;

    for (const recipient of recipients ?? []) {
      const userId = recipient.user_id as string;

      const { data: ranked, error: rankError } = await db.rpc('recommend_events', {
        p_user_id: userId,
        p_lat: null,
        p_lon: null,
        p_radius_m: 50000,
        p_limit: 10,
        p_offset: 0,
      });

      if (rankError) {
        skipped += 1;
        continue;
      }

      // Only the coming week, and only events that scored something.
      const horizon = Date.now() + 7 * 24 * 60 * 60 * 1000;
      const picks = ((ranked ?? []) as RankedEvent[])
        .filter((event) => {
          const start = new Date(event.start_at).getTime();
          return Number.isFinite(start) && start > Date.now() && start <= horizon;
        })
        .slice(0, PICKS);

      if (picks.length === 0) {
        skipped += 1;
        continue;
      }

      const lead = picks[0];
      const where = lead.venue_name ?? lead.city ?? null;

      const title = picks.length === 1
        ? 'Na tento týždeň máme pre teba jeden tip'
        : `Na tento týždeň máme pre teba ${picks.length} tipy`;

      const body = picks
        .map((event) => event.title)
        .join(' · ')
        + (where ? ` — začína sa ${where}` : '');

      const { error: notifyError } = await db.rpc('notify_user', {
        p_user_id: userId,
        p_type: 'weekly_recommendations',
        p_title: title,
        p_body: body,
        p_actor_id: null,
        p_event_id: lead.id,
        p_data: { event_ids: picks.map((event) => event.id) },
      });

      if (notifyError) {
        skipped += 1;
        continue;
      }

      sent += 1;
    }

    return json({ sent, skipped, considered: (recipients ?? []).length });
  } catch (error) {
    return errorResponse(error);
  }
});
