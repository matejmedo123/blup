import { callFunction, supabase } from '@/lib/supabase';
import type {
  BlupEvent, EventAnalytics, Organization, OrganizationBalance, OrgRole, Payout, TicketType,
} from '@/types/models';

/** Organizer layer: organizations, team, verification, tickets, money. */

export async function getMyOrganizations(): Promise<(Organization & { my_role: OrgRole })[]> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return [];

  const { data, error } = await supabase
    .from('organization_members')
    .select('role, organization:organizations (*)')
    .eq('user_id', userId);

  if (error) throw error;

  return ((data ?? []) as unknown as { role: OrgRole; organization: Organization | null }[])
    .filter((row) => row.organization)
    .map((row) => ({ ...(row.organization as Organization), my_role: row.role }));
}

export async function getOrganization(id: string): Promise<Organization | null> {
  const { data, error } = await supabase.from('organizations').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as Organization) ?? null;
}

/**
 * One-tap organizer profile for an individual.
 *
 * The concept document wants "ticketing pre všetkých" — anybody able to charge
 * for their own event. Legally, money can only be paid out to a verified,
 * identifiable entity, so this does not skip verification; it removes the form
 * standing between a person and starting it, by creating a personal
 * organization from their existing profile.
 */
export async function createPersonalOrganization(profile: {
  id: string;
  display_name: string | null;
  username: string | null;
  email?: string | null;
  city?: string | null;
}): Promise<Organization> {
  const name = profile.display_name?.trim() || profile.username || 'Môj profil';

  const base = (profile.username || name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

  // Slugs are unique; a personal one is namespaced and suffixed if taken.
  const candidate = base.length >= 3 ? base : `blup-${profile.id.slice(0, 8)}`;

  try {
    return await createOrganization({
      name,
      slug: candidate,
      description: 'Osobný profil organizátora',
      contactEmail: profile.email ?? undefined,
      city: profile.city ?? undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!/duplicate|unique/i.test(message)) throw error;

    return createOrganization({
      name,
      slug: `${candidate}-${profile.id.slice(0, 4)}`.slice(0, 40),
      description: 'Osobný profil organizátora',
      contactEmail: profile.email ?? undefined,
      city: profile.city ?? undefined,
    });
  }
}

export async function createOrganization(input: {
  name: string;
  slug: string;
  description?: string;
  website?: string;
  contactEmail?: string;
  country?: string;
  city?: string;
  logoUrl?: string | null;
}): Promise<Organization> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const slug = input.slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) {
    throw new Error('Odkaz musí mať 3–40 znakov: malé písmená, čísla a pomlčky.');
  }

  const { data, error } = await supabase
    .from('organizations')
    .insert({
      name: input.name.trim(),
      slug,
      description: input.description?.trim() || null,
      website: input.website?.trim() || null,
      contact_email: input.contactEmail?.trim() || null,
      country: input.country ?? null,
      city: input.city ?? null,
      logo_url: input.logoUrl ?? null,
      created_by: userId,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') throw new Error('That handle is already taken.');
    throw error;
  }

  return data as Organization;
}

export async function updateOrganization(
  id: string,
  patch: Partial<{
    name: string;
    description: string | null;
    website: string | null;
    contact_email: string | null;
    contact_phone: string | null;
    logo_url: string | null;
    cover_url: string | null;
    city: string | null;
  }>,
): Promise<Organization> {
  const { data, error } = await supabase
    .from('organizations')
    .update(patch)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data as Organization;
}

// --- verification -----------------------------------------------------------

export interface VerificationRequestInput {
  organizationId: string;
  legalName: string;
  registrationNumber?: string;
  vatNumber?: string;
  contactEmail: string;
  contactPhone?: string;
  address?: string;
  documents?: { path: string; kind: string }[];
}

export async function requestVerification(input: VerificationRequestInput) {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('UNAUTHENTICATED');

  const { data, error } = await supabase
    .from('organization_verification_requests')
    .insert({
      organization_id: input.organizationId,
      submitted_by: userId,
      legal_name: input.legalName.trim(),
      registration_number: input.registrationNumber?.trim() || null,
      vat_number: input.vatNumber?.trim() || null,
      contact_email: input.contactEmail.trim(),
      contact_phone: input.contactPhone?.trim() || null,
      address: input.address?.trim() || null,
      documents: (input.documents ?? []).map((doc) => ({
        ...doc,
        uploaded_at: new Date().toISOString(),
      })),
    })
    .select()
    .single();

  if (error) throw error;

  await supabase
    .from('organizations')
    .update({ verification_status: 'pending' })
    .eq('id', input.organizationId);

  return data;
}

export async function getVerificationRequests(organizationId: string) {
  const { data, error } = await supabase
    .from('organization_verification_requests')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

// --- team -------------------------------------------------------------------

export async function getOrganizationMembers(organizationId: string) {
  const { data, error } = await supabase
    .from('organization_members')
    .select('role, user_id, profile:profiles (id, username, display_name, avatar_url)')
    .eq('organization_id', organizationId);

  if (error) throw error;
  return data ?? [];
}

export async function addOrganizationMember(
  organizationId: string,
  userId: string,
  role: OrgRole,
): Promise<void> {
  const { error } = await supabase
    .from('organization_members')
    .upsert(
      { organization_id: organizationId, user_id: userId, role },
      { onConflict: 'organization_id,user_id' },
    );

  if (error) throw error;
}

export async function removeOrganizationMember(
  organizationId: string,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from('organization_members')
    .delete()
    .eq('organization_id', organizationId)
    .eq('user_id', userId);

  if (error) throw error;
}

// --- events & tickets -------------------------------------------------------

export async function getOrganizationEvents(organizationId: string): Promise<BlupEvent[]> {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('organization_id', organizationId)
    .order('start_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as BlupEvent[];
}

export async function createTicketType(input: {
  eventId: string;
  name: string;
  description?: string;
  priceCents: number;
  currency?: string;
  quantityTotal: number;
  maxPerOrder?: number;
  salesStartAt?: Date | null;
  salesEndAt?: Date | null;
}): Promise<TicketType> {
  const { data, error } = await supabase
    .from('ticket_types')
    .insert({
      event_id: input.eventId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      price_cents: input.priceCents,
      currency: input.currency ?? 'EUR',
      quantity_total: input.quantityTotal,
      max_per_order: input.maxPerOrder ?? 6,
      sales_start_at: input.salesStartAt?.toISOString() ?? null,
      sales_end_at: input.salesEndAt?.toISOString() ?? null,
    })
    .select()
    .single();

  if (error) throw error;
  return data as TicketType;
}

export async function updateTicketType(id: string, patch: Partial<TicketType>): Promise<void> {
  const { error } = await supabase.from('ticket_types').update(patch).eq('id', id);
  if (error) throw error;
}

// --- money ------------------------------------------------------------------

export async function getOrganizerBalance(organizationId: string): Promise<OrganizationBalance | null> {
  const { data, error } = await supabase
    .from('organization_balances')
    .select('*')
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) throw error;
  return (data as OrganizationBalance) ?? null;
}

export async function getLedger(organizationId: string, limit = 50) {
  const { data, error } = await supabase
    .from('ledger_entries')
    .select('*, event:events (id, title)')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

export async function getPayouts(organizationId: string): Promise<Payout[]> {
  const { data, error } = await supabase
    .from('payouts')
    .select('*')
    .eq('organization_id', organizationId)
    .order('requested_at', { ascending: false });

  if (error) throw error;
  return (data ?? []) as Payout[];
}

export interface PayoutResult {
  payout_id: string;
  status: string;
  amount_cents: number;
  currency: string;
  provider_transfer_id?: string;
  note?: string;
}

export async function requestPayout(
  organizationId: string,
  amountCents: number,
): Promise<PayoutResult> {
  return callFunction<PayoutResult>('payout-request', {
    organization_id: organizationId,
    amount_cents: amountCents,
  });
}

export interface ConnectStatus {
  account_id: string;
  onboarding_url?: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  requirements_due?: string[];
}

/** Starts (or refreshes) Stripe Connect KYC onboarding for payouts. */
export async function startPayoutOnboarding(organizationId: string): Promise<ConnectStatus> {
  return callFunction<ConnectStatus>('organizer-connect', {
    organization_id: organizationId,
    action: 'onboard',
  });
}

export async function refreshPayoutStatus(organizationId: string): Promise<ConnectStatus> {
  return callFunction<ConnectStatus>('organizer-connect', {
    organization_id: organizationId,
    action: 'refresh',
  });
}

// --- analytics --------------------------------------------------------------

export async function getEventAnalytics(eventId: string): Promise<EventAnalytics> {
  const { data, error } = await supabase.rpc('event_analytics', { p_event_id: eventId });
  if (error) throw error;
  return data as EventAnalytics;
}

/**
 * The daily sales curve. The database fills in the quiet days, so the series is
 * always exactly `days` long and the chart never has to guess at gaps.
 */
export interface SalesPoint {
  day: string;
  orders: number;
  tickets: number;
  gross_cents: number;
  net_cents: number;
  blup_cents: number;
  cumulative_tickets: number;
}

export async function getEventSalesSeries(
  eventId: string,
  days = 30,
): Promise<SalesPoint[]> {
  const { data, error } = await supabase.rpc('event_sales_series', {
    p_event_id: eventId,
    p_days: days,
  });
  if (error) throw error;
  return (data ?? []) as SalesPoint[];
}

export async function getEventOrders(eventId: string) {
  const { data, error } = await supabase
    .from('orders')
    .select('*, buyer:profiles (id, username, display_name)')
    .eq('event_id', eventId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}
