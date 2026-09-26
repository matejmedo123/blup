/**
 * POST /functions/v1/web-checkout
 *
 * The browser payment path. Prices everything server-side exactly as the native
 * flow does, then hands back a Stripe-hosted Checkout URL for the client to
 * redirect to.
 *
 * Three kinds, one function, because they differ only in what is being priced:
 *
 *   ticket   { kind, ticket_type_id, quantity, promo_code? }
 *   resale   { kind, reservation_id }  — nákup na burze
 *   cart     { kind, promo_code? }  — whatever is reserved in the basket
 *   premium  { kind, plan: 'monthly' | 'yearly' }
 *   boost    { kind, event_id, package_code }
 *   campaign { kind, event_id, budget_cents, days, placements, radius_m, categories }
 *   portal   { kind }  — Stripe's own page for changing a card or cancelling
 *
 * Why hosted Checkout rather than card fields in our own page: it brings Apple
 * Pay, Google Pay, Link and 3-D Secure with it, and keeps every card number off
 * BLUP's origin. The webhook stays the only thing that marks anything paid.
 *
 * Premium sold here is a Stripe subscription, not an Apple one — outside the
 * App Store there is no 15–30 % commission. Both write to the same table, so a
 * person who subscribes on the web and later installs the app keeps it.
 */
import {
  ApiError, adminClient, errorResponse, handleOptions, json, optionalUser, rateLimit, readJson,
  requireUser, userClient,
} from '../_shared/http.ts';
import type { BoostRow, CheckoutRow, OrderRow } from '../_shared/rows.ts';
import { stripe } from '../_shared/stripe.ts';
import { env } from '../_shared/env.ts';

type Kind = 'ticket' | 'resale' | 'cart' | 'premium' | 'boost' | 'campaign' | 'portal';

/**
 * Who is buying, when nobody is signed in.
 *
 * Exactly what a ticket needs: the name to print on it, the address to send it
 * to, and the town they come from — which is not a formality, it is the dot on
 * the organizer's map and the reason they know which city to advertise in next.
 */
interface Guest {
  name?: string;
  email?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
}

interface Body {
  kind?: Kind;
  // resale
  reservation_id?: string;
  guest?: Guest;
  return_url?: string;
  // ticket
  ticket_type_id?: string;
  quantity?: number;
  promo_code?: string | null;
  // premium
  plan?: 'monthly' | 'yearly';
  // boost
  event_id?: string;
  package_code?: string;
  // campaign
  budget_cents?: number;
  days?: number;
  placements?: string[];
  radius_m?: number;
  categories?: string[];
}

/**
 * Only paths on our own origin are accepted as return targets. A `return_url`
 * echoed straight into a redirect is an open redirect, and an open redirect on
 * a page that has just taken money is a phishing kit.
 */
function safeReturn(path: string | undefined, fallback: string): string {
  const base = env.appUrl().replace(/\/+$/, '');
  if (!path) return `${base}${fallback}`;
  if (!path.startsWith('/') || path.startsWith('//')) return `${base}${fallback}`;
  return `${base}${path}`;
}

/** One Stripe customer per person, so cards and history stay together. */
async function customerFor(
  db: ReturnType<typeof adminClient>,
  user: { id: string; email?: string },
): Promise<string> {
  const { data: existing } = await db.rpc('stripe_customer_for', { p_user_id: user.id });
  if (existing) return existing as string;

  const customer = await stripe.createCustomer({ email: user.email, userId: user.id });
  const { error } = await db.rpc('link_stripe_customer', {
    p_user_id: user.id,
    p_customer: customer.id,
  });
  if (error) throw new Error(error.message);

  return customer.id;
}

/**
 * What the browser sent, checked.
 *
 * Refusing early and by name is the difference between "Zadaj e-mail, kam ti
 * má prísť vstupenka" and a failed payment nobody can explain. The town is
 * required for the same reason the name is: a ticket with no name on it and a
 * map with no dot are both worse than asking one more question.
 */
function normaliseGuest(input: Guest | undefined): {
  name: string; email: string; city: string;
  latitude: number | null; longitude: number | null;
} {
  const name = (input?.name ?? '').trim();
  const email = (input?.email ?? '').trim().toLowerCase();
  const city = (input?.city ?? '').trim();

  if (name.length < 2) {
    throw new ApiError('GUEST_NAME_REQUIRED', 'Napíš meno, na ktoré má vstupenka znieť.', 400);
  }
  // Deliberately loose. A regex that tries to be clever about addresses rejects
  // real ones; what has to be true is that it could be delivered.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
    throw new ApiError('GUEST_EMAIL_INVALID', 'Skontroluj e-mail — vstupenka príde naň.', 400);
  }
  if (city.length < 2) {
    throw new ApiError('GUEST_CITY_REQUIRED', 'Napíš mesto, odkiaľ prídeš.', 400);
  }

  const latitude = Number(input?.latitude);
  const longitude = Number(input?.longitude);
  const hasPoint = Number.isFinite(latitude) && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;

  return {
    name: name.slice(0, 120),
    email,
    city: city.slice(0, 80),
    latitude: hasPoint ? latitude : null,
    longitude: hasPoint ? longitude : null,
  };
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    if (req.method !== 'POST') throw new ApiError('METHOD_NOT_ALLOWED', 'Use POST', 405);

    const body = await readJson<Body>(req);
    const kind = body.kind;
    const db = adminClient();

    // Buying a single ticket is the one thing that works without an account.
    // Everything else here — a basket, a subscription, a boost, the billing
    // portal — belongs to somebody, so it still demands a session.
    const signedIn = await optionalUser(req);
    const guest = kind === 'ticket' && !signedIn ? normaliseGuest(body.guest) : null;
    const user = guest ? null : await requireUser(req);

    rateLimit(`web-checkout:${user?.id ?? guest?.email ?? 'anon'}`, 12, 60_000);

    if (kind === 'resale') {
      // Nákup na burze. Rovnaká cesta ako pri vstupenke — hostovaný Checkout,
      // karta sa nikdy nedotkne našej domény — ale s dvoma rozdielmi, ktoré
      // sú celý zmysel burzy:
      //
      //   Žiadny `connectedAccountId` a žiadny `applicationFeeCents`. Peniaze
      //   pristanú na účte platformy a držia sa tam, kým predajcovi nevznikne
      //   nárok. Keby pristali priamo uňho, nemali by sme čo vrátiť, a sľub
      //   „vrátime ti peniaze" by bol prázdny.
      //
      //   Metadata nesú `resale_order_id`, nie `order_id`. S obyčajným
      //   `order_id` by webhook objednávku poslal do `fulfill_order` a vydal
      //   by úplne novú vstupenku na event.
      if (!signedIn || !user) {
        throw new ApiError('UNAUTHENTICATED', 'Na burze sa nakupuje na účet', 401);
      }
      if (!body.reservation_id) {
        throw new ApiError('INVALID_BODY', 'reservation_id is required');
      }

      const { data: created, error: orderError } = await db
        .rpc('create_resale_order', { p_reservation_id: body.reservation_id })
        .single();
      if (orderError || !created) {
        throw new ApiError('RESALE_ORDER_FAILED',
          orderError?.message ?? 'Objednávku sa nepodarilo založiť', 400);
      }
      const order = created as {
        id: string; event_id: string; buyer_id: string; seller_id: string;
        total_cents: number; currency: string; quantity: number; source: string;
      };

      if (order.buyer_id !== user.id) {
        throw new ApiError('FORBIDDEN', 'Táto objednávka nie je tvoja', 403);
      }
      if (order.total_cents <= 0) {
        throw new ApiError('INVALID_PRICE', 'Nulová suma sa na burze neplatí', 400);
      }

      const { data: resaleEvent } = await db
        .from('events').select('title').eq('id', order.event_id).single();

      const session = await stripe.createCheckoutSession({
        mode: 'payment',
        amountCents: order.total_cents,
        currency: order.currency,
        productName: resaleEvent?.title ?? 'Vstupenka z burzy',
        productDescription: order.source === 'blup'
          ? `${order.quantity}× vstupenka — overená, prevedieme ju na teba`
          : `${order.quantity}× vstupenka z inej platformy — peniaze držíme do potvrdenia`,
        applicationFeeCents: 0,
        connectedAccountId: null,
        descriptor: resaleEvent?.title ?? null,
        customerId: await customerFor(db, user),
        customerEmail: null,
        clientReferenceId: order.id,
        metadata: {
          resale_order_id: order.id,
          buyer_id: user.id,
          seller_id: order.seller_id,
          event_id: order.event_id,
          platform: 'blup_web',
        },
        successUrl: safeReturn(
          `/checkout/return?resale=${order.id}&session={CHECKOUT_SESSION_ID}`,
          '/tickets',
        ),
        cancelUrl: safeReturn(`/resale/${order.event_id}`, '/'),
        idempotencyKey: `cs_resale_${order.id}`,
      });

      await db.from('resale_orders').update({
        provider: 'stripe',
        provider_reference: session.id,
        payment_status: 'processing',
      }).eq('id', order.id);

      return json({
        kind, order_id: order.id, status: 'requires_payment', requires_payment: true,
        redirect_url: session.url,
        amount_cents: order.total_cents,
        currency: order.currency,
      });
    }

    if (kind === 'ticket') {
      const quantity = Number(body.quantity);
      if (!body.ticket_type_id || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
        throw new ApiError('INVALID_BODY', 'ticket_type_id and a quantity of 1–50 are required');
      }

      // Same function the native path uses: availability, sales window,
      // capacity, discount and both fees are decided here, not by the browser.
      // A guest changes who the order belongs to and nothing about what it
      // costs — the two are asserted equal to the cent in test 31.
      const { data: created, error } = await db
        .rpc('create_order', {
          p_buyer_id: user?.id ?? null,
          p_ticket_type_id: body.ticket_type_id,
          p_quantity: quantity,
          p_promo_code: typeof body.promo_code === 'string' ? body.promo_code.trim() : null,
          p_guest_email: guest?.email ?? null,
          p_guest_name: guest?.name ?? null,
          p_buyer_city: guest?.city ?? null,
          p_buyer_latitude: guest?.latitude ?? null,
          p_buyer_longitude: guest?.longitude ?? null,
        })
        .single();

      if (error || !created) throw new Error(error?.message ?? 'ORDER_CREATION_FAILED');
      const order = created as OrderRow;

      // A fully discounted or free basket needs no payment provider at all.
      if (order.total_cents === 0) {
        const { error: fulfilError } = await db.rpc('fulfill_order', {
          p_order_id: order.id,
          p_provider: 'manual',
          p_provider_reference: `free_${order.id}`,
          p_amount_cents: 0,
        });
        if (fulfilError) throw new Error(fulfilError.message);

        // A guest has no "my tickets" to be sent to, so the return link carries
        // the claim token — the only thing that lets that page show the QR.
        return json({
          kind, order_id: order.id, status: 'succeeded', requires_payment: false,
          claim_token: order.claim_token ?? null,
          redirect_url: safeReturn(
            order.claim_token
              ? `/checkout/return?order=${order.id}&token=${order.claim_token}`
              : `/checkout/return?order=${order.id}`,
            '/tickets',
          ),
        });
      }

      const { data: event } = await db
        .from('events').select('title').eq('id', order.event_id).single();
      const { data: org } = await db
        .from('organizations').select('stripe_account_id, charges_enabled')
        .eq('id', order.organization_id).single();

      const session = await stripe.createCheckoutSession({
        mode: 'payment',
        amountCents: order.total_cents,
        currency: order.currency,
        productName: event?.title ?? 'Vstupenka',
        productDescription: order.archive_fee_cents > 0
          ? `${order.quantity}× vstupenka vrátane archívneho poplatku`
          : `${order.quantity}× vstupenka`,
        // What BLUP keeps out of this charge: commission plus archive fee.
        applicationFeeCents: order.blup_revenue_cents,
        connectedAccountId: org?.charges_enabled ? org.stripe_account_id : null,
        // The event's own name on the card statement. An unrecognised line is
        // where a large share of disputes begin.
        descriptor: event?.title ?? null,
        // A guest gets no Stripe customer: a customer record is for somebody
        // who comes back, and there is no account to attach it to. Stripe still
        // has the address for the receipt.
        customerId: user ? await customerFor(db, user) : null,
        customerEmail: guest?.email ?? null,
        clientReferenceId: order.id,
        metadata: {
          order_id: order.id,
          buyer_id: user?.id ?? '',
          guest_email: guest?.email ?? '',
          event_id: order.event_id,
          platform: 'blup_web',
        },
        successUrl: safeReturn(
          order.claim_token
            ? `/checkout/return?order=${order.id}&token=${order.claim_token}&session={CHECKOUT_SESSION_ID}`
            : `/checkout/return?order=${order.id}&session={CHECKOUT_SESSION_ID}`,
          '/tickets',
        ),
        cancelUrl: safeReturn(`/event/${order.event_id}`, '/'),
        idempotencyKey: `cs_order_${order.id}`,
      });

      await db.from('orders').update({
        provider: 'stripe',
        provider_reference: session.id,
        payment_status: 'processing',
      }).eq('id', order.id);

      return json({
        kind, order_id: order.id, status: 'requires_payment', requires_payment: true,
        redirect_url: session.url,
        amount_cents: order.total_cents,
        archive_fee_cents: order.archive_fee_cents,
        currency: order.currency,
        claim_token: order.claim_token ?? null,
      });
    }

    // Everything below here belongs to somebody. `guest` is only ever set on the
    // single-ticket path above, so requireUser() has already run and thrown for
    // anybody without a session — this line is what says so out loud, to the
    // type checker and to the next reader. If the invariant ever changes it
    // becomes a clean 401 instead of reading `.id` off null.
    if (!user) throw new ApiError('AUTH_REQUIRED', 'Na toto sa treba prihlásiť.', 401);

    if (kind === 'cart') {
      // Everything about the basket — which tickets, how many, whether the
      // reservations are still alive, the discount split and both fees — is
      // decided by create_checkout() against rows the browser cannot write.
      // This function only learns the total afterwards.
      const { data: startedCheckout, error } = await db
        .rpc('create_checkout', {
          p_buyer_id: user.id,
          p_promo_code: typeof body.promo_code === 'string' ? body.promo_code.trim() : null,
        })
        .single();

      if (error || !startedCheckout) throw new Error(error?.message ?? 'CHECKOUT_FAILED');
      const checkout = startedCheckout as CheckoutRow;

      const { data: orders } = await db
        .from('orders')
        .select('id, quantity, unit_price_cents, total_cents, archive_fee_cents, ticket_types(name)')
        .eq('checkout_id', checkout.id)
        .order('created_at');

      // A basket that costs nothing (fully discounted, or free tickets with no
      // archive fee) needs no card at all.
      if (checkout.total_cents === 0) {
        const { error: fulfilError } = await db.rpc('fulfill_checkout', {
          p_checkout_id: checkout.id,
          p_provider: 'manual',
          p_provider_reference: `free_${checkout.id}`,
          p_amount_cents: 0,
        });
        if (fulfilError) throw new Error(fulfilError.message);

        return json({
          kind, checkout_id: checkout.id, status: 'succeeded', requires_payment: false,
          redirect_url: safeReturn(`/checkout/return?checkout=${checkout.id}`, '/tickets'),
        });
      }

      const { data: event } = await db
        .from('events').select('title').eq('id', checkout.event_id).single();
      const { data: org } = await db
        .from('organizations').select('stripe_account_id, charges_enabled')
        .eq('id', checkout.organization_id).single();

      const archivePerTicket = checkout.quantity > 0
        ? Math.round(checkout.archive_fee_cents / checkout.quantity)
        : 0;

      // Stripe has no negative line, so a discounted basket is charged as one
      // line for the real total rather than as lines that do not add up.
      const lineItems = checkout.discount_cents > 0
        ? [{
            name: event?.title ?? 'Vstupenky',
            description: `${checkout.quantity}× vstupenka po zľave`,
            unitAmountCents: checkout.total_cents,
            quantity: 1,
          }]
        : [
            ...(orders ?? []).map((order) => ({
              name: `${event?.title ?? 'Vstupenka'} — ${
                (order.ticket_types as { name?: string } | null)?.name ?? 'Vstupenka'
              }`,
              unitAmountCents: order.unit_price_cents as number,
              quantity: order.quantity as number,
            })),
            ...(checkout.archive_fee_cents > 0
              ? [{
                  name: 'Archívny poplatok',
                  description: 'Uchovanie vstupenky a jej overenie pri vstupe',
                  unitAmountCents: archivePerTicket,
                  quantity: checkout.quantity as number,
                }]
              : []),
          ];

      const session = await stripe.createCheckoutSession({
        mode: 'payment',
        amountCents: checkout.total_cents,
        currency: checkout.currency,
        lineItems,
        applicationFeeCents: checkout.commission_cents + checkout.archive_fee_cents,
        connectedAccountId: org?.charges_enabled ? org.stripe_account_id : null,
        customerId: await customerFor(db, user),
        clientReferenceId: checkout.id,
        metadata: {
          checkout_id: checkout.id,
          buyer_id: user.id,
          event_id: checkout.event_id,
          platform: 'blup_web',
        },
        successUrl: safeReturn(
          `/checkout/return?checkout=${checkout.id}&session={CHECKOUT_SESSION_ID}`,
          '/tickets',
        ),
        cancelUrl: safeReturn(`/event/${checkout.event_id}`, '/'),
        idempotencyKey: `cs_checkout_${checkout.id}`,
      });

      await db.from('checkouts').update({
        provider: 'stripe',
        provider_reference: session.id,
      }).eq('id', checkout.id);

      await db.from('orders').update({ payment_status: 'processing' })
        .eq('checkout_id', checkout.id);

      return json({
        kind, checkout_id: checkout.id, status: 'requires_payment', requires_payment: true,
        redirect_url: session.url,
        amount_cents: checkout.total_cents,
        archive_fee_cents: checkout.archive_fee_cents,
        currency: checkout.currency,
      });
    }

    if (kind === 'premium') {
      const plan = body.plan === 'yearly' ? 'yearly' : 'monthly';
      const priceId = plan === 'yearly' ? env.stripePremiumYearly() : env.stripePremiumMonthly();

      const session = await stripe.createCheckoutSession({
        mode: 'subscription',
        priceId,
        customerId: await customerFor(db, user),
        clientReferenceId: user.id,
        metadata: { user_id: user.id, plan, platform: 'blup_web' },
        successUrl: safeReturn('/premium?welcome=1', '/premium'),
        cancelUrl: safeReturn('/premium', '/premium'),
      });

      return json({ kind, plan, redirect_url: session.url });
    }

    if (kind === 'boost') {
      if (!body.event_id || !body.package_code) {
        throw new ApiError('INVALID_BODY', 'event_id and package_code are required');
      }

      // create_boost_order() checks that this user may promote this event, and
      // it does that with auth.uid() — so it runs under the caller's JWT.
      const { data: createdBoost, error } = await userClient(req)
        .rpc('create_boost_order', {
          p_event: body.event_id,
          p_package: body.package_code,
        })
        .single();

      if (error || !createdBoost) throw new Error(error?.message ?? 'BOOST_ORDER_FAILED');
      const boost = createdBoost as BoostRow;

      const session = await stripe.createCheckoutSession({
        mode: 'payment',
        amountCents: boost.amount_cents,
        currency: boost.currency,
        productName: 'Boost eventu',
        productDescription: body.package_code,
        // Boost revenue is BLUP's, so there is no connected account and no
        // application fee — the whole charge stays on the platform.
        customerId: await customerFor(db, user),
        clientReferenceId: boost.id,
        metadata: { boost_id: boost.id, buyer_id: user.id, event_id: body.event_id, platform: 'blup_web' },
        successUrl: safeReturn(`/organizer/promo/${body.event_id}?boost=1`, '/organizer'),
        cancelUrl: safeReturn(`/organizer/promo/${body.event_id}`, '/organizer'),
        idempotencyKey: `cs_boost_${boost.id}`,
      });

      return json({ kind, boost_id: boost.id, redirect_url: session.url });
    }

    // A campaign is the same money on the same rails as a boost — the only
    // difference is that the database prices it from a budget instead of a
    // package. It matters that this exists at all: on the web there is no
    // native payment sheet, so a campaign created through boost-create would
    // sit at `requires_payment` forever and the button would be a lie.
    if (kind === 'campaign') {
      if (!body.event_id || typeof body.budget_cents !== 'number') {
        throw new ApiError('INVALID_BODY', 'event_id and budget_cents are required');
      }

      // create_ad_campaign() authorizes on auth.uid() and computes the price,
      // the impression budget and the auction weight itself — so it runs under
      // the caller's JWT and nothing here can choose what a campaign costs.
      const { data: created, error } = await userClient(req)
        .rpc('create_ad_campaign', {
          p_event: body.event_id,
          p_budget_cents: Math.round(body.budget_cents),
          p_days: body.days ?? 7,
          p_placements: body.placements ?? ['feed'],
          p_radius_m: body.radius_m ?? 30000,
          p_categories: body.categories?.length ? body.categories : null,
        })
        .single();

      if (error || !created) throw new Error(error?.message ?? 'CAMPAIGN_FAILED');
      const boost = created as BoostRow;

      const session = await stripe.createCheckoutSession({
        mode: 'payment',
        amountCents: boost.amount_cents,
        currency: boost.currency,
        productName: 'Reklamná kampaň',
        productDescription: `${boost.impression_budget} zobrazení`,
        customerId: await customerFor(db, user),
        clientReferenceId: boost.id,
        metadata: {
          boost_id: boost.id, buyer_id: user.id, event_id: body.event_id,
          platform: 'blup_web',
        },
        successUrl: safeReturn(`/organizer/ads/${body.event_id}?paid=1`, '/organizer'),
        cancelUrl: safeReturn(`/organizer/ads/${body.event_id}`, '/organizer'),
        idempotencyKey: `cs_campaign_${boost.id}`,
      });

      return json({ kind, boost_id: boost.id, redirect_url: session.url });
    }

    if (kind === 'portal') {
      const { data: customerId } = await db.rpc('stripe_customer_for', { p_user_id: user.id });
      if (!customerId) {
        throw new ApiError('NO_BILLING_ACCOUNT', 'Cez web si zatiaľ nič nepredplatil.', 404);
      }

      // Cancelling and changing a card happen on Stripe's page rather than
      // ours: rebuilding dunning, proration and tax display is a good way to
      // get all three subtly wrong.
      const session = await stripe.createBillingPortalSession({
        customerId: customerId as string,
        returnUrl: safeReturn(body.return_url, '/premium'),
      });

      return json({ kind, redirect_url: session.url });
    }

    throw new ApiError(
      'INVALID_BODY',
      "kind must be 'ticket', 'cart', 'premium', 'boost' or 'portal'",
    );
  } catch (error) {
    return errorResponse(error);
  }
});
