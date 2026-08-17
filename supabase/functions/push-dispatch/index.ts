/**
 * POST /functions/v1/push-dispatch
 *
 * Delivers unsent notifications as Expo push messages. Designed to be called by
 * a Supabase scheduled job (pg_cron / Supabase Cron) every minute:
 *
 *   select cron.schedule('blup-push', '* * * * *', $$
 *     select net.http_post(
 *       url := 'https://<project>.functions.supabase.co/push-dispatch',
 *       headers := '{"Authorization": "Bearer <service-role-key>"}'::jsonb
 *     );
 *   $$);
 *
 * Requires the service-role key (it reads other users' notifications), so it
 * refuses any other caller.
 */
import { ApiError, adminClient, errorResponse, handleOptions, json } from '../_shared/http.ts';
import { env } from '../_shared/env.ts';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 100;

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    // Only the service role may run a fan-out over every user's notifications.
    const auth = req.headers.get('Authorization');
    if (auth !== `Bearer ${env.serviceRoleKey()}`) {
      throw new ApiError('NOT_AUTHORIZED', 'Service role key required', 403);
    }

    const db = adminClient();

    const { data: pending, error } = await db
      .from('notifications')
      .select('id, user_id, type, title, body, data, event_id')
      .is('pushed_at', null)
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error) throw error;
    if (!pending || pending.length === 0) {
      return json({ sent: 0, message: 'Nothing to deliver' });
    }

    const userIds = [...new Set(pending.map((n) => n.user_id))];

    const [{ data: tokens }, { data: preferences }] = await Promise.all([
      db.from('push_tokens').select('user_id, token').in('user_id', userIds),
      db.from('notification_preferences').select('*').in('user_id', userIds),
    ]);

    const tokensByUser = new Map<string, string[]>();
    for (const row of tokens ?? []) {
      tokensByUser.set(row.user_id, [...(tokensByUser.get(row.user_id) ?? []), row.token]);
    }

    const prefsByUser = new Map(
      (preferences ?? []).map((p) => [p.user_id, p as Record<string, boolean>]),
    );

    /** Maps a notification type to the preference switch that controls it. */
    const preferenceKey: Record<string, string> = {
      new_follower: 'new_follower',
      friend_request: 'friend_requests',
      friend_accepted: 'friend_requests',
      event_reminder: 'event_reminders',
      event_starting_soon: 'event_reminders',
      friend_attending: 'friend_attending',
      ticket_purchased: 'ticket_updates',
      ticket_confirmed: 'ticket_updates',
      payout_update: 'ticket_updates',
      weekly_recommendations: 'weekly_recommendations',
    };

    const messages: Array<Record<string, unknown>> = [];
    const dispatched: string[] = [];
    const skipped: string[] = [];

    for (const notification of pending) {
      const prefs = prefsByUser.get(notification.user_id);
      const key = preferenceKey[notification.type];

      // Default is opt-in; an explicit false switches the channel off.
      const allowed =
        !prefs || (prefs.push_enabled !== false && (!key || prefs[key] !== false));
      const userTokens = tokensByUser.get(notification.user_id) ?? [];

      if (!allowed || userTokens.length === 0) {
        skipped.push(notification.id);
        continue;
      }

      for (const token of userTokens) {
        messages.push({
          to: token,
          title: notification.title,
          body: notification.body ?? '',
          sound: 'default',
          channelId: 'default',
          data: {
            notification_id: notification.id,
            type: notification.type,
            event_id: notification.event_id,
            ...(notification.data as Record<string, unknown>),
          },
        });
      }

      dispatched.push(notification.id);
    }

    let tickets: ExpoTicket[] = [];

    if (messages.length > 0) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      const expoToken = env.expoAccessToken();
      if (expoToken) headers.Authorization = `Bearer ${expoToken}`;

      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(messages),
      });

      const payload = await response.json();
      tickets = (payload.data ?? []) as ExpoTicket[];

      // Expo tells us when a device token is dead — drop it so we stop retrying.
      const deadTokens = tickets
        .map((ticket, index) => ({ ticket, token: messages[index]?.to as string }))
        .filter(({ ticket }) => ticket.details?.error === 'DeviceNotRegistered')
        .map(({ token }) => token);

      if (deadTokens.length > 0) {
        await db.from('push_tokens').delete().in('token', deadTokens);
      }
    }

    // Mark everything we processed, so a delivery is attempted exactly once.
    const processed = [...dispatched, ...skipped];
    if (processed.length > 0) {
      await db
        .from('notifications')
        .update({ pushed_at: new Date().toISOString() })
        .in('id', processed);
    }

    return json({
      sent: dispatched.length,
      skipped: skipped.length,
      messages: messages.length,
      errors: tickets.filter((t) => t.status === 'error').length,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
