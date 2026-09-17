import { callFunction, supabase } from '@/lib/supabase';

/**
 * Buying a boost.
 *
 * Same shape as ticket checkout: the server prices it and returns a
 * PaymentIntent secret, the native payment sheet takes the money, and the
 * webhook is what activates the boost. Nothing here decides a price, and
 * nothing here marks a boost live.
 */

export interface BoostPackage {
  code: string;
  name: string;
  hours: number;
  weight: number;
  price_cents: number;
  currency: string;
  sort_order: number;
  /** How many times it will be shown — what is actually bought. */
  impressions: number;
  /** Where: feed, map, spotlight. */
  placements: string[];
}

export interface BoostSession {
  boost_id: string;
  status: 'requires_payment';
  requires_payment: boolean;
  payment_intent_client_secret?: string;
  amount_cents: number;
  currency: string;
  starts_at: string;
  ends_at: string;
  weight: number;
}

export async function getBoostPackages(): Promise<BoostPackage[]> {
  const { data, error } = await supabase
    .from('boost_packages')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  if (error) throw error;
  return (data ?? []) as BoostPackage[];
}

export interface BoostQuote {
  available: boolean;
  reason: string | null;
  package_hours: number;
  /** Shorter than package_hours when the event ends first. */
  effective_hours: number;
  truncated: boolean;
  starts_at: string;
  ends_at: string;
  /** Set when a boost is already running and this one queues behind it. */
  queued_after: string | null;
  amount_cents: number;
  currency: string;
}

/**
 * What this package would actually deliver on this event, before any payment
 * sheet opens.
 *
 * A boost is worth nothing once the event is over, so the server cuts it short
 * at the event's end. The price does not change with it — which makes this the
 * difference between the organizer choosing to buy three hours and the
 * organizer discovering afterwards that they paid for twenty-four.
 */
export async function getBoostQuote(eventId: string, packageCode: string): Promise<BoostQuote> {
  const { data, error } = await supabase.rpc('boost_quote', {
    p_event: eventId,
    p_package: packageCode,
  });
  if (error) throw error;
  return data as BoostQuote;
}

export async function createBoostCheckout(
  eventId: string,
  packageCode: string,
): Promise<BoostSession> {
  return callFunction<BoostSession>('boost-create', {
    event_id: eventId,
    package_code: packageCode,
  });
}

/**
 * Waits for the webhook to activate the boost.
 *
 * The payment sheet returning success only means the provider accepted the
 * card; the boost is live when our server has been told so. Polls briefly, then
 * gives up and tells the caller to check back — it never claims success it has
 * not seen.
 */
export async function waitForBoost(
  boostId: string,
  { attempts = 10, delayMs = 1200 }: { attempts?: number; delayMs?: number } = {},
): Promise<'succeeded' | 'pending' | 'failed'> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { data } = await supabase
      .from('event_boosts')
      .select('payment_status')
      .eq('id', boostId)
      .maybeSingle();

    const status = (data as { payment_status?: string } | null)?.payment_status;
    if (status === 'succeeded') return 'succeeded';
    if (status === 'failed' || status === 'cancelled') return 'failed';

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return 'pending';
}

/** Boost history for one event, newest window first. */
export async function getEventBoosts(eventId: string) {
  const { data, error } = await supabase
    .from('event_boosts')
    .select('*')
    .eq('event_id', eventId)
    .order('ends_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

/** True while a paid boost is running. */
export async function isBoosted(eventId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('boost_weight_for', { p_event: eventId });
  if (error) throw error;
  return Number(data ?? 0) > 0;
}

// --- delivery ----------------------------------------------------------------

/**
 * The sponsored slots for this person, right now.
 *
 * Everything that decides what appears here lives in the database: budget,
 * pacing, the frequency cap, and the relevance floor that keeps a paid event
 * from being shown to somebody it does not fit. The app asks and renders; it
 * does not get a say in who sees what.
 */
export interface SponsoredSlot {
  boost_id: string;
  event_id: string;
  relevance: number;
  rank_score: number;
}

export type BoostPlacement = 'feed' | 'map' | 'spotlight';

export async function getSponsored(
  placement: BoostPlacement,
  coords?: { latitude: number; longitude: number } | null,
  limit = 1,
): Promise<SponsoredSlot[]> {
  const { data, error } = await supabase.rpc('sponsored_events', {
    p_placement: placement,
    p_lat: coords?.latitude ?? null,
    p_lon: coords?.longitude ?? null,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as SponsoredSlot[];
}

/**
 * Says a sponsored placement was on screen, or was clicked.
 *
 * Deliberately swallowed. This can only spend somebody's budget, never extend
 * it — an impression that fails to record costs the advertiser nothing, and a
 * failure here must never be the reason a screen does not render.
 */
export async function recordBoostEvent(
  boostId: string,
  placement: BoostPlacement,
  kind: 'impression' | 'click' = 'impression',
): Promise<void> {
  try {
    await supabase.rpc('record_boost_event', {
      p_boost_id: boostId,
      p_placement: placement,
      p_kind: kind,
    });
  } catch {
    // See above.
  }
}

/** What a boost actually delivered. Organizer only — enforced in the database. */
export interface BoostReportRow {
  id: string;
  package_code: string | null;
  starts_at: string;
  ends_at: string;
  placements: string[];
  amount_cents: number;
  currency: string;
  impression_budget: number;
  impressions_served: number;
  clicks: number;
  people_reached: number;
  ctr_pct: number;
  cost_per_click_cents: number | null;
  tickets_attributed: number;
}

export async function getBoostReport(eventId: string): Promise<BoostReportRow[]> {
  const { data, error } = await supabase.rpc('boost_report', { p_event_id: eventId });
  if (error) throw error;
  return (data ?? []) as BoostReportRow[];
}

/** This week's free boost, for Premium. */
export interface FreeBoostState {
  is_premium: boolean;
  available: boolean;
  used_at: string | null;
  renews_at: string;
}

export async function getFreeBoost(): Promise<FreeBoostState> {
  const { data, error } = await supabase.rpc('my_free_boost');
  if (error) throw error;
  return data as FreeBoostState;
}

export async function claimFreeBoost(eventId: string): Promise<void> {
  const { error } = await supabase.rpc('claim_free_boost', { p_event_id: eventId });
  if (error) throw error;
}
