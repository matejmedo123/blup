import { callFunction } from '@/lib/supabase';
import { createCheckout, waitForTickets } from '@/api/tickets';
import { isStripeModuleAvailable, STRIPE_UNAVAILABLE_MESSAGE } from '@/payments/stripe';

/**
 * One way to pay, whichever platform you are on.
 *
 * Native uses the PaymentSheet: the order is created, Stripe collects the card
 * on-device, and the app waits for the webhook to issue the ticket. Web has no
 * native module, so it hands off to Stripe's hosted Checkout and comes back to
 * `/checkout/return`.
 *
 * Both paths price the order in the database and both wait for the webhook.
 * The difference is only where the card is typed — never who decides what
 * anything costs, and never who decides that it was paid.
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

/** True when this platform can take a payment at all. */
export const canTakePayment = (): boolean => isStripeModuleAvailable;

/**
 * The native sheet needs a publishable key in the app bundle. Hosted Checkout
 * does not — the URL comes from the server — so the web build must not be
 * gated on a key it never uses.
 */
export const requiresPublishableKey = true;

export const unavailableMessage = STRIPE_UNAVAILABLE_MESSAGE;

/** Buys tickets. On native this resolves once the webhook has issued them. */
export async function payForTickets(
  ticketTypeId: string,
  quantity: number,
  promoCode: string | null,
  handlers: PayHandlers,
): Promise<PayResult> {
  const session = await createCheckout(ticketTypeId, quantity, promoCode);

  if (!session.requires_payment) {
    return { status: 'succeeded', orderId: session.order_id };
  }
  if (!session.payment_intent_client_secret) {
    throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');
  }

  const { error: initError } = await handlers.initPaymentSheet({
    merchantDisplayName: handlers.merchantName ?? 'BLUP',
    paymentIntentClientSecret: session.payment_intent_client_secret,
    applePay: { merchantCountryCode: 'SK' },
    googlePay: { merchantCountryCode: 'SK', testEnv: __DEV__ },
    returnURL: 'blup://stripe-redirect',
    allowsDelayedPaymentMethods: false,
  });
  if (initError) throw new Error(initError.message);

  const { error: sheetError } = await handlers.presentPaymentSheet();
  if (sheetError) {
    if (sheetError.code === 'Canceled') return { status: 'cancelled', orderId: session.order_id };
    throw new Error(sheetError.message);
  }

  const result = await waitForTickets(session.order_id);
  if (result.status === 'failed') {
    throw new Error('Platba neprešla. Nič sme ti nestrhli.');
  }

  return { status: result.status === 'succeeded' ? 'succeeded' : 'pending', orderId: session.order_id };
}

/** Premium. Native buys it through the App Store; web through Stripe. */
export async function subscribePremium(_plan: 'monthly' | 'yearly'): Promise<PayResult> {
  throw new Error('USE_IAP_ON_NATIVE');
}

/** Whether Premium can be managed (cancelled, card changed) on this platform. */
export const canManageBilling = false;

export async function openBillingPortal(): Promise<void> {
  throw new Error('MANAGE_IN_APP_STORE');
}

/** Buys a boost. */
export async function payForBoost(eventId: string, packageCode: string): Promise<PayResult> {
  const session = await callFunction<{ order_id?: string; boost_id?: string }>('boost-create', {
    event_id: eventId,
    package_code: packageCode,
  });
  return { status: 'pending', orderId: session.boost_id };
}
