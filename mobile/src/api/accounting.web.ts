import { callFunction, supabase } from '@/lib/supabase';

/**
 * Accounting — web variant.
 *
 * Identical to the native module except for how the file leaves the app: a
 * browser has no share sheet and no cache directory, so the CSV becomes a Blob
 * and a synthetic `<a download>` click. Everything above that — who may read
 * the rows, how the numbers are computed, how the CSV is formatted — still
 * happens on the server.
 */

export interface AccountingSummaryRow {
  period: string;
  orders_count: number;
  tickets_count: number;
  gross_cents: number;
  discount_cents: number;
  net_cents: number;
  commission_cents: number;
  archive_fee_cents: number;
  blup_revenue_cents: number;
  organizer_net_cents: number;
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
  from?: string | null;
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

export async function exportAccountingCsv(options: {
  scope: AccountingScope | 'platform';
  organizationId?: string;
  range?: DateRange;
  label?: string;
}): Promise<{ shared: boolean; uri: string }> {
  const csv = await callFunction<string>('accounting-export', {
    scope: options.scope,
    organization_id: options.organizationId,
    from: options.range?.from ?? null,
    to: options.range?.to ?? null,
    format: 'csv',
  });

  if (typeof csv !== 'string' || csv.length === 0) throw new Error('EXPORT_EMPTY');

  const stamp = options.range?.from && options.range?.to
    ? `${options.range.from}_${options.range.to}`
    : new Date().toISOString().slice(0, 10);
  const name = `blup_${options.label ?? options.scope}_${stamp}.csv`;

  // text/csv rather than application/octet-stream so the browser offers a
  // sensible default app, and the BOM the server already wrote survives.
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in Safari; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return { shared: true, uri: name };
}

export function monthRange(monthsAgo = 0): { from: string; to: string; label: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(start), to: iso(end), label: iso(start).slice(0, 7) };
}

export function yearRange(yearsAgo = 0): { from: string; to: string; label: string } {
  const year = new Date().getUTCFullYear() - yearsAgo;
  return { from: `${year}-01-01`, to: `${year}-12-31`, label: String(year) };
}
