/**
 * POST /functions/v1/checkout-create
 *
 * Starts a ticket purchase. The client sends only { ticket_type_id, quantity } —
 * every amount (price, BLUP fee, total) is computed by create_order() in the
 * database, so a tampered client cannot change what it pays.
 *
 * Returns the PaymentIntent client secret for the Stripe PaymentSheet. The order
 * stays `requires_payment` until the webhook confirms the money moved.
 */
import {
  ApiError, adminClient, errorResponse, handleOptions, json, rateLimit, readJson, requireUser,
} from '../_shared/http.ts';
import { stripe } from '../_shared/stripe.ts';

interface CheckoutRequest {
  ticket_type_id: string;
  quantity: number;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    if (req.method !== 'POST') {
      throw new ApiError('METHOD_NOT_ALLOWED', 'Use POST', 405);
    }

    const user = await requireUser(req);
    rateLimit(`checkout:${user.id}`, 10, 60_000);

    const body = await readJson<CheckoutRequest>(req);
    const quantity = Number(body.quantity);

    if (!body.ticket_type_id || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      throw new ApiError('INVALID_BODY', 'ticket_type_id and a quantity of 1–50 are required');
    }

    const db = adminClient();

    // 1. Create the order (validates availability, sales window, capacity, fees).
    const { data: order, error: orderError } = await db
      .rpc('create_order', {
        p_buyer_id: user.id,
        p_ticket_type_id: body.ticket_type_id,
        p_quantity: quantity,
      })
      .single();

    if (orderError || !order) {
      throw new Error(orderError?.message ?? 'ORDER_CREATION_FAILED');
    }

    // 2. Free tickets need no payment provider at all — fulfil immediately.
    if (order.total_cents === 0) {
      const { error: fulfilError } = await db.rpc('fulfill_order', {
        p_order_id: order.id,
        p_provider: 'manual',
        p_provider_reference: `free_${order.id}`,
        p_amount_cents: 0,
      });
      if (fulfilError) throw new Error(fulfilError.message);

      return json({
        order_id: order.id,
        status: 'succeeded',
        requires_payment: false,
        amount_cents: 0,
        currency: order.currency,
      });
    }

    // 3. Paid tickets: hand the organizer's connected account to Stripe so the
    //    BLUP fee is split at the source when Connect onboarding is complete.
    const { data: org } = await db
      .from('organizations')
      .select('stripe_account_id, charges_enabled, country')
      .eq('id', order.organization_id)
      .single();

    const intent = await stripe.createPaymentIntent({
      amountCents: order.total_cents,
      currency: order.currency,
      orderId: order.id,
      buyerId: user.id,
      eventId: order.event_id,
      applicationFeeCents: order.platform_fee_cents,
      connectedAccountId: org?.charges_enabled ? org.stripe_account_id : null,
      customerEmail: user.email,
    });

    await db
      .from('orders')
      .update({
        provider: 'stripe',
        provider_reference: intent.id,
        payment_status: 'processing',
      })
      .eq('id', order.id);

    return json({
      order_id: order.id,
      status: 'requires_payment',
      requires_payment: true,
      payment_intent_client_secret: intent.client_secret,
      publishable_key_required: true,
      amount_cents: order.total_cents,
      platform_fee_cents: order.platform_fee_cents,
      currency: order.currency,
      quantity: order.quantity,
      split_at_source: Boolean(org?.charges_enabled && org?.stripe_account_id),
    });
  } catch (error) {
    return errorResponse(error);
  }
});
