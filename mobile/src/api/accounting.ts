import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';

import { callFunction, supabase } from '@/lib/supabase';

/**
 * Accounting.
 *
 * Every number here is computed in the database and only rendered by the app.
 * The CSV the organizer sends to their bookkeeper and the totals they see on
 * screen come from the same functions, so the two cannot disagree — that is the
 * whole point of an export nobody has to reconcile by hand.
 */

export interface AccountingSummaryRow {
  period: string;               // 'YYYY-MM'
  orders_count: number;
  tickets_count: number;
  gross_cents: number;          // list price before discounts
  discount_cents: number;
  net_cents: number;            // ticket revenue after discounts
  commission_cents: number;     // BLUP's percentage
  archive_fee_cents: number;    // BLUP's per-ticket fee
  blup_revenue_cents: number;   // commission + archive fee
  organizer_net_cents: number;  // what the organizer keeps
  refunded_cents: number;
  currency: string;
}

export interface AccountingOrderRow {
  paid_on: string | null;
  paid_at: string | null;
  order_id: string;
  provider_reference: string | null;
  event_title: string;
  ticket_type: string;
  quantity: number;
  unit_price_cents: number;
  subtotal_cents: number;
  discount_cents: number;
  promo_code: string | null;
  net_cents: number;
  commission_cents: number;
  archive_fee_cents: number;
  archive_fee_payer: 'buyer' | 'organizer';
  buyer_paid_cents: number;
  organizer_net_cents: number;
  blup_revenue_cents: number;
  currency: string;
  status: string;
}

export interface AccountingLedgerRow {
  booked_on: string;
  created_at: string;
  entry_id: string;
  entry_type: string;
  description: string | null;
  event_title: string | null;
  order_id: string | null;
  payout_id: string | null;
  amount_cents: number;
  balance_cents: number;
  available_on: string;
  currency: string;
}

export interface PlatformAccountingRow extends AccountingSummaryRow {
  ticket_revenue_cents: number;
  boost_revenue_cents: number;
  total_revenue_cents: number;
}

export type AccountingScope = 'orders' | 'ledger' | 'summary';

export interface DateRange {
  from?: string | null;  // 'YYYY-MM-DD'
  to?: string | null;
}

export async function getAccountingSummary(
  organizationId: string,
  range: DateRange = {},
): Promise<AccountingSummaryRow[]> {
  const { data, error } = await supabase.rpc('accounting_summary', {
    p_organization_id: organizationId,
    p_from: range.from ?? null,
    p_to: range.to ?? null,
  });

  if (error) throw error;
  return (data ?? []) as AccountingSummaryRow[];
}

export async function getAccountingOrders(
  organizationId: string,
  range: DateRange = {},
): Promise<AccountingOrderRow[]> {
  const { data, error } = await supabase.rpc('accounting_orders', {
    p_organization_id: organizationId,
    p_from: range.from ?? null,
    p_to: range.to ?? null,
  });

  if (error) throw error;
  return (data ?? []) as AccountingOrderRow[];
}

export async function getAccountingLedger(
  organizationId: string,
  range: DateRange = {},
): Promise<AccountingLedgerRow[]> {
  const { data, error } = await supabase.rpc('accounting_ledger', {
    p_organization_id: organizationId,
    p_from: range.from ?? null,
    p_to: range.to ?? null,
  });

  if (error) throw error;
  return (data ?? []) as AccountingLedgerRow[];
}

export async function getPlatformAccounting(range: DateRange = {}): Promise<PlatformAccountingRow[]> {
  const { data, error } = await supabase.rpc('platform_accounting_summary', {
    p_from: range.from ?? null,
    p_to: range.to ?? null,
  });

  if (error) throw error;
  return (data ?? []) as PlatformAccountingRow[];
}

/**
 * Asks the Edge Function for the CSV, writes it into the cache directory and
 * opens the system share sheet so it can go straight into mail, Drive or
 * Dropbox.
 *
 * The file is rendered on the server, under the caller's own session, so the
 * app never has to know how to format money or escape a comma — and an export
 * cannot contain a row the caller is not allowed to read.
 */
export async function exportAccountingCsv(options: {
  scope: AccountingScope | 'platform';
  organizationId?: string;
  range?: DateRange;
  /** Used for the file name only. */
  label?: string;
}): Promise<{ shared: boolean; uri: string }> {
  const csv = await callFunction<string>('accounting-export', {
    scope: options.scope,
    organization_id: options.organizationId,
    from: options.range?.from ?? null,
    to: options.range?.to ?? null,
    format: 'csv',
  });

  if (typeof csv !== 'string' || csv.length === 0) {
    throw new Error('EXPORT_EMPTY');
  }

  const stamp = options.range?.from && options.range?.to
    ? `${options.range.from}_${options.range.to}`
    : new Date().toISOString().slice(0, 10);
  const name = `blup_${options.label ?? options.scope}_${stamp}.csv`;

  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  file.write(csv);

  // Sharing is unavailable on some Android configurations and always on web.
  // The file still exists, so the caller can say where it is rather than
  // pretending the export failed.
  if (!(await Sharing.isAvailableAsync())) {
    return { shared: false, uri: file.uri };
  }

  await Sharing.shareAsync(file.uri, {
    mimeType: 'text/csv',
    UTI: 'public.comma-separated-values-text',
    dialogTitle: 'Účtovný export BLUP',
  });

  return { shared: true, uri: file.uri };
}

/** First and last day of a month offset back from today, as YYYY-MM-DD. */
export function monthRange(monthsAgo = 0): { from: string; to: string; label: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(start), to: iso(end), label: iso(start).slice(0, 7) };
}

/** 1 January to 31 December of the year offset back from today. */
export function yearRange(yearsAgo = 0): { from: string; to: string; label: string } {
  const year = new Date().getUTCFullYear() - yearsAgo;
  return { from: `${year}-01-01`, to: `${year}-12-31`, label: String(year) };
}
