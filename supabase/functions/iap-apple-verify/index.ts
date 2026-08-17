/**
 * POST /functions/v1/iap-apple-verify
 *
 * Server-side verification of an Apple In-App Purchase. The app sends the
 * StoreKit transaction receipt; premium is granted only if APPLE confirms it.
 * The client can never write premium_subscriptions itself (RLS denies it), so
 * this function is the only path to a premium account on iOS.
 *
 * Flow (spec §20):
 *   StoreKit purchase -> receipt -> here -> Apple verifyReceipt
 *     -> upsert_premium_subscription() -> user is premium
 *
 * Body: { receipt: string, product_id?: string }
 */
import {
  ApiError, adminClient, errorResponse, handleOptions, json, rateLimit, readJson, requireUser,
} from '../_shared/http.ts';
import { env } from '../_shared/env.ts';

const PRODUCTION_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';

interface AppleLatestReceipt {
  product_id: string;
  original_transaction_id: string;
  transaction_id: string;
  purchase_date_ms: string;
  expires_date_ms?: string;
  cancellation_date_ms?: string;
  is_trial_period?: string;
  is_in_intro_offer_period?: string;
}

interface AppleVerifyResponse {
  status: number;
  environment?: string;
  receipt?: { bundle_id?: string };
  latest_receipt_info?: AppleLatestReceipt[];
  pending_renewal_info?: Array<{ auto_renew_status?: string; original_transaction_id?: string }>;
}

async function verifyWithApple(receipt: string): Promise<AppleVerifyResponse> {
  const body = JSON.stringify({
    'receipt-data': receipt,
    password: env.appleSharedSecret(),
    'exclude-old-transactions': true,
  });

  const post = async (url: string) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return (await response.json()) as AppleVerifyResponse;
  };

  // Apple's documented flow: always try production first, and retry against
  // sandbox on status 21007 (a sandbox receipt sent to production).
  let result = await post(PRODUCTION_URL);
  if (result.status === 21007) {
    result = await post(SANDBOX_URL);
    result.environment = 'Sandbox';
  }

  return result;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const user = await requireUser(req);
    rateLimit(`iap:${user.id}`, 20, 60_000);

    const body = await readJson<{ receipt: string }>(req);
    if (!body.receipt || typeof body.receipt !== 'string') {
      throw new ApiError('INVALID_BODY', 'receipt is required');
    }

    const result = await verifyWithApple(body.receipt);

    if (result.status !== 0) {
      throw new ApiError(
        'RECEIPT_INVALID',
        `Apple rejected the receipt (status ${result.status})`,
        400,
        { apple_status: result.status },
      );
    }

    // Reject receipts issued for a different app.
    const expectedBundle = env.appleBundleId();
    if (result.receipt?.bundle_id && result.receipt.bundle_id !== expectedBundle) {
      throw new ApiError('BUNDLE_MISMATCH', 'Receipt belongs to a different application', 400);
    }

    const transactions = result.latest_receipt_info ?? [];
    if (transactions.length === 0) {
      throw new ApiError('NO_TRANSACTIONS', 'Receipt contains no subscription transactions', 400);
    }

    // Newest transaction wins.
    const latest = transactions
      .slice()
      .sort((a, b) => Number(b.purchase_date_ms) - Number(a.purchase_date_ms))[0];

    const expiresMs = latest.expires_date_ms ? Number(latest.expires_date_ms) : null;
    const cancelled = Boolean(latest.cancellation_date_ms);
    const isTrial = latest.is_trial_period === 'true' || latest.is_in_intro_offer_period === 'true';
    const autoRenew =
      result.pending_renewal_info?.find(
        (info) => info.original_transaction_id === latest.original_transaction_id,
      )?.auto_renew_status === '1';

    let status: string;
    if (cancelled) status = 'revoked';
    else if (expiresMs && expiresMs < Date.now()) status = 'expired';
    else if (isTrial) status = 'trialing';
    else status = 'active';

    const db = adminClient();
    const { data: subscription, error } = await db
      .rpc('upsert_premium_subscription', {
        p_user_id: user.id,
        p_platform: 'apple',
        p_product_id: latest.product_id,
        p_status: status,
        p_original_tx: latest.original_transaction_id,
        p_latest_tx: latest.transaction_id,
        p_purchased_at: new Date(Number(latest.purchase_date_ms)).toISOString(),
        p_expires_at: expiresMs ? new Date(expiresMs).toISOString() : null,
        p_auto_renew: autoRenew,
        p_environment: result.environment === 'Sandbox' ? 'sandbox' : 'production',
        p_raw: latest as unknown as Record<string, unknown>,
      })
      .single();

    if (error) throw error;

    return json({
      is_premium: ['active', 'trialing', 'grace_period'].includes(status),
      status,
      product_id: latest.product_id,
      expires_at: subscription?.expires_at ?? null,
      environment: result.environment === 'Sandbox' ? 'sandbox' : 'production',
      auto_renew: autoRenew,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
