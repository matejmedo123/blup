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
  /** Who runs this deployment — shown in the site footer, empty until filled in. */
  operator_name: string | null;
  operator_address: string | null;
  operator_city: string | null;
  operator_country: string | null;
  operator_reg_no: string | null;
  operator_vat_no: string | null;
  operator_email: string | null;
  operator_phone: string | null;
  operator_website: string | null;
}

export async function getPlatformSettings(): Promise<PlatformSettings> {
  const { data, error } = await supabase
    .from('platform_settings')
    .select(
      'platform_fee_bps, archive_fee_cents, archive_fee_payer, settlement_days, default_currency, updated_at, operator_name, operator_address, operator_city, operator_country, operator_reg_no, operator_vat_no, operator_email, operator_phone, operator_website',
    )
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
    'platform_fee_bps' | 'archive_fee_cents' | 'archive_fee_payer' | 'settlement_days'
    | 'operator_name' | 'operator_address' | 'operator_city' | 'operator_country'
    | 'operator_reg_no' | 'operator_vat_no' | 'operator_email' | 'operator_phone'
    | 'operator_website'>>,
): Promise<PlatformSettings> {
  const { data: userData } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from('platform_settings')
    .update({ ...patch, updated_at: new Date().toISOString(), updated_by: userData?.user?.id ?? null })
    .eq('id', true)
    .select(
      'platform_fee_bps, archive_fee_cents, archive_fee_payer, settlement_days, default_currency, updated_at, operator_name, operator_address, operator_city, operator_country, operator_reg_no, operator_vat_no, operator_email, operator_phone, operator_website',
    )
    .single();

  if (error) throw error;
  return data as PlatformSettings;
}

// --- events -----------------------------------------------------------------

/**
 * Every event on the platform, searchable. Admins could always *edit* any event
 * — the RLS policy has allowed it from the start — but there was no way to find
 * one that was not already on screen.
 */
export interface AdminEvent {
  id: string;
  title: string;
  status: string;
  visibility: string;
  start_at: string;
  city: string | null;
  venue_name: string | null;
  category: string | null;
  is_free: boolean;
  price_cents: number;
  attendee_count: number;
  tickets_sold: number;
  creator_id: string;
  creator_name: string | null;
  organization_id: string | null;
  organization_name: string | null;
  reports_open: number;
  created_at: string;
}

export async function getAdminEvents(params: {
  query?: string;
  status?: string | null;
  limit?: number;
  offset?: number;
} = {}): Promise<AdminEvent[]> {
  const { data, error } = await supabase.rpc('admin_events', {
    p_query: params.query?.trim() || null,
    p_status: params.status ?? null,
    p_limit: params.limit ?? 40,
    p_offset: params.offset ?? 0,
  });

  if (error) throw error;
  return (data ?? []) as AdminEvent[];
}

/**
 * Records that an admin edited somebody else's event, and why. Called after the
 * update lands so the log never claims a change the database refused.
 */
export async function logAdminEventEdit(
  eventId: string,
  fields: string[],
  reason: string,
): Promise<void> {
  const { error } = await supabase.rpc('admin_log_event_edit', {
    p_event_id: eventId,
    p_fields: fields,
    p_reason: reason,
  });
  if (error) throw error;
}

// --- marketing ---------------------------------------------------------------

/**
 * Ad platform tags.
 *
 * Identifiers, not markup. A "paste your script tag" box would be stored XSS
 * with every visitor's session behind it — so the shape of what an admin can
 * save is fixed here and checked again by a CHECK constraint in the database.
 */
export interface MarketingSettings {
  meta_enabled: boolean;
  meta_pixel_id: string | null;
  google_enabled: boolean;
  google_ads_id: string | null;
  google_ads_purchase_label: string | null;
  google_analytics_id: string | null;
  consent_required: boolean;
  updated_at: string;
}

export async function getMarketingSettings(): Promise<MarketingSettings> {
  const { data, error } = await supabase
    .from('marketing_settings')
    .select('meta_enabled, meta_pixel_id, google_enabled, google_ads_id, google_ads_purchase_label, google_analytics_id, consent_required, updated_at')
    .single();

  if (error) throw error;
  return data as MarketingSettings;
}

export async function saveMarketingSettings(next: {
  metaEnabled: boolean;
  metaPixelId: string | null;
  googleEnabled: boolean;
  googleAdsId: string | null;
  googleAdsLabel: string | null;
  googleAnalyticsId: string | null;
  consentRequired: boolean;
}): Promise<MarketingSettings> {
  const { data, error } = await supabase.rpc('set_marketing_settings', {
    p_meta_enabled: next.metaEnabled,
    p_meta_pixel_id: next.metaPixelId,
    p_google_enabled: next.googleEnabled,
    p_google_ads_id: next.googleAdsId,
    p_google_ads_label: next.googleAdsLabel,
    p_google_analytics: next.googleAnalyticsId,
    p_consent_required: next.consentRequired,
  });

  if (error) throw error;
  return data as MarketingSettings;
}
