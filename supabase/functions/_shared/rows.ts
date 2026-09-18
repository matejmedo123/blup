/**
 * The shapes the money RPCs return.
 *
 * These mirror columns on `orders`, `checkouts`, `event_boosts`, `payouts` and
 * `premium_subscriptions` — the source of truth is the migration that defines
 * each table, and the field names here must match it exactly.
 *
 * They exist because supabase-js infers an RPC's return type from a generated
 * `Database` type and there is none: without them every `order.total_cents` is
 * a type error against the empty object, which is how `deno check` came to
 * report a hundred and twenty-five of them across code that runs correctly.
 * Generating the real types (`supabase gen types`) would be better and would
 * catch a renamed column; these do not. What they do is let the type checker
 * run at all, so a genuine mistake is visible instead of being one of a hundred
 * and twenty-five.
 */

/** public.orders — created by create_order(), never by a client. */
export interface OrderRow {
  id: string;
  event_id: string;
  organization_id: string | null;
  quantity: number;
  subtotal_cents: number;
  discount_cents: number;
  net_cents: number;
  commission_cents: number;
  archive_fee_cents: number;
  archive_fee_payer: 'buyer' | 'organizer';
  platform_fee_cents: number;
  blup_revenue_cents: number;
  total_cents: number;
  currency: string;
  /** Set only for a guest order: their one way back to the ticket. */
  claim_token: string | null;
}

/**
 * public.checkouts — one basket turned into orders.
 *
 * No `blup_revenue_cents` here: that lives on `orders` and the Connect
 * application fee for a basket is summed from them, not read off the checkout.
 * Declaring a column that does not exist would compile and be `undefined` at
 * runtime, which is the failure this whole file is meant to make impossible.
 */
export interface CheckoutRow {
  id: string;
  event_id: string;
  organization_id: string | null;
  quantity: number;
  discount_cents: number;
  commission_cents: number;
  archive_fee_cents: number;
  total_cents: number;
  currency: string;
}

/** public.event_boosts — a paid promotion awaiting payment. */
export interface BoostRow {
  id: string;
  amount_cents: number;
  currency: string;
  weight: number;
  starts_at: string;
  ends_at: string;
  impression_budget: number;
}

/** public.payouts — an organizer withdrawing settled money. */
export interface PayoutRow {
  id: string;
  amount_cents: number;
  currency: string;
}

/** public.premium_subscriptions, as upsert_premium_subscription() returns it. */
export interface SubscriptionRow {
  expires_at: string | null;
}
