import { supabase } from '@/lib/supabase';
import type { PlatformStats, Profile, ReportStatus } from '@/types/models';

/**
 * Admin API. Every function calls a SECURITY DEFINER database function that
 * re-checks `is_admin()` server-side — hiding the screen is not the control.
 */

export async function getPlatformStats(): Promise<PlatformStats> {
  const { data, error } = await supabase.rpc('admin_platform_stats');
  if (error) throw error;
  return data as PlatformStats;
}

export async function listUsers(search = '', limit = 50): Promise<Profile[]> {
  let query = supabase
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (search.trim().length >= 2) {
    query = query.or(
      `username.ilike.%${search.trim()}%,display_name.ilike.%${search.trim()}%,email.ilike.%${search.trim()}%`,
    );
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Profile[];
}

export async function suspendUser(userId: string, suspend: boolean, reason?: string): Promise<void> {
  const { error } = await supabase.rpc('admin_suspend_user', {
    p_user_id: userId,
    p_suspend: suspend,
    p_reason: reason ?? null,
  });
  if (error) throw error;
}

export async function setEventStatus(
  eventId: string,
  status: 'draft' | 'published' | 'cancelled' | 'completed',
  reason?: string,
): Promise<void> {
  const { error } = await supabase.rpc('admin_set_event_status', {
    p_event_id: eventId,
    p_status: status,
    p_reason: reason ?? null,
  });
  if (error) throw error;
}

export async function listVerificationRequests(status = 'pending') {
  const { data, error } = await supabase
    .from('organization_verification_requests')
    .select('*, organization:organizations (id, name, slug, logo_url, country)')
    .eq('status', status)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function reviewOrganization(
  requestId: string,
  approve: boolean,
  notes?: string,
): Promise<void> {
  const { error } = await supabase.rpc('admin_review_organization', {
    p_request_id: requestId,
    p_approve: approve,
    p_notes: notes ?? null,
  });
  if (error) throw error;
}

export async function listReports(status: ReportStatus = 'open') {
  const { data, error } = await supabase
    .from('reports')
    .select('*, reporter:profiles!reports_reporter_id_fkey (id, username, display_name)')
    .eq('status', status)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function resolveReport(
  reportId: string,
  status: ReportStatus,
  notes?: string,
): Promise<void> {
  const { error } = await supabase.rpc('admin_resolve_report', {
    p_report_id: reportId,
    p_status: status,
    p_notes: notes ?? null,
  });
  if (error) throw error;
}

export async function listPayouts(status?: string) {
  let query = supabase
    .from('payouts')
    .select('*, organization:organizations (id, name, slug)')
    .order('requested_at', { ascending: false })
    .limit(100);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function updatePayoutStatus(
  payoutId: string,
  status: 'pending' | 'processing' | 'paid' | 'failed' | 'cancelled',
  options: { transferId?: string; failureReason?: string } = {},
): Promise<void> {
  const { error } = await supabase.rpc('admin_update_payout_status', {
    p_payout_id: payoutId,
    p_status: status,
    p_provider_transfer_id: options.transferId ?? null,
    p_failure_reason: options.failureReason ?? null,
  });
  if (error) throw error;
}

export async function listRecentOrders(limit = 50) {
  const { data, error } = await supabase
    .from('orders')
    .select('*, event:events (id, title), buyer:profiles (id, username)')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

/** User-facing reporting (available to everyone, reviewed by admins). */
export async function reportContent(input: {
  targetType: 'event' | 'user' | 'comment' | 'post' | 'organization';
  targetId: string;
  reason: string;
  details?: string;
}): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const { error } = await supabase.from('reports').insert({
    reporter_id: userId,
    target_type: input.targetType,
    target_id: input.targetId,
    reason: input.reason,
    details: input.details ?? null,
  });

  if (error) throw error;
}

/**
 * The platform fee schedule.
 *
 * These are the numbers BLUP charges: a percentage of every ticket sale and a
 * fixed amount per issued ticket. They live in one row so changing the price is
 * an update, not a release — and every order records the values that applied at
 * the moment it was created, so a change never rewrites history.
 */
export interface PlatformSettings {
  platform_fee_bps: number;
  archive_fee_cents: number;
  archive_fee_payer: 'buyer' | 'organizer';
  settlement_days: number;
  default_currency: string;
  updated_at: string;
}

export async function getPlatformSettings(): Promise<PlatformSettings> {
  const { data, error } = await supabase
    .from('platform_settings')
    .select('platform_fee_bps, archive_fee_cents, archive_fee_payer, settlement_days, default_currency, updated_at')
    .single();

  if (error) throw error;
  return data as PlatformSettings;
}

/**
 * Only a full admin can write these — the RLS policy on `platform_settings`
 * enforces it, so a rejected update here is the database refusing, not the app.
 */
export async function updatePlatformSettings(
  patch: Partial<Pick<PlatformSettings,
    'platform_fee_bps' | 'archive_fee_cents' | 'archive_fee_payer' | 'settlement_days'>>,
): Promise<PlatformSettings> {
  const { data: userData } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from('platform_settings')
    .update({ ...patch, updated_at: new Date().toISOString(), updated_by: userData?.user?.id ?? null })
    .eq('id', true)
    .select('platform_fee_bps, archive_fee_cents, archive_fee_payer, settlement_days, default_currency, updated_at')
    .single();

  if (error) throw error;
  return data as PlatformSettings;
}
