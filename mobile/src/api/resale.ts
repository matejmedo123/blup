import { supabase } from '@/lib/supabase';

/**
 * Burza vstupeniek — ďalší predaj medzi dvoma ľuďmi.
 *
 * Jedno pravidlo drží celý modul: appka si o cene ani o pravosti nerozhoduje.
 * Obe čísla aj štítok prichádzajú zo servera (`quote_resale`,
 * `event_resale_listings`) a tu sa len prenesú ďalej. Keby si cenu rátal
 * frontend, stačilo by poslať iné číslo; keby si štítok vyberal frontend,
 * dalo by sa napísať „overené" nad niečím, čo overené nie je.
 */

/**
 * Čo o vstupenke vieme povedať — a čo nie.
 *
 * `verified`  vydal ju BLUP. Pri predaji sa prepíše majiteľ, vygeneruje sa
 *             nový QR a starý prestane platiť. Pravosť vieme podložiť.
 * `protected` je z inej platformy. Do ich databázy nevidíme, takže pravosť
 *             overiť NEVIEME. Držíme peniaze, kým kupujúci nepotvrdí, že
 *             vstupenka funguje — to je ochrana, nie overenie, a tak sa to
 *             aj musí písať.
 */
export type Authenticity = 'verified' | 'protected';

export type ResaleSource = 'blup' | 'external';

export type ResaleDeliveryMethod =
  | 'blup_transfer' | 'file' | 'mobile_transfer' | 'other';

export type ResaleListingStatus =
  | 'draft' | 'active' | 'reserved' | 'sold' | 'cancelled' | 'expired';

export type ResaleOrderStatus =
  | 'created' | 'payment_pending' | 'paid' | 'waiting_for_ticket'
  | 'ticket_delivered' | 'completed' | 'disputed' | 'cancelled' | 'refunded';

export interface ResaleListing {
  id: string;
  seller_id: string;
  seller_name: string | null;
  seller_username: string | null;
  seller_avatar: string | null;
  source: ResaleSource;
  authenticity: Authenticity;
  section: string | null;
  row_label: string | null;
  seat_label: string | null;
  ticket_label: string | null;
  quantity: number;
  price_cents: number;
  face_value_cents: number | null;
  currency: string;
  delivery_method: ResaleDeliveryMethod;
  note: string | null;
  status: ResaleListingStatus;
  created_at: string;
}

export interface ResaleSummary {
  listings: number;
  tickets: number;
  from_cents: number | null;
  verified_count: number;
  currency: string | null;
}

/**
 * Rozpis ceny pre checkout.
 *
 * Kupujúci musí pred zaplatením vidieť všetky tri riadky zvlášť, nie len
 * súčet. Jedno číslo bez rozpisu je presne to, na čo sa ľudia sťažujú pri
 * predaji vstupeniek — a je to aj to, čo im bráni porovnať dve ponuky.
 */
export interface ResaleQuote {
  valid: boolean;
  reason: string | null;
  listing_id: string;
  event_id: string;
  source: ResaleSource;
  authenticity: Authenticity;
  quantity: number;
  unit_price_cents: number;
  ticket_price_cents: number;
  buyer_fee_cents: number;
  delivery_fee_cents: number;
  total_cents: number;
  seller_fee_cents: number;
  seller_net_cents: number;
  currency: string;
  hold_minutes: number;
}

export interface ResaleReservation {
  id: string;
  listing_id: string;
  buyer_id: string;
  quantity: number;
  status: 'active' | 'expired' | 'converted' | 'cancelled';
  expires_at: string;
}

export interface ResaleOrder {
  id: string;
  listing_id: string;
  event_id: string;
  buyer_id: string;
  seller_id: string;
  source: ResaleSource;
  quantity: number;
  ticket_price_cents: number;
  buyer_fee_cents: number;
  delivery_fee_cents: number;
  total_cents: number;
  seller_fee_cents: number;
  seller_net_cents: number;
  currency: string;
  payment_status: string;
  order_status: ResaleOrderStatus;
  expires_at: string;
  paid_at: string | null;
  delivered_at: string | null;
  completed_at: string | null;
}

export interface MyResaleListing {
  id: string;
  event_id: string;
  event_title: string;
  event_start_at: string;
  source: ResaleSource;
  section: string | null;
  row_label: string | null;
  seat_label: string | null;
  quantity: number;
  price_cents: number;
  currency: string;
  status: ResaleListingStatus;
  order_id: string | null;
  order_status: ResaleOrderStatus | null;
  seller_net_cents: number | null;
  created_at: string;
}

export interface SellerBalance {
  seller_id: string;
  currency: string;
  balance_cents: number;
  available_cents: number;
  pending_cents: number;
  sales_cents: number;
  fees_cents: number;
  paid_out_cents: number;
  payouts_enabled: boolean;
}

export type ResaleSort = 'price_asc' | 'price_desc' | 'newest';

// --- čítanie -----------------------------------------------------------------

export async function getEventResaleListings(
  eventId: string,
  options: {
    sort?: ResaleSort;
    maxPrice?: number | null;
    quantity?: number | null;
    source?: ResaleSource | null;
    limit?: number;
  } = {},
): Promise<ResaleListing[]> {
  const { data, error } = await supabase.rpc('event_resale_listings', {
    p_event_id: eventId,
    p_sort: options.sort ?? 'price_asc',
    p_max_price: options.maxPrice ?? null,
    p_quantity: options.quantity ?? null,
    p_source: options.source ?? null,
    p_limit: options.limit ?? 50,
  });
  if (error) throw error;
  return (data ?? []) as ResaleListing[];
}

export async function getEventResaleSummary(eventId: string): Promise<ResaleSummary> {
  const { data, error } = await supabase.rpc('event_resale_summary', {
    p_event_id: eventId,
  });
  if (error) throw error;
  return (data ?? { listings: 0, tickets: 0, from_cents: null, verified_count: 0, currency: null }) as ResaleSummary;
}

export async function getResaleQuote(
  listingId: string,
  quantity = 1,
): Promise<ResaleQuote> {
  const { data, error } = await supabase.rpc('quote_resale', {
    p_listing_id: listingId,
    p_quantity: quantity,
  });
  if (error) throw error;
  return data as ResaleQuote;
}

export async function getMyResaleListings(limit = 50): Promise<MyResaleListing[]> {
  const { data, error } = await supabase.rpc('my_resale_listings', { p_limit: limit });
  if (error) throw error;
  return (data ?? []) as MyResaleListing[];
}

export async function getMyResaleOrders(): Promise<ResaleOrder[]> {
  // RLS už vráti len moje — ako kupujúceho aj ako predajcu.
  const { data, error } = await supabase
    .from('resale_orders')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ResaleOrder[];
}

export async function getSellerBalance(): Promise<SellerBalance> {
  const { data, error } = await supabase.rpc('my_seller_balance');
  if (error) throw error;
  return data as SellerBalance;
}

// --- zápis -------------------------------------------------------------------

export interface NewListing {
  eventId: string;
  source: ResaleSource;
  priceCents: number;
  ticketId?: string | null;
  quantity?: number;
  deliveryMethod?: ResaleDeliveryMethod | null;
  section?: string | null;
  rowLabel?: string | null;
  seatLabel?: string | null;
  ticketLabel?: string | null;
  externalProvider?: string | null;
  externalReference?: string | null;
  faceValueCents?: number | null;
  note?: string | null;
}

export async function createResaleListing(listing: NewListing) {
  const { data, error } = await supabase.rpc('create_resale_listing', {
    p_event_id: listing.eventId,
    p_source: listing.source,
    p_price_cents: listing.priceCents,
    p_ticket_id: listing.ticketId ?? null,
    p_quantity: listing.quantity ?? 1,
    p_delivery_method: listing.deliveryMethod ?? null,
    p_section: listing.section ?? null,
    p_row_label: listing.rowLabel ?? null,
    p_seat_label: listing.seatLabel ?? null,
    p_ticket_label: listing.ticketLabel ?? null,
    p_external_provider: listing.externalProvider ?? null,
    p_external_reference: listing.externalReference ?? null,
    p_face_value_cents: listing.faceValueCents ?? null,
    p_note: listing.note ?? null,
  });
  if (error) throw error;
  return data;
}

export async function cancelResaleListing(listingId: string) {
  const { data, error } = await supabase.rpc('cancel_resale_listing', {
    p_listing_id: listingId,
  });
  if (error) throw error;
  return data;
}

/** Podrží listing, kým kupujúci platí. Platnosť stráži server, nie odpočet. */
export async function reserveResaleListing(
  listingId: string,
  quantity = 1,
): Promise<ResaleReservation> {
  const { data, error } = await supabase.rpc('reserve_resale_listing', {
    p_listing_id: listingId,
    p_quantity: quantity,
  });
  if (error) throw error;
  return data as ResaleReservation;
}

export async function releaseResaleReservation(reservationId: string) {
  const { error } = await supabase.rpc('release_resale_reservation', {
    p_reservation_id: reservationId,
  });
  if (error) throw error;
}

export async function createResaleOrder(reservationId: string): Promise<ResaleOrder> {
  const { data, error } = await supabase.rpc('create_resale_order', {
    p_reservation_id: reservationId,
  });
  if (error) throw error;
  return data as ResaleOrder;
}

export async function deliverResaleTicket(
  orderId: string,
  payload: { filePath?: string | null; note?: string | null },
) {
  const { data, error } = await supabase.rpc('deliver_resale_ticket', {
    p_order_id: orderId,
    p_file_path: payload.filePath ?? null,
    p_note: payload.note ?? null,
  });
  if (error) throw error;
  return data;
}

/** Potvrdenie kupujúcim. Toto je to, čo uvoľní peniaze predajcovi. */
export async function confirmResaleTicket(orderId: string) {
  const { data, error } = await supabase.rpc('confirm_resale_ticket', {
    p_order_id: orderId,
  });
  if (error) throw error;
  return data;
}

export type DisputeReason =
  | 'not_received' | 'invalid' | 'not_as_described' | 'event_cancelled' | 'other';

export async function openResaleDispute(
  orderId: string,
  reason: DisputeReason,
  description?: string,
) {
  const { data, error } = await supabase.rpc('open_resale_dispute', {
    p_order_id: orderId,
    p_reason: reason,
    p_description: description ?? null,
  });
  if (error) throw error;
  return data;
}

export async function requestSellerPayout() {
  const { data, error } = await supabase.rpc('request_seller_payout');
  if (error) throw error;
  return data;
}
