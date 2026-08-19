/**
 * POST /functions/v1/stripe-webhook
 *
 * The ONLY place where a ticket comes into existence for a paid order. The
 * mobile app saying "payment successful" is never trusted — the money is
 * confirmed here, against a signed Stripe event, and only then does
 * fulfill_order() issue tickets and write the ledger.
 *
 * Deploy with JWT verification disabled (Stripe cannot send a Supabase JWT):
 *   supabase functions deploy stripe-webhook --no-verify-jwt
 * The signature check below is what authenticates the request.
 */
import { adminClient, errorResponse, json } from '../_shared/http.ts';
import { stripe, verifyStripeSignature } from '../_shared/stripe.ts';
import { env } from '../_shared/env.ts';

/**
 * Writes a Stripe subscription into premium_subscriptions.
 *
 * Both platforms land in the same table, keyed by (platform, original
 * transaction) — so an Apple subscription and a Stripe one are two rows and
 * is_premium() sees whichever is still active. Nobody is charged twice, and
 * somebody who subscribes on the web keeps Premium when they install the app.
 *
 * `cancel_at_period_end` is deliberately still `active`: the person paid for
 * the rest of the period and should keep what they paid for until it runs out.
 */
async function syncSubscription(
  db: ReturnType<typeof adminClient>,
  subscriptionId: string,
  userId: string,
  known?: Record<string, unknown>,
): Promise<void> {
  const subscription = known?.id === subscriptionId
    ? (known as unknown as Awaited<ReturnType<typeof stripe.retrieveSubscription>>)
    : await stripe.retrieveSubscription(subscriptionId);

  const STATUS: Record<string, string> = {
    active: 'active',
    trialing: 'trialing',
    past_due: 'grace_period',
    unpaid: 'grace_period',
    incomplete: 'grace_period',
    canceled: 'cancelled',
    incomplete_expired: 'expired',
    paused: 'expired',
  };

  const priceId = subscription.items?.data?.[0]?.price?.id ?? 'premium';
  const periodEnd = Number(subscription.current_period_end ?? 0);

  const { error } = await db.rpc('upsert_premium_subscription', {
    p_user_id: userId,
    p_platform: 'stripe',
    p_product_id: priceId,
    p_status: STATUS[subscription.status] ?? 'expired',
    p_original_tx: subscription.id,
    p_latest_tx: subscription.id,
    p_purchased_at: new Date(Number(subscription.start_date ?? 0) * 1000).toISOString(),
    p_expires_at: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    p_auto_renew: !subscription.cancel_at_period_end,
    p_environment: 'production',
    p_raw: subscription as unknown as Record<string, unknown>,
  });

  if (error) throw error;
}

/**
 * Fire-and-forget call to the ticket-email function. Failure here is not
 * failure of the webhook: the delivery row is already committed, so the cron
 * sweep picks it up on the next pass.
 */
async function triggerTicketEmail(): Promise<void> {
  try {
    await fetch(`${env.supabaseUrl()}/functions/v1/ticket-email`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.serviceRoleKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ limit: 25 }),
    });
  } catch (error) {
    console.error('ticket-email nudge failed, cron will retry:', error);
  }
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

Deno.serve(async (req) => {
  try {
    const payload = await req.text();
    await verifyStripeSignature(payload, req.headers.get('stripe-signature'));

    const event = JSON.parse(payload) as StripeEvent;
    const db = adminClient();

    // Idempotency: Stripe retries. The unique (provider, event_id) index means
    // a replay is recorded once and skipped on every later delivery.
    const { error: insertError } = await db.from('webhook_events').insert({
      provider: 'stripe',
      event_id: event.id,
      type: event.type,
      payload: event as unknown as Record<string, unknown>,
    });

    if (insertError) {
      if (insertError.code === '23505') {
        return json({ received: true, duplicate: true });
      }
      throw insertError;
    }

    const object = event.data.object;
    const metadata = (object.metadata ?? {}) as Record<string, string>;
    const orderId = metadata.order_id;
    const boostId = metadata.boost_id;

    switch (event.type) {
      case 'payment_intent.succeeded': {
        // A boost is bought with the same intent flow as a ticket; the metadata
        // says which, and only the webhook activates either one.
        if (boostId) {
          const { error } = await db.rpc('activate_boost', {
            p_boost_id: boostId,
            p_provider: 'stripe',
            p_provider_reference: String(object.id),
            p_amount_cents: Number(object.amount_received ?? object.amount),
          });
          if (error) throw error;
          break;
        }

        if (!orderId) break;
        const { error } = await db.rpc('fulfill_order', {
          p_order_id: orderId,
          p_provider: 'stripe',
          p_provider_reference: String(object.id),
          p_amount_cents: Number(object.amount_received ?? object.amount),
        });
        if (error) throw error;

        // fulfill_order queued the ticket email inside its transaction; nudge
        // the sender so it goes out in seconds rather than waiting for cron.
        // Deliberately not awaited into the webhook's result: Stripe must get
        // its 200 even if the mail provider is having a bad afternoon, and the
        // queue survives either way.
        void triggerTicketEmail();
        break;
      }

      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled': {
        const failure = (object.last_payment_error ?? {}) as Record<string, string>;

        if (boostId) {
          await db.rpc('fail_boost', {
            p_boost_id: boostId,
            p_reason: failure.message ?? event.type,
          });
          break;
        }

        if (!orderId) break;
        await db.rpc('fail_order', {
          p_order_id: orderId,
          p_reason: failure.message ?? event.type,
        });
        break;
      }

      // --- web subscriptions (Premium sold outside the App Store) ----------
      // A Checkout session in payment mode also fires payment_intent.succeeded,
      // which the case above already handles; only the subscription mode needs
      // anything here.
      case 'checkout.session.completed': {
        if (object.mode !== 'subscription') break;

        const subscriptionId = String(object.subscription ?? '');
        const customerId = String(object.customer ?? '');
        if (!subscriptionId || !customerId) break;

        // The session's client_reference_id is the user id we set when the
        // session was created; the customer mapping is the fallback for a
        // subscription that was changed from Stripe's own dashboard.
        const userId = String(object.client_reference_id ?? '') ||
          (await db.rpc('user_for_stripe_customer', { p_customer: customerId })).data;
        if (!userId) break;

        await db.rpc('link_stripe_customer', { p_user_id: userId, p_customer: customerId });
        await syncSubscription(db, subscriptionId, String(userId));
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const customerId = String(object.customer ?? '');
        if (!customerId) break;

        const metadataUser = metadata.user_id;
        const { data: mappedUser } = await db.rpc('user_for_stripe_customer', { p_customer: customerId });
        const userId = metadataUser || mappedUser;
        if (!userId) break;

        await syncSubscription(db, String(object.id), String(userId), object);
        break;
      }

      case 'charge.refunded': {
        // Refunds arrive on the charge; map back to the order via the intent.
        const paymentIntentId = String(object.payment_intent ?? '');
        if (!paymentIntentId) break;

        const { data: order } = await db
          .from('orders')
          .select('id')
          .eq('provider_reference', paymentIntentId)
          .maybeSingle();

        if (order) {
          await db.rpc('refund_order', { p_order_id: order.id, p_reason: 'Stripe refund' });
        }
        break;
      }

      case 'account.updated': {
        // Connect onboarding progress → organizer payout capability.
        const accountId = String(object.id);
        await db
          .from('organizations')
          .update({
            charges_enabled: Boolean(object.charges_enabled),
            payouts_enabled: Boolean(object.payouts_enabled),
          })
          .eq('stripe_account_id', accountId);
        break;
      }

      case 'transfer.created':
      case 'transfer.paid': {
        const payoutId = metadata.payout_id;
        if (!payoutId) break;
        await db
          .from('payouts')
          .update({
            status: event.type === 'transfer.paid' ? 'paid' : 'processing',
            provider_transfer_id: String(object.id),
            processed_at: event.type === 'transfer.paid' ? new Date().toISOString() : null,
          })
          .eq('id', payoutId);
        break;
      }

      default:
        // Unhandled types are still recorded in webhook_events for audit.
        break;
    }

    await db
      .from('webhook_events')
      .update({ processed_at: new Date().toISOString() })
      .eq('provider', 'stripe')
      .eq('event_id', event.id);

    return json({ received: true });
  } catch (error) {
    // Record the failure so a webhook can be replayed from the Stripe dashboard.
    try {
      const db = adminClient();
      await db
        .from('webhook_events')
        .update({ error: error instanceof Error ? error.message : String(error) })
        .eq('provider', 'stripe')
        .is('processed_at', null);
    } catch { /* best effort */ }

    return errorResponse(error);
  }
});
