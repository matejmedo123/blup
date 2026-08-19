/**
 * POST /functions/v1/boost-create
 *
 * Buys paid visibility for an event. The client sends only
 * { event_id, package_code } — the price, duration and weight all come from
 * boost_packages via create_boost_order(), so a tampered client cannot buy a
 * week of promotion for the price of a day.
 *
 * The boost is created as `requires_payment` and stays inert: boost_weight_for()
 * counts only `succeeded` rows, so nothing is promoted until the webhook
 * confirms the money moved.
 */
import {
  ApiError, adminClient, errorResponse, handleOptions, json, rateLimit, readJson, requireUser,
} from '../_shared/http.ts';
import { stripe } from '../_shared/stripe.ts';
import { env } from '../_shared/env.ts';

interface BoostRequest {
  event_id: string;
  package_code: string;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    if (req.method !== 'POST') {
      throw new ApiError('METHOD_NOT_ALLOWED', 'Use POST', 405);
    }

    const user = await requireUser(req);
    rateLimit(`boost:${user.id}`, 10, 60_000);

    const body = await readJson<BoostRequest>(req);
    if (!body.event_id || !body.package_code) {
      throw new ApiError('INVALID_BODY', 'event_id and package_code are required');
    }

    if (!env.stripeSecretKey()) {
      throw new ApiError(
        'PAYMENT_PROVIDER_NOT_CONFIGURED',
        'Stripe is not configured on this deployment',
      );
    }

    const db = adminClient();

    // 1. The database prices it and checks that this user may promote the event.
    const { data: boost, error: boostError } = await db
      .rpc('create_boost_order', {
        p_event: body.event_id,
        p_package: body.package_code,
      })
      .single();

    if (boostError || !boost) {
      throw new Error(boostError?.message ?? 'BOOST_CREATION_FAILED');
    }

    // 2. Charge it to BLUP — a boost is our revenue, not the organizer's, so
    //    there is no Connect transfer and no application fee.
    const intent = await stripe.createBoostPaymentIntent({
      amountCents: boost.amount_cents,
      currency: boost.currency,
      boostId: boost.id,
      buyerId: user.id,
      eventId: body.event_id,
      customerEmail: user.email,
    });

    await db
      .from('event_boosts')
      .update({
        provider: 'stripe',
        provider_reference: intent.id,
        payment_status: 'processing',
      })
      .eq('id', boost.id);

    return json({
      boost_id: boost.id,
      status: 'requires_payment',
      requires_payment: true,
      payment_intent_client_secret: intent.client_secret,
      amount_cents: boost.amount_cents,
      currency: boost.currency,
      starts_at: boost.starts_at,
      ends_at: boost.ends_at,
      weight: boost.weight,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
