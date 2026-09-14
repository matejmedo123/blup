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
