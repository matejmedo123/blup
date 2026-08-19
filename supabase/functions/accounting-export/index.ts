/**
 * POST /functions/v1/accounting-export
 *
 * Renders an organizer's (or, for an admin, the platform's) books as CSV.
 *
 * Body: {
 *   organization_id?: string,          // required for every scope but 'platform'
 *   scope: 'orders' | 'ledger' | 'summary' | 'platform',
 *   from?: 'YYYY-MM-DD',
 *   to?:   'YYYY-MM-DD',
 *   format?: 'csv' | 'json'            // default csv
 * }
 *
 * The database decides what the caller may read, so the query runs under the
 * caller's own JWT rather than the service role: accounting_orders() and its
 * siblings authorize on auth.uid(), and a service-role call would present as
 * "no user" and skip that check entirely.
 *
 * Amounts leave here as decimal strings in the row's own currency, which is
 * what bookkeeping software imports. The raw minor units stay in the database.
 */
import {
  ApiError, errorResponse, handleOptions, json, rateLimit, readJson, requireUser, userClient,
} from '../_shared/http.ts';

type Scope = 'orders' | 'ledger' | 'summary' | 'platform';

interface ExportBody {
  organization_id?: string;
  scope?: Scope;
  from?: string;
  to?: string;
  format?: 'csv' | 'json';
}

const SCOPES: Scope[] = ['orders', 'ledger', 'summary', 'platform'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Columns whose values are minor units and should be printed as decimals. */
const MONEY_SUFFIX = '_cents';

/**
 * RFC 4180 quoting. A field is quoted when it contains the separator, a quote
 * or a line break; embedded quotes are doubled.
 */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatCell(key: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (key.endsWith(MONEY_SUFFIX) && typeof value === 'number') {
    return (value / 100).toFixed(2);
  }
  return String(value);
}

/** Header labels drop the `_cents` noise — the currency column already says it. */
function headerLabel(key: string): string {
  return key.endsWith(MONEY_SUFFIX) ? key.slice(0, -MONEY_SUFFIX.length) : key;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const keys = Object.keys(rows[0]);
  const lines = [keys.map(headerLabel).map(csvField).join(',')];

  for (const row of rows) {
    lines.push(keys.map((key) => csvField(formatCell(key, row[key]))).join(','));
  }

  // The BOM is what makes Excel open a UTF-8 file as UTF-8 instead of guessing
  // a legacy code page and mangling every accented character in an event title.
  return `﻿${lines.join('\r\n')}\r\n`;
}

function filename(scope: Scope, from?: string, to?: string): string {
  const period = from || to ? `_${from ?? 'zaciatok'}_${to ?? 'dnes'}` : '';
  return `blup_${scope}${period}.csv`;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const user = await requireUser(req);
    // Exports are expensive to build and rarely needed in bursts.
    rateLimit(`accounting:${user.id}`, 12, 60_000);

    const body = await readJson<ExportBody>(req);
    const scope: Scope = body.scope ?? 'summary';
    const format = body.format ?? 'csv';

    if (!SCOPES.includes(scope)) {
      throw new ApiError('INVALID_BODY', `scope must be one of ${SCOPES.join(', ')}`);
    }
    if (scope !== 'platform' && !body.organization_id) {
      throw new ApiError('INVALID_BODY', 'organization_id is required for this scope');
    }
    for (const [name, value] of [['from', body.from], ['to', body.to]] as const) {
      if (value && !DATE.test(value)) {
        throw new ApiError('INVALID_BODY', `${name} must be a YYYY-MM-DD date`);
      }
    }
    if (body.from && body.to && body.from > body.to) {
      throw new ApiError('INVALID_BODY', 'from must not be after to');
    }

    const db = userClient(req);
    const range = { p_from: body.from ?? null, p_to: body.to ?? null };

    const rpc = scope === 'platform'
      ? db.rpc('platform_accounting_summary', range)
      : db.rpc(`accounting_${scope}`, { p_organization_id: body.organization_id, ...range });

    const { data, error } = await rpc;

    if (error) {
      // NOT_AUTHORIZED from the database is a 403, not a 500.
      throw new Error(error.message);
    }

    const rows = (data ?? []) as Record<string, unknown>[];

    if (format === 'json') {
      return json({ scope, from: body.from ?? null, to: body.to ?? null, rows });
    }

    return new Response(toCsv(rows), {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename(scope, body.from, body.to)}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
});
