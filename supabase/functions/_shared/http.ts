/**
 * Shared HTTP plumbing for every Edge Function: CORS, JSON responses,
 * typed errors, caller authentication and a small in-memory rate limiter.
 */
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { ConfigurationError, env } from './env.ts';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, stripe-signature',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function json(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return json({ error: { code: error.code, message: error.message, details: error.details } }, error.status);
  }
  if (error instanceof ConfigurationError) {
    // 503: the feature exists but this deployment has no credentials for it.
    return json({ error: { code: error.code, message: error.message } }, 503);
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';
  // Postgres exceptions raised by our functions surface as readable codes.
  const known = [
    'SOLD_OUT', 'ORDER_NOT_FOUND', 'EVENT_NOT_AVAILABLE', 'QUANTITY_ABOVE_LIMIT',
    'SALES_ENDED', 'SALES_NOT_STARTED', 'TICKET_TYPE_INACTIVE', 'NOT_AUTHORIZED',
    'PAID_EVENT_REQUIRES_ORGANIZATION', 'ORGANIZATION_NOT_VERIFIED',
    'INSUFFICIENT_AVAILABLE_BALANCE', 'PAYOUTS_NOT_ENABLED', 'AMOUNT_MISMATCH',
  ].find((code) => message.includes(code));

  if (known) {
    return json({ error: { code: known, message } }, known === 'NOT_AUTHORIZED' ? 403 : 400);
  }

  console.error('Unhandled error:', error);
  return json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } }, 500);
}

/** Service-role client: bypasses RLS. Only ever used inside Edge Functions. */
export function adminClient(): SupabaseClient {
  return createClient(env.supabaseUrl(), env.serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * A client that carries the caller's own JWT, so `auth.uid()` is set inside
 * PostgreSQL and RLS — plus any SECURITY DEFINER function that authorizes on
 * `auth.uid()` — applies to them personally.
 *
 * Reach for this instead of `adminClient()` whenever the database is the thing
 * deciding what the caller may see. A service-role client makes `auth.uid()`
 * null, which those functions read as "an Edge Function acting on an already
 * authorized request" — exactly the check you did not want to skip.
 */
export function userClient(req: Request): SupabaseClient {
  const authHeader = req.headers.get('Authorization') ?? '';
  return createClient(env.supabaseUrl(), env.anonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
}

/**
 * Resolves the calling user from the Authorization header. Every function that
 * acts on behalf of a user must call this — we never trust a user id sent in
 * the request body.
 */
export async function requireUser(req: Request): Promise<{ id: string; email?: string }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new ApiError('UNAUTHENTICATED', 'Missing bearer token', 401);
  }

  const token = authHeader.slice('Bearer '.length);
  const { data, error } = await adminClient().auth.getUser(token);

  if (error || !data.user) {
    throw new ApiError('UNAUTHENTICATED', 'Invalid or expired session', 401);
  }

  return { id: data.user.id, email: data.user.email ?? undefined };
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiError('INVALID_BODY', 'Request body must be valid JSON', 400);
  }
}

/**
 * Best-effort per-instance rate limiting. Edge Functions are horizontally
 * scaled, so this is a cheap first line of defence, not a global quota;
 * hard limits belong in the database (unique constraints) and at the gateway.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    throw new ApiError('RATE_LIMITED', 'Too many requests, slow down', 429);
  }
}

export function handleOptions(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', { headers: corsHeaders }) : null;
}
