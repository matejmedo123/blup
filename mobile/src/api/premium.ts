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

/**
 * What Premium actually gives you.
 *
 * Written as things you can see, show or use — not as adjectives about the
 * algorithm. Nobody pays for "better recommendations": they cannot see them,
 * cannot show them to anybody, and have no way to tell whether they got them.
 *
 * Every line here is something the database enforces and the app renders. If a
 * line stops being true, it comes out of this list on the same day.
 */
export const PREMIUM_FEATURES = [
  {
    icon: '🎨',
    title: 'Farba celého BLUPu',
    body: 'Šesť farieb. Prefarbí tlačidlá, prepínače aj to, čo je vybrané — celá appka, nie jeden pruh.',
  },
  {
    icon: '🖼️',
    title: 'Vlastné pozadie chatu',
    body: 'Tvoja fotka za správami. Vidíš ju len ty, nikomu nič neprekrýva.',
  },
  {
    icon: '✦',
    title: 'Odznak pri mene',
    body: 'Vidno ho všade, kde si — v chate, v komentároch, na profile.',
  },
  {
    icon: '👀',
    title: 'Kto si ťa pozrel',
    body: 'Mená a tváre ľudí, ktorí ti otvorili profil za posledný týždeň. Bez Premium vidíš len počet.',
  },
  {
    icon: '⚡',
    title: 'Dvojnásobné body',
    body: 'Za všetko, čo robíš. Rýchlejšie levely, rýchlejšie odznaky.',
  },
  {
    icon: '🕶️',
    title: 'Anonymný režim',
    body: 'Prezeraj profily bez toho, aby si o tom druhá strana vedela.',
  },
  {
    icon: '🧠',
    title: 'Uvidíš, prečo ti to BLUP ukázal',
    body: 'Pri každom odporúčaní dôvod, nie len poradie.',
  },
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
      message: 'Predplatné je dostupné iba v iOS a Android aplikácii.',
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
      throw new Error('Modul obchodu nevrátil doklad na overenie.');
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
    throw new Error('Obnovenie nákupov je zatiaľ implementované len pre iOS.');
  }

  await store.module.initConnection();
  const receipt = await store.module.getReceiptIOS();
  return verifyAppleReceipt(receipt);
}


// --- web subscriptions -------------------------------------------------------

/**
 * Premium bought in a browser, told plainly.
 *
 * `managed_here` is the honest bit: a subscription bought through the App Store
 * cannot be cancelled from a web page, and offering a cancel button that does
 * nothing is worse than offering none.
 */
export interface WebPremiumStatus {
  active: boolean;
  platform: 'apple' | 'google' | 'stripe' | null;
  product_id?: string;
  status?: string;
  expires_at?: string | null;
  auto_renew?: boolean;
  managed_here: boolean;
  has_stripe_customer: boolean;
}

export async function getWebPremiumStatus(): Promise<WebPremiumStatus> {
  const { data, error } = await supabase.rpc('web_premium_status');
  if (error) throw error;
  return data as WebPremiumStatus;
}

export interface WebPlanPrice {
  amount_cents: number | null;
  currency: string;
  interval: string;
}

export interface WebPremiumPricing {
  configured: boolean;
  monthly: WebPlanPrice | null;
  yearly: WebPlanPrice | null;
}

/**
 * The price the web build shows before sending anyone to Checkout.
 *
 * Read from the server, which reads it from the same Stripe Price objects the
 * session is built from — so what someone is quoted is what they are charged.
 * If Stripe cannot be reached the amount is simply absent, and the screen says
 * nothing rather than guessing.
 */
export async function getWebPremiumPricing(): Promise<WebPremiumPricing> {
  try {
    const status = await callFunction<{
      premium?: { web_configured?: boolean; web_pricing?: { monthly: WebPlanPrice | null; yearly: WebPlanPrice | null } | null };
    }>('config-status', undefined, { method: 'GET' });

    return {
      configured: Boolean(status.premium?.web_configured),
      monthly: status.premium?.web_pricing?.monthly ?? null,
      yearly: status.premium?.web_pricing?.yearly ?? null,
    };
  } catch {
    return { configured: false, monthly: null, yearly: null };
  }
}

// --- what Premium looks like -------------------------------------------------

/**
 * The colour and wallpaper this person's app should use.
 *
 * `accent_color` is what applies *now*; `saved_accent` is what they chose. They
 * differ exactly when a subscription has lapsed — the choice is kept so that
 * coming back restores it rather than losing it.
 */
export interface MyLook {
  is_premium: boolean;
  accent_color: string | null;
  chat_wallpaper: string | null;
  saved_accent: string | null;
  saved_wallpaper: string | null;
}

export async function getMyLook(): Promise<MyLook> {
  const { data, error } = await supabase.rpc('my_look');
  if (error) throw error;
  return (data as MyLook) ?? {
    is_premium: false,
    accent_color: null,
    chat_wallpaper: null,
    saved_accent: null,
    saved_wallpaper: null,
  };
}

export async function setPremiumLook(params: {
  accent?: string | null;
  wallpaper?: string | null;
  clearAccent?: boolean;
  clearWallpaper?: boolean;
}): Promise<void> {
  const { error } = await supabase.rpc('set_premium_look', {
    p_accent: params.accent ?? null,
    p_wallpaper: params.wallpaper ?? null,
    p_clear_accent: params.clearAccent ?? false,
    p_clear_wallpaper: params.clearWallpaper ?? false,
  });
  if (error) throw error;
}

/** Who looked at your profile. Names for subscribers, the count for everybody. */
export interface ProfileViews {
  is_premium: boolean;
  total: number;
  viewers: {
    id: string;
    username: string | null;
    display_name: string | null;
    avatar_url: string | null;
    last_seen_at: string;
    times: number;
  }[];
}

export async function getProfileViews(days = 7): Promise<ProfileViews> {
  const { data, error } = await supabase.rpc('my_profile_views', { p_days: days });
  if (error) throw error;
  return data as ProfileViews;
}

export async function recordProfileView(profileId: string): Promise<void> {
  // Deliberately swallowed: failing to record that somebody looked at a profile
  // must never be the reason the profile does not open.
  await supabase.rpc('record_profile_view', { p_profile_id: profileId });
}
