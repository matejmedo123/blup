import { supabase } from '@/lib/supabase';

/**
 * The basket.
 *
 * Every function here is a single RPC, because a basket line is a *reservation*
 * and reservations are decided by the database: how many are left, whether the
 * hold is still alive, what the whole thing costs with both fees. The client
 * holds no state of its own beyond what the last call returned — refresh the
 * page mid-purchase and the basket, and its remaining seconds, are still there.
 */

export interface CartLine {
  ticket_type_id: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
  max_per_order: number;
  /** Still buyable by *this* shopper, i.e. excluding their own hold. */
  available: number;
  currency: string;
}

export interface CartLimits {
  max_tickets_per_order: number;
  hold_minutes: number;
}

export interface Cart {
  event: {
    id: string;
    title: string;
    start_at: string;
    venue_name: string | null;
    city: string | null;
    cover_image_url: string | null;
  } | null;
  lines: CartLine[];
  quantity: number;
  subtotal_cents: number;
  discount_cents: number;
  promo_error: string | null;
  archive_fee_cents: number;
  commission_cents: number;
  total_cents: number;
  currency: string;
  expires_at: string | null;
  seconds_left: number;
  limits: CartLimits;
}

const EMPTY: Cart = {
  event: null,
  lines: [],
  quantity: 0,
  subtotal_cents: 0,
  discount_cents: 0,
  promo_error: null,
  archive_fee_cents: 0,
  commission_cents: 0,
  total_cents: 0,
  currency: 'EUR',
  expires_at: null,
  seconds_left: 0,
  limits: { max_tickets_per_order: 20, hold_minutes: 15 },
};

function normalise(data: unknown): Cart {
  return { ...EMPTY, ...(data as Partial<Cart> | null) };
}

export async function getCart(promoCode?: string | null): Promise<Cart> {
  const { data, error } = await supabase.rpc('cart_view', {
    p_promo_code: promoCode?.trim() || null,
  });
  if (error) throw error;
  return normalise(data);
}

/** Adds to what is already reserved and restarts the hold on the whole basket. */
export async function addToCart(ticketTypeId: string, quantity = 1): Promise<Cart> {
  const { data, error } = await supabase.rpc('cart_add', {
    p_ticket_type_id: ticketTypeId,
    p_quantity: quantity,
  });
  if (error) throw error;
  return normalise(data);
}

export async function setCartQuantity(ticketTypeId: string, quantity: number): Promise<Cart> {
  const { data, error } = await supabase.rpc('cart_set_quantity', {
    p_ticket_type_id: ticketTypeId,
    p_quantity: quantity,
  });
  if (error) throw error;
  return normalise(data);
}

export async function removeFromCart(ticketTypeId: string): Promise<Cart> {
  const { data, error } = await supabase.rpc('cart_remove', { p_ticket_type_id: ticketTypeId });
  if (error) throw error;
  return normalise(data);
}

export async function clearCart(): Promise<Cart> {
  const { data, error } = await supabase.rpc('cart_clear');
  if (error) throw error;
  return normalise(data);
}

export interface Availability {
  quantity_total: number;
  quantity_sold: number;
  held: number;
  available: number;
}

/** What is genuinely left: sold, plus everybody's live reservations, taken off. */
export async function getAvailability(ticketTypeId: string): Promise<Availability | null> {
  const { data, error } = await supabase
    .rpc('ticket_type_availability', { p_ticket_type_id: ticketTypeId })
    .maybeSingle();
  if (error) throw error;
  return (data as Availability) ?? null;
}
