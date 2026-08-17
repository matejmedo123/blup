import { Platform } from 'react-native';

import { callFunction, supabase } from '@/lib/supabase';
import { env } from '@/lib/env';
import type { PremiumStatus } from '@/types/models';

/**
 * Premium subscriptions.
 *
 * Apple's rules (spec §20): premium unlocks digital functionality inside the
 * app, so on iOS it MUST be sold through StoreKit In-App Purchase — not through
 * a Stripe checkout. Ticket purchases are the opposite case (a real-world
 * event), which is why they go through Stripe/Apple Pay instead.
 *
 * The purchase itself happens in the native store SDK; this module owns the two
 * things that are ours: asking the store for products, and having the BACKEND
 * verify the receipt. The client can never grant itself premium — RLS forbids
 * writing premium_subscriptions, and only the verification Edge Function
 * (service role) can upsert it.
 */

export const PREMIUM_PRODUCTS = {
  monthly: env.premiumProductIdMonthly,
  yearly: env.premiumProductIdYearly,
};

export const PREMIUM_FEATURES = [
  'Advanced AI recommendations tuned to your behaviour',
  'See why every event was recommended',
  'Anonymous mode — browse without appearing in people matching',
  'Unlimited saved events and advanced filters',
  'Early access to ticket drops from verified organizers',
] as const;

export async function getPremiumStatus(): Promise<PremiumStatus> {
  const { data, error } = await supabase.rpc('my_premium_status');
  if (error) throw error;
  return (data as PremiumStatus) ?? { is_premium: false, status: 'none' };
}

/** Sends a StoreKit receipt to the backend, which asks Apple and then decides. */
export async function verifyAppleReceipt(receipt: string): Promise<PremiumStatus> {
  return callFunction<PremiumStatus>('iap-apple-verify', { receipt });
}

// ---------------------------------------------------------------------------
// Store bridge
// ---------------------------------------------------------------------------
// The native IAP module is an optional dependency: a bare Expo Go session has
// no StoreKit. We resolve it lazily so the app runs everywhere and reports a
// precise reason when purchasing is not possible, instead of a dead button.

export type StoreAvailability =
  | { available: true; module: IapModule }
  | { available: false; reason: 'NOT_INSTALLED' | 'UNSUPPORTED_PLATFORM'; message: string };

interface IapProduct {
  productId: string;
  price: string;
  localizedPrice?: string;
  title?: string;
  description?: string;
}

interface IapModule {
  initConnection(): Promise<unknown>;
  endConnection(): Promise<unknown>;
  getSubscriptions(params: { skus: string[] }): Promise<IapProduct[]>;
  requestSubscription(params: { sku: string }): Promise<unknown>;
  getReceiptIOS?(): Promise<string>;
  finishTransaction?(params: { purchase: unknown; isConsumable: boolean }): Promise<unknown>;
}

export function getStore(): StoreAvailability {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return {
      available: false,
      reason: 'UNSUPPORTED_PLATFORM',
      message: 'Subscriptions are only available in the iOS and Android apps.',
    };
  }

  try {
    // Resolved at runtime so the bundler does not hard-require it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require('react-native-iap') as IapModule;
    if (!module?.initConnection) throw new Error('missing');
    return { available: true, module };
  } catch {
    return {
      available: false,
      reason: 'NOT_INSTALLED',
      message:
        Platform.OS === 'ios'
          ? 'In-app purchases need a development build with StoreKit.\n\n' +
            'Install the native module (npm i react-native-iap), run `npx expo prebuild`, ' +
            'then build with EAS. See DEPLOYMENT.md → Premium.'
          : 'In-app purchases need a development build with Google Play Billing.\n\n' +
            'Install the native module (npm i react-native-iap) and rebuild. See DEPLOYMENT.md.',
    };
  }
}

export async function getPremiumProducts(): Promise<IapProduct[]> {
  const store = getStore();
  if (!store.available) throw new Error(store.message);

  await store.module.initConnection();
  return store.module.getSubscriptions({
    skus: [PREMIUM_PRODUCTS.monthly, PREMIUM_PRODUCTS.yearly],
  });
}

/**
 * Full purchase round-trip:
 *   StoreKit purchase → receipt → backend verification → premium unlocked.
 * Returns the status the BACKEND confirmed, never an optimistic local guess.
 */
export async function purchasePremium(plan: 'monthly' | 'yearly'): Promise<PremiumStatus> {
  const store = getStore();
  if (!store.available) throw new Error(store.message);

  const sku = PREMIUM_PRODUCTS[plan];

  await store.module.initConnection();
  await store.module.requestSubscription({ sku });

  if (Platform.OS === 'ios') {
    if (!store.module.getReceiptIOS) {
      throw new Error('The store module does not expose a receipt to verify.');
    }
    const receipt = await store.module.getReceiptIOS();
    return verifyAppleReceipt(receipt);
  }

  // Google Play verification lives in its own Edge Function; until it is
  // deployed we surface an explicit state instead of pretending it worked.
  throw new Error(
    'GOOGLE_PLAY_VERIFICATION_NOT_CONFIGURED: add the Play verification function to enable Android premium.',
  );
}

/** Restores an existing subscription on a new device. */
export async function restorePurchases(): Promise<PremiumStatus> {
  const store = getStore();
  if (!store.available) throw new Error(store.message);

  if (Platform.OS !== 'ios' || !store.module.getReceiptIOS) {
    throw new Error('Restoring purchases is currently only implemented for iOS.');
  }

  await store.module.initConnection();
  const receipt = await store.module.getReceiptIOS();
  return verifyAppleReceipt(receipt);
}
