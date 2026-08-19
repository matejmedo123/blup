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

export async function getMyTickets(): Promise<TicketWithEvent[]> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return [];

  const { data, error } = await supabase
    .from('tickets')
    .select('*, event:events (id, title, start_at, venue_name, address, cover_image_url)')
    .eq('buyer_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as unknown as TicketWithEvent[];
}

export async function getTicket(ticketId: string): Promise<TicketWithEvent | null> {
  const { data, error } = await supabase
    .from('tickets')
    .select('*, event:events (id, title, start_at, venue_name, address, cover_image_url)')
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
