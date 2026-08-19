/**
 * POST /functions/v1/push-dispatch
 *
 * Delivers unsent notifications: Expo push to phones, Web Push (RFC 8291) to
 * browsers. One notification row can fan out to both — somebody with the app on
 * their phone and Blup open on a laptop should hear about it either way.
 *
 * Designed to be called by a Supabase scheduled job (pg_cron / Supabase Cron)
 * every minute:
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
import { configured, env } from '../_shared/env.ts';
import { sendWebPush, type PushSubscription } from '../_shared/webpush.ts';

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
      db.from('push_tokens').select('user_id, token, platform').in('user_id', userIds),
      db.from('notification_preferences').select('*').in('user_id', userIds),
    ]);

    // Expo tokens and Web Push subscriptions travel to entirely different
    // services, so they are separated here rather than at the send site.
    const expoByUser = new Map<string, string[]>();
    const webByUser = new Map<string, string[]>();

    for (const row of tokens ?? []) {
      const bucket = row.platform === 'web' ? webByUser : expoByUser;
      bucket.set(row.user_id, [...(bucket.get(row.user_id) ?? []), row.token]);
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
    const webSends: Array<{ token: string; payload: string }> = [];
    const dispatched: string[] = [];
    const skipped: string[] = [];

    /** Where a notification should open when its banner is tapped. */
    const linkFor = (n: { type: string; event_id: string | null }) =>
      n.event_id ? `/event/${n.event_id}` : '/activity';

    for (const notification of pending) {
      const prefs = prefsByUser.get(notification.user_id);
      const key = preferenceKey[notification.type];

      // Default is opt-in; an explicit false switches the channel off.
      const allowed =
        !prefs || (prefs.push_enabled !== false && (!key || prefs[key] !== false));
      const userTokens = expoByUser.get(notification.user_id) ?? [];
      const userWebTokens = webByUser.get(notification.user_id) ?? [];

      if (!allowed || (userTokens.length === 0 && userWebTokens.length === 0)) {
        skipped.push(notification.id);
        continue;
      }

      for (const token of userWebTokens) {
        webSends.push({
          token,
          payload: JSON.stringify({
            title: notification.title,
            body: notification.body ?? '',
            url: linkFor(notification),
            // One tag per event means a second reminder replaces the first
            // instead of stacking two banners for the same thing.
            tag: notification.event_id ?? notification.type,
          }),
        });
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

    // --- Web Push --------------------------------------------------------
    // Each subscription is its own HTTPS request to its own push service, so
    // these go out together rather than one after another.
    let webDelivered = 0;
    let webFailed = 0;

    if (webSends.length > 0) {
      if (!configured.webPush()) {
        console.warn('Web Push subscriptions exist but VAPID keys are not configured');
        webFailed = webSends.length;
      } else {
        const vapid = {
          publicKey: env.vapidPublicKey(),
          privateKey: env.vapidPrivateKey(),
          subject: env.vapidSubject(),
        };

        const results = await Promise.all(webSends.map(async ({ token, payload }) => {
          try {
            const subscription = JSON.parse(token) as PushSubscription;
            const result = await sendWebPush(subscription, payload, vapid);
            return { token, ...result };
          } catch (error) {
            return {
              token,
              ok: false,
              status: 0,
              expired: false,
              error: error instanceof Error ? error.message : 'send failed',
            };
          }
        }));

        webDelivered = results.filter((r) => r.ok).length;
        webFailed = results.length - webDelivered;

        // 404/410 means the browser discarded the subscription; the row is
        // dead and retrying it forever only burns quota.
        const dead = results.filter((r) => r.expired).map((r) => r.token);
        if (dead.length > 0) {
          await db.from('push_tokens').delete().in('token', dead);
        }
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
      web: { attempted: webSends.length, delivered: webDelivered, failed: webFailed },
    });
  } catch (error) {
    return errorResponse(error);
  }
});
