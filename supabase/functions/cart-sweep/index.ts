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

    return json({ released: data ?? 0, at: new Date().toISOString() });
  } catch (error) {
    return errorResponse(error);
  }
});
