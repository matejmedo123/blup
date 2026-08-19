/**
 * Minimal Stripe client built on fetch + Web Crypto.
 *
 * Deliberately dependency-free so the function cold-starts fast and the exact
 * API surface we rely on is visible in one file. Covers what BLUP needs:
 * PaymentIntents, Connect accounts/onboarding links, transfers and webhook
 * signature verification.
 */
import { env } from './env.ts';
import { ApiError } from './http.ts';

const STRIPE_API = 'https://api.stripe.com/v1';

/** Encodes nested objects the way Stripe's form API expects (a[b][c]=d). */
function formEncode(data: Record<string, unknown>, prefix = ''): string[] {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    const field = prefix ? `${prefix}[${key}]` : key;

    if (typeof value === 'object' && !Array.isArray(value)) {
      parts.push(...formEncode(value as Record<string, unknown>, field));
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === 'object') {
          parts.push(...formEncode(item as Record<string, unknown>, `${field}[${index}]`));
        } else {
          parts.push(`${encodeURIComponent(`${field}[${index}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else {
      parts.push(`${encodeURIComponent(field)}=${encodeURIComponent(String(value))}`);
    }
  }

  return parts;
}

async function stripeRequest<T>(
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.stripeSecretKey()}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const response = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers,
    body: body ? formEncode(body).join('&') : undefined,
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new ApiError(
      'STRIPE_ERROR',
      payload?.error?.message ?? 'Stripe request failed',
      response.status === 402 ? 402 : 400,
      { type: payload?.error?.type, code: payload?.error?.code },
    );
  }

  return payload as T;
}

export interface StripePaymentIntent {
  id: string;
  client_secret: string;
  status: string;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
}

export interface StripeAccount {
  id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  requirements?: { currently_due?: string[]; disabled_reason?: string | null };
}

export const stripe = {
  /**
   * A destination charge: the buyer pays BLUP, Stripe automatically forwards the
   * amount minus `application_fee_amount` (the BLUP fee) to the organizer's
   * connected account. When the organizer has no connected account yet, the
   * charge stays on the platform and the ledger tracks what is owed.
   */
  createPaymentIntent: (params: {
    amountCents: number;
    currency: string;
    orderId: string;
    buyerId: string;
    eventId: string;
    applicationFeeCents?: number;
    connectedAccountId?: string | null;
    customerEmail?: string;
  }) =>
    stripeRequest<StripePaymentIntent>('/payment_intents', 'POST', {
      amount: params.amountCents,
      currency: params.currency.toLowerCase(),
      'automatic_payment_methods[enabled]': 'true',
      receipt_email: params.customerEmail,
      metadata: {
        order_id: params.orderId,
        buyer_id: params.buyerId,
        event_id: params.eventId,
        platform: 'blup',
      },
      ...(params.connectedAccountId
        ? {
            application_fee_amount: params.applicationFeeCents ?? 0,
            transfer_data: { destination: params.connectedAccountId },
          }
        : {}),
    }, `pi_${params.orderId}`),

  /**
   * A boost is bought by BLUP, not by the organizer's connected account — the
   * money is ours, so there is no transfer_data and no application fee.
   */
  createBoostPaymentIntent: (params: {
    amountCents: number;
    currency: string;
    boostId: string;
    buyerId: string;
    eventId: string;
    customerEmail?: string;
  }) =>
    stripeRequest<StripePaymentIntent>('/payment_intents', 'POST', {
      amount: params.amountCents,
      currency: params.currency.toLowerCase(),
      'automatic_payment_methods[enabled]': 'true',
      receipt_email: params.customerEmail,
      metadata: {
        boost_id: params.boostId,
        buyer_id: params.buyerId,
        event_id: params.eventId,
        kind: 'boost',
        platform: 'blup',
      },
    }, `boost_${params.boostId}`),

  retrievePaymentIntent: (id: string) =>
    stripeRequest<StripePaymentIntent>(`/payment_intents/${id}`, 'GET'),

  createRefund: (paymentIntentId: string, reason = 'requested_by_customer') =>
    stripeRequest<{ id: string; status: string }>('/refunds', 'POST', {
      payment_intent: paymentIntentId,
      reason,
    }),

  createConnectedAccount: (params: { email?: string; country: string; organizationId: string }) =>
    stripeRequest<StripeAccount>('/accounts', 'POST', {
      type: 'express',
      country: params.country,
      email: params.email,
      capabilities: {
        card_payments: { requested: 'true' },
        transfers: { requested: 'true' },
      },
      business_type: 'company',
      metadata: { organization_id: params.organizationId, platform: 'blup' },
    }),

  retrieveAccount: (accountId: string) =>
    stripeRequest<StripeAccount>(`/accounts/${accountId}`, 'GET'),

  createAccountLink: (accountId: string) =>
    stripeRequest<{ url: string; expires_at: number }>('/account_links', 'POST', {
      account: accountId,
      refresh_url: env.stripeConnectRefreshUrl(),
      return_url: env.stripeConnectReturnUrl(),
      type: 'account_onboarding',
    }),

  createPayout: (params: {
    accountId: string;
    amountCents: number;
    currency: string;
    payoutId: string;
  }) =>
    stripeRequest<{ id: string; status: string }>('/transfers', 'POST', {
      amount: params.amountCents,
      currency: params.currency.toLowerCase(),
      destination: params.accountId,
      metadata: { payout_id: params.payoutId, platform: 'blup' },
    }, `payout_${params.payoutId}`),
};

/**
 * Verifies the `Stripe-Signature` header (scheme v1, HMAC-SHA256 over
 * `${timestamp}.${payload}`) using constant-time comparison. Without this a
 * webhook is just an unauthenticated endpoint that grants free tickets.
 */
export async function verifyStripeSignature(
  payload: string,
  signatureHeader: string | null,
  toleranceSeconds = 300,
): Promise<void> {
  if (!signatureHeader) {
    throw new ApiError('INVALID_SIGNATURE', 'Missing Stripe-Signature header', 400);
  }

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((part) => {
      const [key, ...rest] = part.split('=');
      return [key.trim(), rest.join('=')];
    }),
  );

  const timestamp = parts['t'];
  const expected = parts['v1'];

  if (!timestamp || !expected) {
    throw new ApiError('INVALID_SIGNATURE', 'Malformed Stripe-Signature header', 400);
  }

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) {
    throw new ApiError('INVALID_SIGNATURE', 'Webhook timestamp outside tolerance', 400);
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.stripeWebhookSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signatureBytes = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );

  const computed = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (!timingSafeEqual(computed, expected)) {
    throw new ApiError('INVALID_SIGNATURE', 'Stripe signature mismatch', 400);
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
