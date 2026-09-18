/**
 * POST /functions/v1/boost-create
 *
 * Buys paid visibility for an event, in one of two shapes:
 *
 *   { event_id, package_code }                      — one of the three packages
 *   { event_id, budget_cents, days, placements, … } — a campaign you designed
 *
 * Either way the client sends WHAT it wants, never what it costs: the price,
 * the duration, the impression budget and the auction weight are all computed
 * in the database (create_boost_order / create_ad_campaign), so a tampered
 * client cannot buy a week of promotion for the price of a day, and cannot type
 * its own weight into the auction.
 *
 * The boost is created as `requires_payment` and stays inert: boost_weight_for()
 * counts only `succeeded` rows, so nothing is promoted until the webhook
 * confirms the money moved.
 */
import {
  ApiError, adminClient, errorResponse, handleOptions, json, rateLimit, readJson, requireUser,
  userClient,
} from '../_shared/http.ts';
import type { BoostRow } from '../_shared/rows.ts';
import { stripe } from '../_shared/stripe.ts';
import { env } from '../_shared/env.ts';

interface BoostRequest {
  event_id: string;
  /** Package purchase. Mutually exclusive with budget_cents. */
  package_code?: string;
  /** Campaign purchase, in cents. The database enforces the 5 €–5 000 € range. */
  budget_cents?: number;
  days?: number;
  placements?: string[];
  radius_m?: number;
  categories?: string[];
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
    if (!body.event_id) {
      throw new ApiError('INVALID_BODY', 'event_id is required');
    }
    const isCampaign = typeof body.budget_cents === 'number';
    if (!isCampaign && !body.package_code) {
      throw new ApiError('INVALID_BODY', 'package_code or budget_cents is required');
    }

    if (!env.stripeSecretKey()) {
      throw new ApiError(
        'PAYMENT_PROVIDER_NOT_CONFIGURED',
        'Stripe is not configured on this deployment',
      );
    }

    const db = adminClient();

    // 1. The database prices it and checks that this user may promote the
    //    event. create_boost_order() authorizes on auth.uid(), so it has to run
    //    under the caller's own JWT — a service-role call presents as "no user"
    //    and the function refuses it outright.
    const caller = userClient(req);
    const { data: createdBoost, error: boostError } = isCampaign
      ? await caller
        .rpc('create_ad_campaign', {
          p_event: body.event_id,
          p_budget_cents: Math.round(body.budget_cents as number),
          p_days: body.days ?? 7,
          p_placements: body.placements ?? ['feed'],
          p_radius_m: body.radius_m ?? 30000,
          p_categories: body.categories?.length ? body.categories : null,
        })
        .single()
      : await caller
        .rpc('create_boost_order', {
          p_event: body.event_id,
          p_package: body.package_code,
        })
        .single();

    if (boostError || !createdBoost) {
      throw new Error(boostError?.message ?? 'BOOST_CREATION_FAILED');
    }
    const boost = createdBoost as BoostRow;

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
      impression_budget: boost.impression_budget,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
