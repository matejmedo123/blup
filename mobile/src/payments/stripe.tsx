import React from 'react';

/**
 * Lazy bridge to @stripe/stripe-react-native.
 *
 * Stripe ships a native module that does not exist in Expo Go. Importing it
 * there throws at module load, which would take the whole app down before the
 * first screen renders. Resolving it lazily keeps everything that does NOT need
 * payments — discovery, the map, profiles, RSVP, uploads, the AI feed — working
 * in Expo Go, and turns "no payments here" into an explicit state instead of a
 * crash. In a development build the real module resolves normally.
 */

interface PaymentSheetError {
  code: string;
  message: string;
}

interface StripeHooks {
  initPaymentSheet(params: Record<string, unknown>): Promise<{ error?: PaymentSheetError }>;
  presentPaymentSheet(): Promise<{ error?: PaymentSheetError }>;
}

interface StripeModule {
  StripeProvider: React.ComponentType<{
    publishableKey: string;
    merchantIdentifier?: string;
    children?: React.ReactNode;
  }>;
  useStripe(): StripeHooks;
}

function resolveStripe(): StripeModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require('@stripe/stripe-react-native') as StripeModule;
    return typeof module?.useStripe === 'function' ? module : null;
  } catch {
    return null;
  }
}

const stripeModule = resolveStripe();

/** False in Expo Go and in any build without the native Stripe module. */
export const isStripeModuleAvailable = stripeModule !== null;

export const STRIPE_UNAVAILABLE_MESSAGE =
  'Platby kartou potrebujú development build — Stripe modul nie je súčasťou Expo Go.\n\n' +
  'Spusti `npm run build:dev:android` (alebo :ios) a otvor appku z toho buildu. Pozri DEPLOYMENT.md.';

/**
 * Renders the real StripeProvider when it is available, and simply passes the
 * app through when it is not.
 */
export function StripeBridge({
  publishableKey,
  merchantIdentifier,
  children,
}: {
  publishableKey: string;
  merchantIdentifier?: string;
  children: React.ReactNode;
}) {
  if (!stripeModule || !publishableKey) {
    return <>{children}</>;
  }

  const Provider = stripeModule.StripeProvider;
  return (
    <Provider publishableKey={publishableKey} merchantIdentifier={merchantIdentifier}>
      {children}
    </Provider>
  );
}

/**
 * Always returns the same shape so the Rules of Hooks hold. Without the native
 * module the calls reject with a message the checkout screen can display.
 */
export function useStripeBridge(): StripeHooks {
  const fallback: StripeHooks = {
    initPaymentSheet: async () => ({
      error: { code: 'MODULE_UNAVAILABLE', message: STRIPE_UNAVAILABLE_MESSAGE },
    }),
    presentPaymentSheet: async () => ({
      error: { code: 'MODULE_UNAVAILABLE', message: STRIPE_UNAVAILABLE_MESSAGE },
    }),
  };

  // Calling the real hook unconditionally when the module exists keeps hook
  // order stable: `stripeModule` never changes after the first import.
  return stripeModule ? stripeModule.useStripe() : fallback;
}
