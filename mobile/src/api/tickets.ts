import { callFunction, supabase } from '@/lib/supabase';
import type { Order, Ticket, TicketWithEvent } from '@/types/models';
import { recordSignal } from './signals';

/**
 * Ticketing API.
 *
 * The app never computes a price and never marks anything paid — it asks the
 * checkout function for a payment intent and waits for the webhook to issue the
 * ticket. See PAYMENTS.md for the full flow.
 */

export interface CheckoutSession {
  order_id: string;
  status: 'requires_payment' | 'succeeded';
  requires_payment: boolean;
  payment_intent_client_secret?: string;
  /** What the buyer is charged: tickets after discount, plus the archive fee. */
  amount_cents: number;
  subtotal_cents?: number;
  discount_cents?: number;
  net_cents?: number;
  archive_fee_cents?: number;
  archive_fee_payer?: 'buyer' | 'organizer';
  commission_cents?: number;
  /** What is deducted from the organizer — not the same as BLUP's revenue. */
  platform_fee_cents?: number;
  currency: string;
  quantity?: number;
  split_at_source?: boolean;
}

/**
 * The priced basket, exactly as the database will charge it.
 *
 * `valid: false` carries a `reason` instead of throwing — a sold-out ticket or
 * a mistyped promo code is a normal thing for a person to run into, not an
 * exceptional one.
 */
export interface OrderQuote {
  valid: boolean;
  reason?: string | null;
  quantity: number;
  unit_price_cents: number;
  subtotal_cents: number;
  discount_cents: number;
  /** Ticket revenue after any discount — what the organizer's sale is worth. */
  net_cents: number;
  archive_fee_cents: number;
  archive_fee_payer: 'buyer' | 'organizer';
  commission_cents: number;
  platform_fee_bps: number;
  /** The number on the pay button. */
  buyer_total_cents: number;
  organizer_net_cents: number;
  blup_revenue_cents: number;
  currency: string;
  promo?: PromoPreview | null;
}

/**
 * Prices a basket without creating anything. The same function `create_order`
 * uses, so the breakdown on the checkout screen and the amount that reaches the
 * card cannot drift apart — the app adds nothing of its own.
 */
export async function quoteOrder(
  ticketTypeId: string,
  quantity: number,
  promoCode?: string | null,
): Promise<OrderQuote> {
  const { data, error } = await supabase.rpc('quote_order', {
    p_ticket_type_id: ticketTypeId,
    p_quantity: quantity,
    p_promo_code: promoCode?.trim() || null,
  });

  if (error) throw error;
  return data as OrderQuote;
}

/** Step 1 of checkout: create the order and get a payment intent. */
export async function createCheckout(
  ticketTypeId: string,
  quantity: number,
  promoCode?: string | null,
): Promise<CheckoutSession> {
  return callFunction<CheckoutSession>('checkout-create', {
    ticket_type_id: ticketTypeId,
    quantity,
    promo_code: promoCode?.trim() || null,
  });
}

export interface PromoPreview {
  valid: boolean;
  reason?: string;
  amount_off: number;
  total_after?: number;
  kind?: 'percent' | 'fixed';
  value?: number;
}

/**
 * Previews what a promo code is worth. The same database function computes the
 * real discount at order time, so the preview and the charge cannot disagree.
 */
export async function previewPromoCode(
  eventId: string,
  code: string,
  subtotalCents: number,
): Promise<PromoPreview> {
  const { data, error } = await supabase.rpc('evaluate_promo_code', {
    p_event: eventId,
    p_code: code.trim(),
    p_subtotal: subtotalCents,
  });

  if (error) throw error;
  return data as PromoPreview;
}

/**
 * Step 3 of checkout: after Stripe confirms on-device, poll for the tickets the
 * webhook creates. The webhook is the source of truth, so we wait for it rather
 * than trusting the client-side "success".
 */
export async function waitForTickets(
  orderId: string,
  { attempts = 12, intervalMs = 1000 }: { attempts?: number; intervalMs?: number } = {},
): Promise<{ status: 'succeeded' | 'pending' | 'failed'; tickets: Ticket[] }> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { data: order } = await supabase
      .from('orders')
      .select('payment_status')
      .eq('id', orderId)
      .maybeSingle();

    if (order?.payment_status === 'succeeded') {
      const { data: tickets } = await supabase.from('tickets').select('*').eq('order_id', orderId);
      return { status: 'succeeded', tickets: (tickets ?? []) as Ticket[] };
    }

    if (order?.payment_status === 'failed' || order?.payment_status === 'cancelled') {
      return { status: 'failed', tickets: [] };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  // Not an error: the webhook can lag. The ticket will appear in "My tickets".
  return { status: 'pending', tickets: [] };
}

/**
 * Same wait, for a basket. A checkout is `paid` only once every order inside it
 * has been fulfilled, so watching the envelope is enough.
 */
export async function waitForCheckout(
  checkoutId: string,
  { attempts = 12, intervalMs = 1000 }: { attempts?: number; intervalMs?: number } = {},
): Promise<{ status: 'succeeded' | 'pending' | 'failed'; tickets: Ticket[] }> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { data: checkout } = await supabase
      .from('checkouts')
      .select('status')
      .eq('id', checkoutId)
      .maybeSingle();

    if (checkout?.status === 'paid') {
      const { data: orders } = await supabase
        .from('orders').select('id').eq('checkout_id', checkoutId);

      const ids = (orders ?? []).map((order) => order.id as string);
      const { data: tickets } = ids.length
        ? await supabase.from('tickets').select('*').in('order_id', ids)
        : { data: [] };

      return { status: 'succeeded', tickets: (tickets ?? []) as Ticket[] };
    }

    if (checkout?.status === 'failed' || checkout?.status === 'cancelled'
        || checkout?.status === 'expired') {
      return { status: 'failed', tickets: [] };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return { status: 'pending', tickets: [] };
}

/**
 * A ticket, its event, and — for the rare event sold by seat — where to sit.
 *
 * The seat is embedded rather than fetched separately: venue_seats and
 * venue_sections are readable by anyone (a plan is what a buyer picks from), and
 * a second round trip per ticket for a row and a number is not worth it.
 */
const TICKET_SELECT =
  '*, event:events (id, title, start_at, venue_name, address, cover_image_url), '
  + 'seat:venue_seats (row_label, seat_number, kind, note, venue_section:venue_sections (name))';

export async function getMyTickets(): Promise<TicketWithEvent[]> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return [];

  const { data, error } = await supabase
    .from('tickets')
    .select(TICKET_SELECT)
    .eq('buyer_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as unknown as TicketWithEvent[];
}

export async function getTicket(ticketId: string): Promise<TicketWithEvent | null> {
  const { data, error } = await supabase
    .from('tickets')
    .select(TICKET_SELECT)
    .eq('id', ticketId)
    .maybeSingle();

  if (error) throw error;
  return (data as unknown as TicketWithEvent) ?? null;
}

export async function getMyOrders(): Promise<Order[]> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return [];

  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('buyer_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as Order[];
}

/**
 * The QR payload. It carries the ticket code plus its server-side secret; the
 * secret is meaningless without check_in_ticket(), which also verifies that the
 * scanner runs the event. Nothing here can be forged offline.
 */
export function ticketQrPayload(ticket: Pick<Ticket, 'code' | 'qr_secret'>): string {
  return `blup://t/${ticket.code}/${ticket.qr_secret}`;
}

export function parseTicketQr(payload: string): { code: string; secret: string } | null {
  const match = payload.match(/^blup:\/\/t\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return { code: match[1], secret: match[2] };
}

export interface CheckInResult {
  ok: boolean;
  reason?: string;
  ticket_id?: string;
  event_id?: string;
  event_title?: string;
  buyer_id?: string;
  checked_in_at?: string;
}

/** Door scanning. All validation happens in the database. */
export async function checkInTicket(
  code: string,
  secret: string,
  eventId?: string,
): Promise<CheckInResult> {
  const { data, error } = await supabase.rpc('check_in_ticket', {
    p_code: code,
    p_qr_secret: secret,
    p_event_id: eventId ?? null,
  });

  if (error) throw error;
  return data as CheckInResult;
}

export async function markTicketPurchaseSignal(eventId: string): Promise<void> {
  await recordSignal(eventId, 'ticket_purchase', {}, 2);
}

// --- delivery by email -------------------------------------------------------

/**
 * Where this account's tickets are emailed. Null means the address is unknown,
 * which the UI must say out loud rather than silently sending nothing anywhere.
 */
export async function getTicketEmail(): Promise<string | null> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return null;

  const { data, error } = await supabase.rpc('ticket_email_for', { p_user_id: userId });
  if (error) throw error;
  return (data as string | null) ?? null;
}

/** Sets (or, with null, clears) the address tickets are delivered to. */
export async function setTicketEmail(email: string | null): Promise<string | null> {
  const { data, error } = await supabase.rpc('set_ticket_email', { p_email: email });
  if (error) throw error;
  return (data as string | null) ?? null;
}

export interface TicketEmailDelivery {
  id: string;
  to_email: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
}

/** The delivery record for an order, so the app can say what actually happened. */
export async function getTicketEmailStatus(orderId: string): Promise<TicketEmailDelivery | null> {
  const { data, error } = await supabase
    .from('email_deliveries')
    .select('id, to_email, status, attempts, last_error, sent_at')
    .eq('order_id', orderId)
    .eq('kind', 'ticket')
    .maybeSingle();

  if (error) throw error;
  return (data as TicketEmailDelivery) ?? null;
}

/**
 * Sends the ticket again, optionally somewhere else.
 *
 * The queue is reset by the database and the send itself happens in the Edge
 * Function, so a slow mail provider cannot leave the button spinning — the
 * response says the delivery was accepted, not that it has landed.
 */
export async function resendTicketEmail(
  orderId: string,
  email?: string | null,
): Promise<TicketEmailDelivery> {
  const { data, error } = await supabase.rpc('resend_ticket_email', {
    p_order_id: orderId,
    p_email: email?.trim() || null,
  });
  if (error) throw error;

  // Nudge the sender so it goes out now rather than on the next cron sweep.
  // A failure here is not a failure of the request: the row is queued either
  // way, which is exactly why the queue exists.
  try {
    await callFunction('ticket-email', { order_id: orderId });
  } catch {
    // ignore — the sweep will pick it up
  }

  return data as TicketEmailDelivery;
}

// --- guest tickets -----------------------------------------------------------

export interface ClaimResult {
  ok: boolean;
  reason: 'ALREADY_YOURS' | 'ALREADY_CLAIMED' | null;
  event_id: string | null;
  tickets: number;
}

/**
 * The link in a guest ticket e-mail.
 *
 * Whoever holds the e-mail holds the ticket — the same thing the QR code
 * already assumes — so the token is the proof. It is spent on use, so a
 * forwarded e-mail cannot hand the same ticket to a second person.
 */
export async function claimTicketsWithToken(token: string): Promise<ClaimResult> {
  const { data, error } = await supabase.rpc('claim_tickets_with_token', { p_token: token });
  if (error) throw error;
  return data as ClaimResult;
}

/**
 * Everything sent to the address I signed up with. Called after sign-in; an
 * order that already has an owner is left alone, so calling it often is fine.
 */
export async function claimMyGuestTickets(): Promise<number> {
  const { data, error } = await supabase.rpc('claim_my_guest_tickets');
  if (error) throw error;
  return (data as number) ?? 0;
}

// --- a ticket with no account behind it -------------------------------------

/**
 * What a guest bought, read with the token instead of a session.
 *
 * There is no row-level path to it: a guest order has no `buyer_id` for RLS to
 * match, so the database answers through `guest_order_status`, which requires
 * the claim token that only this browser and the e-mail have. Without the token
 * it refuses — which is the whole security model here, so it is worth saying
 * plainly rather than leaving to a policy nobody reads.
 */
export interface GuestOrderStatus {
  order_id: string;
  status: 'requires_payment' | 'processing' | 'succeeded' | 'failed' | 'refunded' | 'cancelled';
  quantity: number;
  total_cents: number;
  currency: string;
  guest_email: string | null;
  guest_name: string | null;
  event_title: string | null;
  event_start_at: string | null;
  venue_name: string | null;
  city: string | null;
  tickets: { code: string; qr_secret: string; status: string }[];
}

export async function getGuestOrder(orderId: string, token: string): Promise<GuestOrderStatus> {
  const { data, error } = await supabase.rpc('guest_order_status', {
    p_order_id: orderId,
    p_token: token,
  });
  if (error) throw error;
  return data as GuestOrderStatus;
}

/** The same wait as waitForTickets, for somebody who has no account to wait in. */
export async function waitForGuestOrder(
  orderId: string,
  token: string,
  { attempts = 20, intervalMs = 1200 }: { attempts?: number; intervalMs?: number } = {},
): Promise<{ status: 'succeeded' | 'pending' | 'failed'; order: GuestOrderStatus | null }> {
  let last: GuestOrderStatus | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      last = await getGuestOrder(orderId, token);
    } catch {
      // A wrong token, or an order that is not there. Both are permanent, and
      // retrying twenty times would only make the page look broken for longer.
      return { status: 'failed', order: null };
    }

    if (last.status === 'succeeded') return { status: 'succeeded', order: last };
    if (last.status === 'failed' || last.status === 'cancelled') {
      return { status: 'failed', order: last };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  // Not an error: the webhook can lag, and the e-mail arrives either way.
  return { status: 'pending', order: last };
}
