import { supabase } from '@/lib/supabase';

/**
 * BLUP SWAP — podklady pre admina.
 *
 * Spor medzi dvoma ľuďmi o peniaze musí niekto rozhodnúť a musí na to mať
 * čím. Preto tu nie je len „otvorený spor", ale aj to, čo sa predalo, za
 * koľko, či vstupenka dorazila a aké riziko má predajca — druhý a tretí spor
 * toho istého človeka sa nemá rozhodovať, akoby bol prvý.
 */
export interface SwapOverview {
  live_listings: number;
  open_disputes: number;
  awaiting_delivery: number;
  held_payouts: number;
  pending_payouts: number;
  gmv_cents: number;
  revenue_cents: number;
  refunded_cents: number;
  currency: string;
}

export interface SwapDispute {
  dispute_id: string;
  resale_order_id: string;
  status: 'open' | 'investigating' | 'resolved' | 'rejected';
  reason: string;
  description: string | null;
  opened_at: string;
  resolution: string | null;
  refunded_cents: number | null;
  event_title: string;
  event_start_at: string;
  source: 'blup' | 'external';
  total_cents: number;
  seller_net_cents: number;
  currency: string;
  paid_at: string | null;
  delivered_at: string | null;
  has_file: boolean;
  transfer_note: string | null;
  buyer_id: string;
  buyer_name: string | null;
  seller_id: string;
  seller_name: string | null;
  seller_risk: 'low' | 'medium' | 'high';
  seller_disputes: number;
}

export interface SwapHeldPayout {
  payout_id: string;
  seller_id: string;
  seller_name: string | null;
  amount_cents: number;
  currency: string;
  status: string;
  held_reason: string | null;
  requested_at: string;
  seller_risk: 'low' | 'medium' | 'high';
  open_disputes: number;
}

export type SwapResolution =
  | 'refunded' | 'partially_refunded' | 'released_to_seller' | 'no_action';

export async function getSwapOverview(): Promise<SwapOverview> {
  const { data, error } = await supabase.rpc('swap_admin_overview');
  if (error) throw error;
  return data as SwapOverview;
}

export async function getSwapDisputes(
  status: 'open' | 'resolved' | 'all' = 'open',
): Promise<SwapDispute[]> {
  const { data, error } = await supabase.rpc('swap_admin_disputes', {
    p_status: status,
    p_limit: 50,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data as SwapDispute[]) : [];
}

export async function getSwapHeldPayouts(): Promise<SwapHeldPayout[]> {
  const { data, error } = await supabase.rpc('swap_admin_payouts', { p_limit: 50 });
  if (error) throw error;
  return Array.isArray(data) ? (data as SwapHeldPayout[]) : [];
}

/**
 * Rozhodnutie sporu.
 *
 * Vracia sumu, o ktorú treba požiadať poskytovateľa platby — databáza vie
 * KOĽKO a PREČO, ale peniaze nehýbe. Samotný prevod robí serverová funkcia,
 * ktorá má kľúč.
 */
export async function resolveSwapDispute(
  disputeId: string,
  resolution: SwapResolution,
  refundCents?: number | null,
  note?: string | null,
) {
  const { data, error } = await supabase.rpc('resolve_resale_dispute', {
    p_dispute_id: disputeId,
    p_resolution: resolution,
    p_refund_cents: refundCents ?? null,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data as {
    dispute_id: string;
    refund_cents: number;
    provider_reference: string | null;
    currency: string;
  };
}

export async function releaseSellerPayout(payoutId: string, note?: string) {
  const { data, error } = await supabase.rpc('release_seller_payout', {
    p_payout_id: payoutId,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data;
}
