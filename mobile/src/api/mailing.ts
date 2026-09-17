import { supabase } from '@/lib/supabase';

/**
 * E-mail: what BLUP may send, and what an organizer wants to send.
 *
 * Consent lives on the address, not on the account, because a guest who bought
 * one ticket never made an account and never saw a preferences screen. That is
 * why the switch below is a database call rather than a column on the profile.
 */
export interface EmailPreferences {
  email: string;
  digest_opt_in: boolean;
  /** They clicked "nechcem takéto e-maily" in a mail, from any device. */
  unsubscribed: boolean;
  /** The address bounced or reported us. Nothing goes there again. */
  undeliverable: boolean;
}

export async function getEmailPreferences(): Promise<EmailPreferences | null> {
  const { data, error } = await supabase.rpc('my_email_preferences');
  if (error) throw error;
  return (data as EmailPreferences) ?? null;
}

export async function setEmailPreferences(digest: boolean): Promise<EmailPreferences | null> {
  const { data, error } = await supabase.rpc('set_email_preferences', { p_digest: digest });
  if (error) throw error;
  return (data as EmailPreferences) ?? null;
}

// ---------------------------------------------------------------------------
// An organizer writing to the people who came
// ---------------------------------------------------------------------------
export type CampaignAudience = 'ticket_holders' | 'attendees' | 'past_attendees';

export const AUDIENCE_LABEL: Record<CampaignAudience, string> = {
  ticket_holders: 'Kto má vstupenku na tento event',
  attendees: 'Kto sa prihlásil na tento event',
  past_attendees: 'Kto u teba niekedy bol',
};

export const AUDIENCE_NOTE: Record<CampaignAudience, string> = {
  ticket_holders:
    'Zaplatili ti. Písať im o tomto evente nie je reklama — je to služba, ktorú si kúpili.',
  attendees:
    'Označili si, že prídu. Chcú vedieť, keď sa niečo zmení.',
  past_attendees:
    'Boli u teba na niečom v minulosti. Toto už je reklama, tak sa oplatí mať čo povedať — '
    + 'a každý sa z nej vie odhlásiť jedným klikom.',
};

export interface Campaign {
  id: string;
  organization_id: string;
  event_id: string | null;
  audience: CampaignAudience;
  subject: string;
  body: string;
  status: 'draft' | 'queued' | 'sent' | 'cancelled';
  recipients: number;
  created_at: string;
}

export interface AudienceMember {
  email: string;
  user_id: string | null;
  display_name: string | null;
}

/**
 * Who would get it — the same query the send runs.
 *
 * Counted before anything is written, so the number an organizer commits to is
 * the number that goes out rather than an estimate.
 */
export async function getCampaignAudience(input: {
  organizationId: string;
  audience: CampaignAudience;
  eventId?: string | null;
}): Promise<AudienceMember[]> {
  const { data, error } = await supabase.rpc('campaign_audience', {
    p_organization_id: input.organizationId,
    p_audience: input.audience,
    p_event_id: input.eventId ?? null,
  });

  if (error) throw error;
  return (data ?? []) as AudienceMember[];
}

export async function sendCampaign(input: {
  organizationId: string;
  audience: CampaignAudience;
  subject: string;
  body: string;
  eventId?: string | null;
}): Promise<Campaign> {
  const { data, error } = await supabase.rpc('send_campaign', {
    p_organization_id: input.organizationId,
    p_audience: input.audience,
    p_subject: input.subject,
    p_body: input.body,
    p_event_id: input.eventId ?? null,
  });

  if (error) throw error;
  return data as Campaign;
}

export async function getCampaigns(organizationId: string): Promise<Campaign[]> {
  const { data, error } = await supabase
    .from('email_campaigns')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) throw error;
  return (data ?? []) as Campaign[];
}

export interface CampaignReport {
  id: string;
  subject: string;
  audience: CampaignAudience;
  created_at: string;
  recipients: number;
  sent: number;
  pending: number;
  failed: number;
  skipped: number;
  /** Read it and then asked not to get the next one. The only number here about the writing. */
  unsubscribed: number;
}

export async function getCampaignReport(campaignId: string): Promise<CampaignReport> {
  const { data, error } = await supabase.rpc('campaign_report', { p_campaign_id: campaignId });
  if (error) throw error;
  return data as CampaignReport;
}
