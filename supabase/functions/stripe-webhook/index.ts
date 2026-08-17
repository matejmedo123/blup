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
import { verifyStripeSignature } from '../_shared/stripe.ts';

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

    switch (event.type) {
      case 'payment_intent.succeeded': {
        if (!orderId) break;
        const { error } = await db.rpc('fulfill_order', {
          p_order_id: orderId,
          p_provider: 'stripe',
          p_provider_reference: String(object.id),
          p_amount_cents: Number(object.amount_received ?? object.amount),
        });
        if (error) throw error;
        break;
      }

      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled': {
        if (!orderId) break;
        const failure = (object.last_payment_error ?? {}) as Record<string, string>;
        await db.rpc('fail_order', {
          p_order_id: orderId,
          p_reason: failure.message ?? event.type,
        });
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
