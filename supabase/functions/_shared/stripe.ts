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

export interface StripeCheckoutSession {
  id: string;
  url: string;
  status: string;
  payment_status: string;
  customer: string | null;
  subscription: string | null;
  metadata: Record<string, string>;
}

export interface StripeSubscription {
  id: string;
  status: string;
  customer: string;
  cancel_at_period_end: boolean;
  current_period_end: number;
  start_date: number;
  items: { data: { price: { id: string; recurring?: { interval: string } } }[] };
  metadata: Record<string, string>;
}

export interface StripeCustomer {
  id: string;
  email: string | null;
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
   * A hosted Checkout session — the web payment path.
   *
   * The browser is redirected to Stripe rather than collecting card details in
   * our own page: it brings Apple Pay, Google Pay, Link and 3-D Secure with it,
   * and keeps every card number off BLUP's origin entirely. The webhook remains
   * the only thing that marks anything paid, exactly as on native.
   */
  createCheckoutSession: (params: {
    mode: 'payment' | 'subscription';
    successUrl: string;
    cancelUrl: string;
    customerId?: string | null;
    customerEmail?: string | null;
    clientReferenceId?: string;
    metadata: Record<string, string>;
    locale?: string;
    /** mode: 'payment' */
    amountCents?: number;
    currency?: string;
    productName?: string;
    productDescription?: string;
    quantity?: number;
    /**
     * A basket. When present it replaces the single synthetic line, so the
     * Stripe page itemises what is being bought instead of showing one lump
     * sum — and the sum of the lines is what gets charged.
     */
    lineItems?: {
      name: string;
      description?: string;
      unitAmountCents: number;
      quantity: number;
    }[];
    applicationFeeCents?: number;
    connectedAccountId?: string | null;
    /** mode: 'subscription' */
    priceId?: string;
    trialDays?: number;
    idempotencyKey?: string;
  }) => {
    const body: Record<string, unknown> = {
      mode: params.mode,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      client_reference_id: params.clientReferenceId,
      metadata: params.metadata,
      locale: params.locale ?? 'sk',
      allow_promotion_codes: false,
    };

    // A returning customer keeps one Stripe customer record, so their cards and
    // their subscription history stay together instead of forking per purchase.
    if (params.customerId) body.customer = params.customerId;
    else if (params.customerEmail) body.customer_email = params.customerEmail;

    if (params.mode === 'payment') {
      const currency = (params.currency ?? 'eur').toLowerCase();

      body.line_items = params.lineItems?.length
        ? params.lineItems.map((item) => ({
            quantity: item.quantity,
            price_data: {
              currency,
              unit_amount: item.unitAmountCents,
              product_data: { name: item.name, description: item.description },
            },
          }))
        : [{
            quantity: 1,
            price_data: {
              currency,
              unit_amount: params.amountCents,
              product_data: {
                name: params.productName ?? 'Blup',
                description: params.productDescription,
              },
            },
          }];
      body.payment_intent_data = {
        metadata: params.metadata,
        ...(params.connectedAccountId
          ? {
              application_fee_amount: params.applicationFeeCents ?? 0,
              transfer_data: { destination: params.connectedAccountId },
            }
          : {}),
      };
    } else {
      body.line_items = [{ price: params.priceId, quantity: 1 }];
      body.subscription_data = {
        metadata: params.metadata,
        ...(params.trialDays ? { trial_period_days: params.trialDays } : {}),
      };
      body.customer_update = params.customerId ? { address: 'auto' } : undefined;
    }

    return stripeRequest<StripeCheckoutSession>(
      '/checkout/sessions', 'POST', body, params.idempotencyKey,
    );
  },

  retrievePrice: (id: string) =>
    stripeRequest<{
      id: string;
      unit_amount: number | null;
      currency: string;
      recurring?: { interval: string; interval_count: number } | null;
    }>(`/prices/${id}`, 'GET'),

  retrieveCheckoutSession: (id: string) =>
    stripeRequest<StripeCheckoutSession>(`/checkout/sessions/${id}`, 'GET'),

  retrieveSubscription: (id: string) =>
    stripeRequest<StripeSubscription>(`/subscriptions/${id}`, 'GET'),

  createCustomer: (params: { email?: string | null; userId: string }) =>
    stripeRequest<StripeCustomer>('/customers', 'POST', {
      email: params.email ?? undefined,
      metadata: { blup_user_id: params.userId },
    }, `cus_${params.userId}`),

  /**
   * The Stripe-hosted page where a subscriber changes their card or cancels.
   * Building that ourselves would mean re-implementing dunning, proration and
   * tax display — and getting any of them subtly wrong.
   */
  createBillingPortalSession: (params: { customerId: string; returnUrl: string }) =>
    stripeRequest<{ id: string; url: string }>('/billing_portal/sessions', 'POST', {
      customer: params.customerId,
      return_url: params.returnUrl,
    }),

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
