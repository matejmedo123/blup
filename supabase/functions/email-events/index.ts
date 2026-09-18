/**
 * POST /functions/v1/email-events
 *
 * What the mail provider tells us back.
 *
 * Deploy without JWT verification — the provider has no session:
 *
 *   supabase functions deploy email-events --no-verify-jwt
 *
 * The Svix signature below is what authenticates the request, and it is not
 * optional: without it, anybody who learns this URL could mark any address on
 * BLUP as undeliverable and silently cut that person off from their tickets.
 *
 * Why this exists at all: `email_contacts.bounced_at` and `complained_at` have
 * existed since the mailing migration, `mark_email_undeliverable()` was written
 * to set them, and NOTHING EVER CALLED IT. Bounces are the single fastest way
 * to lose a sending domain — a mailbox provider watches what share of your mail
 * hits dead addresses, and a sender that keeps retrying them stops reaching the
 * live ones too. Which is exactly the complaint: "nech tie emaily vôbec aj
 * prídu".
 */
import {
  ApiError, adminClient, errorResponse, handleOptions, json,
} from '../_shared/http.ts';
import { env } from '../_shared/env.ts';

interface SvixHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

function readSvixHeaders(req: Request): SvixHeaders {
  const id = req.headers.get('svix-id') ?? req.headers.get('webhook-id');
  const timestamp = req.headers.get('svix-timestamp') ?? req.headers.get('webhook-timestamp');
  const signature = req.headers.get('svix-signature') ?? req.headers.get('webhook-signature');

  if (!id || !timestamp || !signature) {
    throw new ApiError('INVALID_SIGNATURE', 'Missing webhook signature headers', 400);
  }
  return { id, timestamp, signature };
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

/**
 * Svix's scheme, which Resend uses: HMAC-SHA256 over `id.timestamp.body`, keyed
 * with the base64 part of a `whsec_…` secret, compared against any of the
 * space-separated `v1,<base64>` signatures in the header (there are several
 * during a secret rotation).
 */
async function verifySignature(payload: string, headers: SvixHeaders): Promise<void> {
  const age = Math.abs(Date.now() / 1000 - Number(headers.timestamp));
  if (!Number.isFinite(age) || age > 300) {
    throw new ApiError('INVALID_SIGNATURE', 'Webhook timestamp outside tolerance', 400);
  }

  const raw = env.resendWebhookSecret();
  const secret = raw.startsWith('whsec_') ? raw.slice('whsec_'.length) : raw;

  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(atob(secret), (c) => c.charCodeAt(0)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${headers.id}.${headers.timestamp}.${payload}`),
  );
  const expected = new Uint8Array(signed);

  const offered = headers.signature
    .split(' ')
    .map((part) => part.split(',', 2))
    .filter(([version]) => version === 'v1')
    .map(([, value]) => value);

  for (const candidate of offered) {
    try {
      const bytes = Uint8Array.from(atob(candidate), (c) => c.charCodeAt(0));
      if (timingSafeEqual(bytes, expected)) return;
    } catch {
      // A malformed candidate is simply not a match.
    }
  }

  throw new ApiError('INVALID_SIGNATURE', 'Webhook signature mismatch', 400);
}

interface ResendEvent {
  type?: string;
  data?: {
    to?: string | string[];
    email_id?: string;
    bounce?: { type?: string };
  };
}

/** The address a provider event is about, whatever shape it arrives in. */
function recipientOf(event: ResendEvent): string | null {
  const to = event.data?.to;
  const address = Array.isArray(to) ? to[0] : to;
  return typeof address === 'string' && address.includes('@') ? address : null;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    if (req.method !== 'POST') {
      throw new ApiError('METHOD_NOT_ALLOWED', 'Use POST', 405);
    }

    // Read the body as text ONCE: the signature covers the exact bytes sent,
    // so re-serializing parsed JSON would verify something else.
    const payload = await req.text();
    await verifySignature(payload, readSvixHeaders(req));

    let event: ResendEvent;
    try {
      event = JSON.parse(payload) as ResendEvent;
    } catch {
      throw new ApiError('INVALID_BODY', 'Body is not JSON', 400);
    }

    const address = recipientOf(event);
    const type = event.type ?? '';
    const db = adminClient();

    // A complaint is somebody pressing "this is spam". It is more serious than
    // a bounce: it is a person saying they do not want this, so it stops the
    // digest as well as the address.
    if (type === 'email.complained') {
      if (address) {
        await db.rpc('mark_email_undeliverable', { p_email: address, p_complaint: true });
      }
      return json({ handled: 'complaint' });
    }

    // Only a HARD bounce means the mailbox does not exist. A soft bounce is a
    // full inbox or a greylist, and treating it as permanent would throw away a
    // real person's ticket e-mail over a temporary condition.
    if (type === 'email.bounced') {
      const kind = event.data?.bounce?.type ?? 'Permanent';
      if (address && kind.toLowerCase().startsWith('perm')) {
        await db.rpc('mark_email_undeliverable', { p_email: address, p_complaint: false });
        return json({ handled: 'hard_bounce' });
      }
      return json({ handled: 'soft_bounce_ignored' });
    }

    // Everything else — delivered, opened, clicked — is acknowledged so the
    // provider stops retrying, and deliberately not recorded. Open tracking
    // means a tracking pixel in somebody's ticket e-mail, and we do not need
    // to know when they read it.
    return json({ handled: 'ignored', type });
  } catch (error) {
    return errorResponse(error);
  }
});
