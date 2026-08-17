/**
 * POST /functions/v1/organizer-connect
 *
 * Stripe Connect onboarding for organizers (KYC). Creates an Express account on
 * first call and returns a hosted onboarding link; on later calls it refreshes
 * the account status so `payouts_enabled` reflects reality.
 *
 * Body: { organization_id: string, action?: "onboard" | "refresh" }
 */
import {
  ApiError, adminClient, errorResponse, handleOptions, json, rateLimit, readJson, requireUser,
} from '../_shared/http.ts';
import { stripe } from '../_shared/stripe.ts';

interface ConnectRequest {
  organization_id: string;
  action?: 'onboard' | 'refresh';
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const user = await requireUser(req);
    rateLimit(`connect:${user.id}`, 20, 60_000);

    const body = await readJson<ConnectRequest>(req);
    if (!body.organization_id) {
      throw new ApiError('INVALID_BODY', 'organization_id is required');
    }

    const db = adminClient();

    // Only an owner/admin of the organization may touch payout onboarding.
    const { data: membership } = await db
      .from('organization_members')
      .select('role')
      .eq('organization_id', body.organization_id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new ApiError('NOT_AUTHORIZED', 'Only organization owners can set up payouts', 403);
    }

    const { data: org, error: orgError } = await db
      .from('organizations')
      .select('id, name, contact_email, country, stripe_account_id, verification_status')
      .eq('id', body.organization_id)
      .single();

    if (orgError || !org) {
      throw new ApiError('ORGANIZATION_NOT_FOUND', 'Organization not found', 404);
    }

    if (org.verification_status !== 'verified') {
      throw new ApiError(
        'ORGANIZATION_NOT_VERIFIED',
        'Your organization must be verified by BLUP before payout onboarding',
        403,
      );
    }

    let accountId = org.stripe_account_id;

    if (!accountId) {
      const account = await stripe.createConnectedAccount({
        email: org.contact_email ?? user.email,
        country: org.country ?? 'SK',
        organizationId: org.id,
      });
      accountId = account.id;

      await db.from('organizations').update({ stripe_account_id: accountId }).eq('id', org.id);
    }

    // Always re-read the live capability flags from Stripe.
    const account = await stripe.retrieveAccount(accountId);

    await db
      .from('organizations')
      .update({
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled,
      })
      .eq('id', org.id);

    if (body.action === 'refresh') {
      return json({
        account_id: accountId,
        charges_enabled: account.charges_enabled,
        payouts_enabled: account.payouts_enabled,
        details_submitted: account.details_submitted,
        requirements_due: account.requirements?.currently_due ?? [],
      });
    }

    const link = await stripe.createAccountLink(accountId);

    return json({
      account_id: accountId,
      onboarding_url: link.url,
      expires_at: link.expires_at,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      details_submitted: account.details_submitted,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
