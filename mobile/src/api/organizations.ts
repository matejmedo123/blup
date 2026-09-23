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
/**
 * The slug is already in use.
 *
 * A distinct type on purpose: the retry below used to sniff the message for
 * /duplicate|unique/, which never matched the message actually thrown, so the
 * retry was dead code and the raw English string reached the screen instead.
 */
export class SlugTakenError extends Error {
  readonly slug: string;
  constructor(slug: string) {
    super('Tento odkaz už niekto používa.');
    this.name = 'SlugTakenError';
    this.slug = slug;
  }
}

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

  // Somebody who already has an organization does not need a second one; the
  // button that leads here appears when none is *verified*, which is not the
  // same thing as none existing.
  const existing = await getMyOrganizations();
  if (existing.length > 0) return existing[0];

  const common = {
    name,
    description: 'Osobný profil organizátora',
    contactEmail: profile.email ?? undefined,
    city: profile.city ?? undefined,
  };

  try {
    return await createOrganization({ ...common, slug: candidate });
  } catch (error) {
    if (!(error instanceof SlugTakenError)) throw error;

    // Someone else holds the obvious slug. Suffix it with part of the user id,
    // which is unique by construction.
    return createOrganization({
      ...common,
      slug: `${candidate}-${profile.id.slice(0, 4)}`.slice(0, 40),
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
    if (error.code === '23505') throw new SlugTakenError(slug);
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
    is_vat_payer: boolean;
    vat_rate_bps: number;
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

/**
 * The door, in the three numbers it is made of.
 *
 * Separate from getEventAnalytics() because the scanner needs it after every
 * scan and has no use for the money block — fetching the whole report to read
 * two counters would be a round trip per person through the door.
 */
export interface DoorState {
  event_id: string;
  title: string;
  capacity: number | null;
  /** Scanned in: who is in the room. */
  inside: number;
  /** Still valid and never scanned: who can still walk up. */
  to_admit: number;
  tickets_void: number;
  tickets_live: number;
  admitted_pct: number;
  last_scan_at: string | null;
}

export async function getDoorState(eventId: string): Promise<DoorState> {
  const { data, error } = await supabase.rpc('event_door_state', { p_event_id: eventId });
  if (error) throw error;
  return data as DoorState;
}

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

// --- complimentary tickets ---------------------------------------------------

/**
 * Hands somebody a ticket for nothing — a competition winner, a guest, press.
 *
 * Doing this by refunding a real purchase is worse in every way: it touches the
 * payment provider, it muddles the takings and it can be disputed months later.
 * A comp is a real ticket worth zero: same QR, same scanner, same one-use rule,
 * no ledger entry, and it still takes a seat.
 *
 * `recipient` is an @username, or any e-mail address. An address we recognise
 * gets an owned ticket straight away; one we do not gets a guest ticket, which
 * works at the door exactly the same and follows them into the app if they ever
 * sign up. Nobody is made to register to collect a prize they already won.
 */
export async function issueCompTickets(
  ticketTypeId: string,
  recipient: string,
  quantity: number,
  note?: string | null,
  guestName?: string | null,
): Promise<number> {
  const { data, error } = await supabase.rpc('issue_comp_tickets', {
    p_ticket_type_id: ticketTypeId,
    p_recipient: recipient,
    p_quantity: quantity,
    p_note: note ?? null,
    p_guest_name: guestName ?? null,
  });
  if (error) throw error;
  return (data as unknown[] | null)?.length ?? 0;
}

export async function getCompSummary(eventId: string): Promise<{
  issued: number;
  checked_in: number;
  cancelled: number;
}> {
  const { data, error } = await supabase.rpc('event_comp_summary', { p_event_id: eventId });
  if (error) throw error;
  return data as { issued: number; checked_in: number; cancelled: number };
}

// --- the door list -----------------------------------------------------------

/**
 * One row per issued ticket: who holds it, the address it was sent to, and the
 * code printed on it.
 *
 * This is personal data about other people, so it is never selected from the
 * table — `event_ticket_holders` is SECURITY DEFINER and checks that the caller
 * actually runs this event before it returns anything.
 */
export interface TicketHolder {
  ticket_id: string;
  code: string;
  status: 'valid' | 'used' | 'refunded' | 'cancelled';
  holder_name: string | null;
  email: string | null;
  username: string | null;
  buyer_id: string | null;
  is_guest: boolean;
  ticket_type: string | null;
  price_cents: number;
  currency: string;
  is_complimentary: boolean;
  checked_in_at: string | null;
  deactivated_at: string | null;
  deactivation_reason: string | null;
  order_id: string | null;
  created_at: string;
  /** "Tribúna A · rad D, miesto 14", or null for a ticket that names no chair. */
  seat_label: string | null;
}

export interface TicketSummary {
  total: number;
  valid: number;
  used: number;
  cancelled: number;
  refunded: number;
  complimentary: number;
  guests: number;
}

export async function getTicketHolders(
  eventId: string,
  options: { query?: string | null; status?: string | null; limit?: number; offset?: number } = {},
): Promise<TicketHolder[]> {
  const { data, error } = await supabase.rpc('event_ticket_holders', {
    p_event_id: eventId,
    p_query: options.query?.trim() || null,
    p_status: options.status || null,
    p_limit: options.limit ?? 100,
    p_offset: options.offset ?? 0,
  });
  if (error) throw error;
  return (data ?? []) as TicketHolder[];
}

export async function getTicketSummary(eventId: string): Promise<TicketSummary> {
  const { data, error } = await supabase.rpc('event_ticket_summary', { p_event_id: eventId });
  if (error) throw error;
  return data as TicketSummary;
}

/**
 * Switches one ticket off, or back on.
 *
 * Off is not cosmetic: check_in_ticket() refuses anything that is not 'valid',
 * so the scanner turns the person away at the door. On again clears the
 * check-in too, because otherwise the next scan would say ALREADY_USED and the
 * organizer would be exactly where they started.
 */
export async function setTicketActive(
  ticketId: string,
  active: boolean,
  reason?: string | null,
): Promise<TicketHolder['status']> {
  const { data, error } = await supabase.rpc('set_ticket_active', {
    p_ticket_id: ticketId,
    p_active: active,
    p_reason: reason?.trim() || null,
  });
  if (error) throw error;
  return (data as { status: TicketHolder['status'] }).status;
}

// --- sales, across events ----------------------------------------------------

/**
 * The numbers an organizer runs the business on.
 *
 * All of these are SECURITY DEFINER over one authorisation function in the
 * database (`scope_events`), so passing an event id you do not own returns
 * nothing rather than somebody else's takings — asserted in test 32. Nothing
 * here is filtered in the client for safety; the filters below are for choosing
 * what to look at, not for deciding what you may see.
 */
export interface SalesScope {
  eventIds?: string[] | null;
  organizationId?: string | null;
  from?: string | null;
  to?: string | null;
}

const scopeArgs = (scope: SalesScope) => ({
  p_event_ids: scope.eventIds?.length ? scope.eventIds : null,
  p_organization_id: scope.organizationId ?? null,
  p_from: scope.from ?? null,
  p_to: scope.to ?? null,
});

export interface SalesTotals {
  events: number;
  orders_paid: number;
  orders_total: number;
  tickets: number;
  gross_cents: number;
  discount_cents: number;
  commission_cents: number;
  archive_fee_cents: number;
  organizer_net_cents: number;
  refunded_cents: number;
  refunded_orders: number;
  failed_orders: number;
  prev_gross_cents: number;
  currency: string;
  tickets_valid: number;
  tickets_used: number;
  tickets_void: number;
  complimentary: number;
  checked_in_pct: number;
  available_cents?: number;
  pending_cents?: number;
  reserve_cents?: number;
  paid_out_cents?: number;
  disputes_open: number;
  disputes_open_cents: number;
}

export async function getSalesTotals(scope: SalesScope = {}): Promise<SalesTotals> {
  const { data, error } = await supabase.rpc('sales_totals', scopeArgs(scope));
  if (error) throw error;
  return data as SalesTotals;
}

export interface SalesEventRow {
  event_id: string;
  title: string;
  start_at: string;
  city: string | null;
  status: string;
  tickets: number;
  orders: number;
  gross_cents: number;
  organizer_net_cents: number;
  checked_in: number;
  currency: string;
}

export async function getSalesByEvent(scope: SalesScope = {}): Promise<SalesEventRow[]> {
  const { data, error } = await supabase.rpc('sales_by_event', scopeArgs(scope));
  if (error) throw error;
  return (data ?? []) as SalesEventRow[];
}

export interface SalesTypeRow {
  ticket_type_id: string;
  name: string;
  event_title: string;
  price_cents: number;
  sold: number;
  remaining: number;
  gross_cents: number;
  currency: string;
}

export async function getSalesByTicketType(scope: SalesScope = {}): Promise<SalesTypeRow[]> {
  const { data, error } = await supabase.rpc('sales_by_ticket_type', scopeArgs(scope));
  if (error) throw error;
  return (data ?? []) as SalesTypeRow[];
}

export interface SalesMethodRow {
  method: string;
  orders: number;
  tickets: number;
  gross_cents: number;
  currency: string;
}

export async function getSalesByMethod(scope: SalesScope = {}): Promise<SalesMethodRow[]> {
  const { data, error } = await supabase.rpc('sales_by_method', scopeArgs(scope));
  if (error) throw error;
  return (data ?? []) as SalesMethodRow[];
}

export interface SalesCityRow {
  city: string;
  orders: number;
  tickets: number;
  gross_cents: number;
  latitude: number | null;
  longitude: number | null;
}

export async function getSalesByCity(scope: SalesScope = {}): Promise<SalesCityRow[]> {
  const { data, error } = await supabase.rpc('sales_by_city', {
    ...scopeArgs(scope),
    p_limit: 60,
  });
  if (error) throw error;
  return (data ?? []) as SalesCityRow[];
}

/**
 * How many people started paying and did not finish.
 *
 * `paid` counts orders that were ever paid, not orders currently in the
 * succeeded state — a refunded order did finish the checkout, and counting it
 * as abandoned would make this number fall every time somebody got their money
 * back.
 */
export interface CheckoutFunnel {
  views: number;
  baskets: number;
  started: number;
  paid: number;
  abandoned: number;
  expired: number;
  failed: number;
  success_pct: number;
  view_to_paid_pct: number;
  abandoned_cents: number;
  from: string;
  to: string;
}

export async function getCheckoutFunnel(scope: SalesScope = {}): Promise<CheckoutFunnel> {
  const { data, error } = await supabase.rpc('checkout_funnel', scopeArgs(scope));
  if (error) throw error;
  return data as CheckoutFunnel;
}

export interface SalesRow {
  paid_at: string;
  event_title: string;
  ticket_type: string | null;
  quantity: number;
  gross_cents: number;
  discount_cents: number;
  commission_cents: number;
  archive_fee_cents: number;
  organizer_net_cents: number;
  currency: string;
  buyer: string;
  email: string | null;
  city: string | null;
  has_account: boolean;
  order_id: string;
}

export async function getSalesRows(scope: SalesScope = {}): Promise<SalesRow[]> {
  const { data, error } = await supabase.rpc('sales_rows', {
    ...scopeArgs(scope),
    p_limit: 5000,
  });
  if (error) throw error;
  return (data ?? []) as SalesRow[];
}
