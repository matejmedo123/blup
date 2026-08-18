import React from 'react';

/**
 * Web variant of the Stripe bridge.
 *
 * @stripe/stripe-react-native imports React Native internals that Metro cannot
 * bundle for web, and a try/catch around require() does not help: Metro
 * resolves the module statically. So the web build never references it at all —
 * this file provides the same exports, and the checkout screen shows the same
 * honest "needs a development build" state it shows in Expo Go.
 *
 * Web checkout would use Stripe.js rather than the native SDK; that is a
 * separate integration and is deliberately not faked here.
 */

interface PaymentSheetError {
  code: string;
  message: string;
}

interface StripeHooks {
  initPaymentSheet(params: Record<string, unknown>): Promise<{ error?: PaymentSheetError }>;
  presentPaymentSheet(): Promise<{ error?: PaymentSheetError }>;
}

export const isStripeModuleAvailable = false;

export const STRIPE_UNAVAILABLE_MESSAGE =
  'Card payments are not available in the web preview — the payment sheet is a native module.\n\n' +
  'Use a development build on a phone to test checkout end to end. See DEPLOYMENT.md.';

export function StripeBridge({ children }: {
  publishableKey: string;
  merchantIdentifier?: string;
  children: React.ReactNode;
}) {
  return <>{children}</>;
}

export function useStripeBridge(): StripeHooks {
  return {
    initPaymentSheet: async () => ({
      error: { code: 'MODULE_UNAVAILABLE', message: STRIPE_UNAVAILABLE_MESSAGE },
    }),
    presentPaymentSheet: async () => ({
      error: { code: 'MODULE_UNAVAILABLE', message: STRIPE_UNAVAILABLE_MESSAGE },
    }),
  };
}
