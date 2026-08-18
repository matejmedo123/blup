import { supabase } from '@/lib/supabase';

/**
 * Organizer promo tools: discount codes and paid boosts.
 *
 * Codes are readable only by the organizer that owns them (RLS), and the
 * discount they produce is always recalculated by the database at order time —
 * this module never computes a price.
 */

export interface PromoCode {
  id: string;
  organization_id: string | null;
  event_id: string | null;
  code: string;
  kind: 'percent' | 'fixed';
  value: number;
  max_uses: number | null;
  used_count: number;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  created_at: string;
  event?: { id: string; title: string } | null;
}

export interface EventBoost {
  id: string;
  event_id: string;
  starts_at: string;
  ends_at: string;
  weight: number;
  amount_cents: number;
  currency: string;
  created_at: string;
}

export async function getPromoCodes(params: {
  organizationId?: string;
  eventId?: string;
}): Promise<PromoCode[]> {
  let request = supabase
    .from('promo_codes')
    .select('*, event:events (id, title)')
    .order('created_at', { ascending: false });

  if (params.eventId) request = request.eq('event_id', params.eventId);
  else if (params.organizationId) request = request.eq('organization_id', params.organizationId);

  const { data, error } = await request;
  if (error) throw error;
  return (data ?? []) as unknown as PromoCode[];
}

export async function createPromoCode(input: {
  code: string;
  kind: 'percent' | 'fixed';
  value: number;
  eventId?: string | null;
  organizationId?: string | null;
  maxUses?: number | null;
  endsAt?: string | null;
}): Promise<PromoCode> {
  const { data: userData } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from('promo_codes')
    .insert({
      code: input.code.trim().toUpperCase(),
      kind: input.kind,
      value: input.value,
      event_id: input.eventId ?? null,
      organization_id: input.organizationId ?? null,
      max_uses: input.maxUses ?? null,
      ends_at: input.endsAt ?? null,
      created_by: userData?.user?.id ?? null,
    })
    .select()
    .single();

  if (error) throw error;
  return data as PromoCode;
}

export async function setPromoActive(id: string, isActive: boolean): Promise<void> {
  const { error } = await supabase
    .from('promo_codes')
    .update({ is_active: isActive })
    .eq('id', id);

  if (error) throw error;
}

export async function deletePromoCode(id: string): Promise<void> {
  const { error } = await supabase.from('promo_codes').delete().eq('id', id);
  if (error) throw error;
}

export async function getEventBoosts(eventId: string): Promise<EventBoost[]> {
  const { data, error } = await supabase
    .from('event_boosts')
    .select('*')
    .eq('event_id', eventId)
    .order('ends_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as EventBoost[];
}

/** True while a paid boost is running on this event. */
export async function isBoosted(eventId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('boost_weight_for', { p_event: eventId });
  if (error) throw error;
  return Number(data ?? 0) > 0;
}
