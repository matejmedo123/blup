/**
 * POST /functions/v1/payout-request
 *
 * Organizer withdraws their settled balance. The amount is validated against
 * the real ledger by request_payout() (which also debits it), and only then is
 * a Stripe transfer created. If the transfer fails, the payout is marked failed
 * and the money is returned to the balance — no silent losses.
 *
 * Body: { organization_id: string, amount_cents: number }
 */
import {
  ApiError, adminClient, errorResponse, handleOptions, json, rateLimit, readJson, requireUser,
} from '../_shared/http.ts';
import type { PayoutRow } from '../_shared/rows.ts';
import { stripe } from '../_shared/stripe.ts';
import { configured } from '../_shared/env.ts';

interface PayoutRequestBody {
  organization_id: string;
  amount_cents: number;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const user = await requireUser(req);
    rateLimit(`payout:${user.id}`, 5, 60_000);

    const body = await readJson<PayoutRequestBody>(req);
    const amount = Number(body.amount_cents);

    if (!body.organization_id || !Number.isInteger(amount) || amount <= 0) {
      throw new ApiError('INVALID_BODY', 'organization_id and a positive amount_cents are required');
    }

    const db = adminClient();

    // request_payout() enforces role, payouts_enabled and available balance,
    // and writes the negative ledger entry inside one transaction.
    const { data: requested, error } = await db
      .rpc('request_payout', {
        p_organization_id: body.organization_id,
        p_amount_cents: amount,
      })
      .single();

    if (error || !requested) {
      throw new Error(error?.message ?? 'PAYOUT_FAILED');
    }
    const payout = requested as PayoutRow;

    const { data: org } = await db
      .from('organizations')
      .select('stripe_account_id, payouts_enabled')
      .eq('id', body.organization_id)
      .single();

    // No payment provider configured yet: the payout stays pending and an admin
    // can settle it manually. The ledger is already correct either way.
    if (!configured.stripe() || !org?.stripe_account_id) {
      return json({
        payout_id: payout.id,
        status: 'pending',
        amount_cents: payout.amount_cents,
        currency: payout.currency,
        note: !configured.stripe()
          ? 'PAYMENT_PROVIDER_NOT_CONFIGURED: recorded as pending for manual settlement'
          : 'STRIPE_ACCOUNT_MISSING: complete payout onboarding to enable automatic transfers',
      });
    }

    try {
      const transfer = await stripe.createPayout({
        accountId: org.stripe_account_id,
        amountCents: payout.amount_cents,
        currency: payout.currency,
        payoutId: payout.id,
      });

      await db
        .from('payouts')
        .update({ status: 'processing', provider_transfer_id: transfer.id })
        .eq('id', payout.id);

      return json({
        payout_id: payout.id,
        status: 'processing',
        provider_transfer_id: transfer.id,
        amount_cents: payout.amount_cents,
        currency: payout.currency,
      });
    } catch (transferError) {
      // Give the money back: mark_payout_failed writes the reversal entry.
      await db.rpc('mark_payout_failed', {
        p_payout_id: payout.id,
        p_reason: transferError instanceof Error ? transferError.message : 'Transfer failed',
      });
      throw transferError;
    }
  } catch (error) {
    return errorResponse(error);
  }
});
