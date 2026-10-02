import { callFunction } from '@/lib/supabase';
import { consent } from '@/marketing/tags';

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
  /** Present for a guest purchase: the only key to the ticket without a login. */
  claimToken?: string | null;
}

/**
 * Who is buying, when nobody is signed in.
 *
 * The three things a ticket needs and nothing more: the name to print on it,
 * the address to send it to, and the town it is travelled from — which is what
 * puts a dot on the organizer's map. Everything here is validated again on the
 * server; this shape is only what the form collects.
 */
export interface GuestDetails {
  name: string;
  email: string;
  city: string;
  latitude?: number | null;
  longitude?: number | null;
}

export interface PayHandlers {
  initPaymentSheet(params: Record<string, unknown>): Promise<{ error?: { code: string; message: string } }>;
  presentPaymentSheet(): Promise<{ error?: { code: string; message: string } }>;
  merchantName?: string;
}

interface WebCheckoutResponse {
  order_id?: string;
  claim_token?: string | null;
  checkout_id?: string;
  boost_id?: string;
  redirect_url?: string;
  payment_intent_client_secret?: string;
  return_url?: string;
  requires_payment?: boolean;
  status?: string;
}

/**
 * Platba, ktorá sa odohrá na BLUPe.
 *
 * `needs_card` znamená, že objednávka je založená a čaká na potvrdenie karty
 * cez Payment Element. `succeeded` je stav, keď nakoniec nebolo čo platiť —
 * napríklad zľavový kód zrazil sumu na nulu medzi tým, čo si človek pozrel
 * cenu, a tým, čo stlačil „Zaplatiť". Vstupenka je vtedy už vydaná.
 */
export type InlineStart =
  | {
      status: 'needs_card';
      clientSecret: string;
      returnUrl: string;
      orderId?: string;
      claimToken?: string | null;
    }
  | { status: 'succeeded'; orderId?: string; claimToken?: string | null };

export const canTakePayment = (): boolean => true;

/**
 * Inline platba potrebuje publishable key v prehliadači.
 *
 * Je to verejný kľúč — je v každom skripte na stránke a nič sa ním nedá
 * minúť. Tajný kľúč ostáva iba na serveri, kde aj bol.
 */
export const supportsInlinePayment = true;

/** Hosted Checkout is a server-issued URL; the browser needs no Stripe key. */
export const requiresPublishableKey = false;

export const unavailableMessage =
  'Platby cez web zatiaľ nie sú nakonfigurované. Doplň Stripe kľúče — pozri PAYMENTS.md.';

/**
 * Čo sa k objednávke odloží pre meranie zo servera.
 *
 * Nákup hlási Mete aj webhook — prehliadačový pixel ich časť stráca na
 * blokovačoch a zatvorených kartách. Webhook ale beží neskôr a z iného miesta,
 * takže nemá ako zistiť ani to, či človek marketing povolil, ani z ktorej
 * reklamy prišiel. Oboje vie iba táto stránka, a preto to posiela so sebou.
 *
 * Keď je odpoveď nie, odchádza jediná informácia: nie.
 */
function marketingContext(): { consent: boolean; fbp?: string | null; fbc?: string | null } {
  if (!consent().marketing) return { consent: false };

  const cookie = (name: string): string | null => {
    try {
      const hit = globalThis.document?.cookie
        ?.split('; ')
        .find((entry) => entry.startsWith(`${name}=`));
      return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
    } catch {
      return null;
    }
  };

  return { consent: true, fbp: cookie('_fbp'), fbc: cookie('_fbc') };
}

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
  handlers?: PayHandlers,
  guest?: GuestDetails | null,
): Promise<PayResult> {
  const session = await callFunction<WebCheckoutResponse>('web-checkout', {
    kind: 'ticket',
    marketing: marketingContext(),
    ticket_type_id: ticketTypeId,
    quantity,
    promo_code: promoCode,
    // Sent only when there is no session. The server decides which it is — it
    // reads the token itself rather than believing this flag.
    guest: guest ?? undefined,
  });

  if (session.requires_payment === false) {
    // A guest has no "my tickets" page, so the order id and its token are the
    // only way back to the QR. Handed to the caller rather than kept here.
    return { status: 'succeeded', orderId: session.order_id, claimToken: session.claim_token };
  }
  if (!session.redirect_url) throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');

  go(session.redirect_url);
  return { status: 'redirecting', orderId: session.order_id, claimToken: session.claim_token };
}

/**
 * Založí objednávku na vstupenku a vráti tajomstvo platby.
 *
 * Volá sa až po stlačení „Zaplatiť": dovtedy nie je čo rezervovať a nikomu sa
 * neblokujú lístky. Cenu počíta `create_order` v databáze rovnako ako pri
 * hostovanom Checkoute — toto je iná obrazovka, nie iná cena.
 */
export async function startInlineTicketPayment(
  ticketTypeId: string,
  quantity: number,
  promoCode: string | null,
  guest?: GuestDetails | null,
): Promise<InlineStart> {
  const session = await callFunction<WebCheckoutResponse>('web-checkout', {
    kind: 'ticket',
    inline: true,
    marketing: marketingContext(),
    ticket_type_id: ticketTypeId,
    quantity,
    promo_code: promoCode,
    guest: guest ?? undefined,
  });

  if (session.requires_payment === false) {
    return { status: 'succeeded', orderId: session.order_id, claimToken: session.claim_token };
  }
  if (!session.payment_intent_client_secret || !session.return_url) {
    throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');
  }

  return {
    status: 'needs_card',
    clientSecret: session.payment_intent_client_secret,
    returnUrl: session.return_url,
    orderId: session.order_id,
    claimToken: session.claim_token,
  };
}

/** To isté pre celý košík. Čo je v ňom a čo to stojí, vie server sám. */
export async function startInlineCartPayment(promoCode: string | null): Promise<InlineStart> {
  const session = await callFunction<WebCheckoutResponse>('web-checkout', {
    kind: 'cart',
    inline: true,
    marketing: marketingContext(),
    promo_code: promoCode,
  });

  if (session.requires_payment === false) {
    return { status: 'succeeded', orderId: session.checkout_id };
  }
  if (!session.payment_intent_client_secret || !session.return_url) {
    throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');
  }

  return {
    status: 'needs_card',
    clientSecret: session.payment_intent_client_secret,
    returnUrl: session.return_url,
    orderId: session.checkout_id,
  };
}

/**
 * Pays for the whole basket at once.
 *
 * The browser sends nothing but the promo code: which tickets, how many and
 * what they cost comes from the reservations already held in the database.
 */
export async function payForCart(promoCode: string | null): Promise<PayResult> {
  const session = await callFunction<WebCheckoutResponse>('web-checkout', {
    kind: 'cart',
    marketing: marketingContext(),
    promo_code: promoCode,
  });

  if (session.requires_payment === false) {
    return { status: 'succeeded', orderId: session.checkout_id };
  }
  if (!session.redirect_url) throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');

  go(session.redirect_url);
  return { status: 'redirecting', orderId: session.checkout_id };
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

/**
 * Buys an ad campaign.
 *
 * Web, so it goes through Stripe's hosted page like everything else here. It
 * deliberately does NOT call boost-create: that returns a PaymentIntent secret
 * for a native payment sheet, and a browser has nothing to present it with —
 * the campaign would be created, never paid for, and never run. The button
 * would say "Spustiť kampaň" and nothing would happen.
 */
export async function payForCampaign(input: {
  eventId: string;
  budgetCents: number;
  days: number;
  placements: string[];
  radiusM: number;
  categories: string[];
}): Promise<PayResult> {
  const session = await callFunction<WebCheckoutResponse>('web-checkout', {
    kind: 'campaign',
    event_id: input.eventId,
    budget_cents: Math.round(input.budgetCents),
    days: input.days,
    placements: input.placements,
    radius_m: input.radiusM,
    categories: input.categories,
  });
  if (!session.redirect_url) throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');

  go(session.redirect_url);
  return { status: 'redirecting', orderId: session.boost_id };
}

/**
 * Nákup na burze v prehliadači.
 *
 * Rovnako ako všetko ostatné na webe: presmerovanie na hostovaný Checkout.
 * Číslo karty sa nedotkne našej domény a zaplatené je to až vtedy, keď to
 * povie webhook — návrat z platobnej brány je len návrat, nie dôkaz.
 */
export async function payForResale(
  reservationId: string,
  _handlers?: PayHandlers,
): Promise<PayResult> {
  const session = await callFunction<WebCheckoutResponse>('web-checkout', {
    kind: 'resale',
    reservation_id: reservationId,
  });

  if (!session.redirect_url) throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');

  go(session.redirect_url);
  return { status: 'redirecting', orderId: session.order_id };
}
