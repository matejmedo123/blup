/**
 * POST /functions/v1/cart-sweep
 *
 * Housekeeping for expired reservations. Run it on a schedule (every minute is
 * fine; every five is plenty):
 *
 *   select cron.schedule('blup-cart-sweep', '* * * * *', $$
 *     select net.http_post(
 *       url     := 'https://<project>.supabase.co/functions/v1/cart-sweep',
 *       headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>')
 *     );
 *   $$);
 *
 * It also marks events that are over as `completed` — see
 * complete_past_events(). That rides along here rather than asking for a second
 * cron entry.
 *
 * Nothing depends on this having run. Availability is computed from live
 * reservations only — an expired basket line stops holding stock the moment it
 * expires, whether or not anyone has deleted it. The sweep exists to keep the
 * tables from growing rows nobody will ever read again, and to move orders that
 * never reached a payment provider into `cancelled` so the organizer's list of
 * pending orders reflects reality.
 */
import { adminClient, errorResponse, json } from '../_shared/http.ts';
import { env } from '../_shared/env.ts';

Deno.serve(async (req) => {
  try {
    // Service-role only: this is a cron target, not a user-facing endpoint.
    const auth = req.headers.get('Authorization') ?? '';
    if (auth !== `Bearer ${env.serviceRoleKey()}`) {
      return json({ error: 'FORBIDDEN' }, 403);
    }

    const db = adminClient();
    const { data, error } = await db.rpc('release_expired_holds');
    if (error) throw error;

    // Riding along on the sweep that already exists rather than asking for a
    // second cron entry. Nothing depends on this having run either — every
    // discovery query filters on the date regardless — but until an event is
    // marked `completed` it keeps behaving like an upcoming one everywhere
    // else, which is how a finished event ended up with a working boost button.
    const { data: completed, error: completeError } = await db.rpc('complete_past_events');
    if (completeError) {
      // Not fatal: releasing expired holds is the job this endpoint exists for.
      console.error('could not complete past events:', completeError.message);
    }

    return json({
      released: data ?? 0,
      completed: completed ?? 0,
      at: new Date().toISOString(),
    });
  } catch (error) {
    return errorResponse(error);
  }
});
