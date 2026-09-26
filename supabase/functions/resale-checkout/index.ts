/**
 * POST /functions/v1/resale-checkout
 *
 * Spustí nákup vstupenky na burze. Klient posiela LEN `reservation_id` —
 * žiadnu sumu. Cenu aj poplatky spočítala databáza (`quote_resale`) pri
 * zakladaní objednávky, takže podvrhnutý klient nemá čo poslať inak.
 *
 * Dve veci, v ktorých sa toto zámerne líši od primárneho predaja:
 *
 *   ŽIADNY destination charge. Pri predaji od organizátora ide provízia
 *   Stripu rovno pri platbe a zvyšok pristane na jeho účte. Tu to tak byť
 *   nesmie: predajca dostane peniaze až po evente a pri vstupenke z inej
 *   platformy až keď kupujúci potvrdí, že fungovala. Keby platba pristála
 *   priamo u predajcu, nemali by sme čo držať a „vrátime ti peniaze" by bol
 *   prázdny sľub. Peniaze preto prídu na účet platformy a predajcovi sa
 *   posielajú samostatným prevodom, keď naň vznikne nárok.
 *
 *   ŽIADNE potvrdenie z frontendu. Objednávka zostáva `payment_pending`, kým
 *   webhook s overeným podpisom nepovie, že peniaze naozaj prišli.
 */
import {
  ApiError, adminClient, errorResponse, handleOptions, json, rateLimit, readJson, requireUser,
} from '../_shared/http.ts';
import { stripe } from '../_shared/stripe.ts';

interface ResaleCheckoutRequest {
  reservation_id: string;
}

interface ResaleOrderRow {
  id: string;
  event_id: string;
  buyer_id: string;
  seller_id: string;
  source: 'blup' | 'external';
  quantity: number;
  ticket_price_cents: number;
  buyer_fee_cents: number;
  delivery_fee_cents: number;
  total_cents: number;
  seller_fee_cents: number;
  seller_net_cents: number;
  currency: string;
  order_status: string;
  provider_reference: string | null;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    if (req.method !== 'POST') {
      throw new ApiError('METHOD_NOT_ALLOWED', 'Use POST', 405);
    }

    const user = await requireUser(req);
    rateLimit(`resale-checkout:${user.id}`, 10, 60_000);

    const body = await readJson<ResaleCheckoutRequest>(req);
    if (!body.reservation_id) {
      throw new ApiError('INVALID_BODY', 'reservation_id is required');
    }

    const db = adminClient();

    // 1. Z rezervácie objednávka. Funkcia si sama overí, že rezervácia patrí
    //    tomuto človeku, že ešte platí a že listing je stále k dispozícii —
    //    a cenu vezme z `quote_resale`, nie odtiaľto.
    const { data: created, error: orderError } = await db
      .rpc('create_resale_order', { p_reservation_id: body.reservation_id })
      .single();

    if (orderError || !created) {
      // Kódy z databázy (LISTING_SOLD, RESERVATION_EXPIRED…) idú ďalej tak,
      // ako sú: appka ich vie preložiť do vety pre človeka.
      throw new ApiError(
        codeFrom(orderError?.message) ?? 'RESALE_ORDER_FAILED',
        orderError?.message ?? 'Objednávku sa nepodarilo založiť',
        400,
      );
    }
    const order = created as ResaleOrderRow;

    if (order.buyer_id !== user.id) {
      // Nemalo by nastať — `create_resale_order` kontroluje vlastníctvo
      // rezervácie. Je to poistka proti tomu, aby sa raz zmenená funkcia
      // ticho stala dierou.
      throw new ApiError('FORBIDDEN', 'Táto objednávka nie je tvoja', 403);
    }

    // Objednávka na vstupenku zadarmo na burze nedáva zmysel: predajca by
    // nedostal nič a kupujúci by nemal čo chrániť.
    if (order.total_cents <= 0) {
      throw new ApiError('INVALID_PRICE', 'Nulová suma sa na burze neplatí', 400);
    }

    // Ak už PaymentIntent existuje, vráti sa ten istý. Dvakrát kliknuté
    // „Zaplatiť" nesmie vyrobiť dve platby.
    if (order.provider_reference) {
      const existing = await stripe.retrievePaymentIntent(order.provider_reference);
      if (existing.status !== 'canceled') {
        return json({
          order_id: order.id,
          status: 'requires_payment',
          requires_payment: true,
          payment_intent_client_secret: existing.client_secret,
          ...breakdown(order),
        });
      }
    }

    const { data: event } = await db
      .from('events').select('title').eq('id', order.event_id).single();

    // Vlastná funkcia, nie `createPaymentIntent`. Rozdiel je v metadatách:
    // tie nesú `resale_order_id`, takže webhook pozná, že ide o burzu.
    // S obyčajným `order_id` by objednávku poslal do `fulfill_order` a vydal
    // by úplne novú vstupenku na event.
    const intent = await stripe.createResalePaymentIntent({
      amountCents: order.total_cents,
      currency: order.currency,
      resaleOrderId: order.id,
      buyerId: user.id,
      sellerId: order.seller_id,
      eventId: order.event_id,
      // Meno eventu na výpise z karty. Nerozpoznaný riadok je najčastejší
      // začiatok sporu s bankou.
      descriptor: event?.title ?? null,
      customerEmail: user.email,
    });

    await db
      .from('resale_orders')
      .update({
        provider: 'stripe',
        provider_reference: intent.id,
        payment_status: 'processing',
      })
      .eq('id', order.id);

    return json({
      order_id: order.id,
      status: 'requires_payment',
      requires_payment: true,
      payment_intent_client_secret: intent.client_secret,
      publishable_key_required: true,
      ...breakdown(order),
    });
  } catch (error) {
    return errorResponse(error);
  }
});

/**
 * Rozpis, ktorý appka ukáže. Tie isté čísla, aké sú v objednávke — nie
 * dopočítané znova, lebo druhý výpočet je druhá príležitosť na rozdiel.
 */
function breakdown(order: ResaleOrderRow) {
  return {
    source: order.source,
    authenticity: order.source === 'blup' ? 'verified' : 'protected',
    quantity: order.quantity,
    ticket_price_cents: order.ticket_price_cents,
    buyer_fee_cents: order.buyer_fee_cents,
    delivery_fee_cents: order.delivery_fee_cents,
    amount_cents: order.total_cents,
    currency: order.currency,
  };
}

/** Vytiahne kód z hlásenia databázy, ak ho tam funkcia dala. */
function codeFrom(message?: string | null): string | null {
  if (!message) return null;
  const match = message.match(/\b([A-Z][A-Z_]{3,})\b/);
  return match ? match[1] : null;
}
