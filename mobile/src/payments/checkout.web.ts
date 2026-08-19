import { callFunction } from '@/lib/supabase';

/**
 * Web payments.
 *
 * Everything is a redirect to Stripe's hosted Checkout: it brings Apple Pay,
 * Google Pay, Link and 3-D Secure with it, and no card number ever touches
 * BLUP's origin. The server prices the order exactly as it does on native, and
 * the webhook is still the only thing that marks anything paid.
 *
 * Premium sold here is a Stripe subscription rather than an Apple one. Outside
 * the App Store there is no 15–30 % commission, which is why the web build is
 * the one to launch first.
 */

export interface PayResult {
  status: 'succeeded' | 'pending' | 'cancelled' | 'redirecting';
  orderId?: string;
  message?: string;
}

export interface PayHandlers {
  initPaymentSheet(params: Record<string, unknown>): Promise<{ error?: { code: string; message: string } }>;
  presentPaymentSheet(): Promise<{ error?: { code: string; message: string } }>;
  merchantName?: string;
}

interface WebCheckoutResponse {
  order_id?: string;
  boost_id?: string;
  redirect_url?: string;
  requires_payment?: boolean;
  status?: string;
}

export const canTakePayment = (): boolean => true;

/** Hosted Checkout is a server-issued URL; the browser needs no Stripe key. */
export const requiresPublishableKey = false;

export const unavailableMessage =
  'Platby cez web zatiaľ nie sú nakonfigurované. Doplň Stripe kľúče — pozri PAYMENTS.md.';

function go(url: string): void {
  // A full navigation, not a new tab: pop-up blockers eat `window.open` when it
  // is not directly inside the click handler, and a blocked payment window
  // looks to the buyer like a button that does nothing.
  window.location.assign(url);
}

export async function payForTickets(
  ticketTypeId: string,
  quantity: number,
  promoCode: string | null,
): Promise<PayResult> {
  const session = await callFunction<WebCheckoutResponse>('web-checkout', {
    kind: 'ticket',
    ticket_type_id: ticketTypeId,
    quantity,
    promo_code: promoCode,
  });

  if (session.requires_payment === false) {
    return { status: 'succeeded', orderId: session.order_id };
  }
  if (!session.redirect_url) throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');

  go(session.redirect_url);
  return { status: 'redirecting', orderId: session.order_id };
}

export async function subscribePremium(plan: 'monthly' | 'yearly'): Promise<PayResult> {
  const session = await callFunction<WebCheckoutResponse>('web-checkout', { kind: 'premium', plan });
  if (!session.redirect_url) throw new Error('PREMIUM_PRICING_NOT_CONFIGURED');

  go(session.redirect_url);
  return { status: 'redirecting' };
}

export const canManageBilling = true;

/** Stripe's own page for changing a card or cancelling. */
export async function openBillingPortal(): Promise<void> {
  const session = await callFunction<WebCheckoutResponse>('web-checkout', {
    kind: 'portal',
    return_url: '/premium',
  });
  if (!session.redirect_url) throw new Error('NO_BILLING_ACCOUNT');
  go(session.redirect_url);
}

export async function payForBoost(eventId: string, packageCode: string): Promise<PayResult> {
  const session = await callFunction<WebCheckoutResponse>('web-checkout', {
    kind: 'boost',
    event_id: eventId,
    package_code: packageCode,
  });
  if (!session.redirect_url) throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');

  go(session.redirect_url);
  return { status: 'redirecting', orderId: session.boost_id };
}
