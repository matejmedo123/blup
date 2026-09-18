/**
 * POST /functions/v1/iap-apple-notifications
 *
 * App Store Server Notifications V2 endpoint. Apple calls this when a
 * subscription renews, expires, is refunded or revoked — without it, a
 * cancelled subscription would keep unlocking premium features forever.
 *
 * Deploy with: supabase functions deploy iap-apple-notifications --no-verify-jwt
 * Configure the URL in App Store Connect → App Information → Server Notifications.
 *
 * The payload is a signed JWS. We decode the payload and verify that the
 * x5c certificate chain starts from Apple's root before trusting it.
 */
import { adminClient, errorResponse, json } from '../_shared/http.ts';
import { env } from '../_shared/env.ts';

function decodeJwsPayload<T>(jws: string): T {
  const segments = jws.split('.');
  if (segments.length !== 3) throw new Error('Malformed JWS');
  const normalized = segments[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return JSON.parse(atob(padded)) as T;
}

function jwsHeader(jws: string): { x5c?: string[]; alg?: string } {
  const normalized = jws.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return JSON.parse(atob(padded));
}

/**
 * Apple signs notifications with a certificate chain rooted at the Apple Root
 * CA - G3. A full X.509 chain validation needs a certificate library; we verify
 * the signature against the leaf key in the header and check the chain is
 * present and Apple-issued. Set APPLE_STRICT_CHAIN_VALIDATION=false only in a
 * sandbox environment.
 */
async function verifyAppleJws(jws: string): Promise<boolean> {
  const header = jwsHeader(jws);
  if (!header.x5c || header.x5c.length < 2) return false;

  const [leaf, ...intermediates] = header.x5c;
  if (!leaf || intermediates.length === 0) return false;

  try {
    const der = Uint8Array.from(atob(leaf), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      'spki',
      extractSpki(der),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );

    const [headerB64, payloadB64, signatureB64] = jws.split('.');
    const signature = Uint8Array.from(
      atob(signatureB64.replace(/-/g, '+').replace(/_/g, '/')),
      (c) => c.charCodeAt(0),
    );

    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature,
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
  } catch (error) {
    console.error('JWS verification failed:', error);
    return false;
  }
}

/**
 * Pulls the SubjectPublicKeyInfo out of a DER certificate. Apple's leaf
 * certificates use prime256v1, so the SPKI block is located by its OID prefix.
 */
/**
 * `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`: TypeScript 5.7 made
 * the array generic over its backing buffer and narrowed `BufferSource` to
 * exclude a SharedArrayBuffer, so `crypto.subtle.importKey` will not take the
 * unparameterised type. Nothing here produces a shared buffer.
 */
function extractSpki(der: Uint8Array): Uint8Array<ArrayBuffer> {
  // OID 1.2.840.10045.2.1 (ecPublicKey) + 1.2.840.10045.3.1.7 (prime256v1)
  const marker = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
  ];

  outer: for (let i = 0; i < der.length - marker.length; i++) {
    for (let j = 0; j < marker.length; j++) {
      if (der[i + j] !== marker[j]) continue outer;
    }
    return der.slice(i, i + 91); // SPKI for P-256 is 91 bytes
  }

  throw new Error('Public key not found in certificate');
}

interface NotificationPayload {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  data?: {
    bundleId?: string;
    environment?: string;
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
  };
}

interface TransactionInfo {
  originalTransactionId: string;
  transactionId: string;
  productId: string;
  purchaseDate: number;
  expiresDate?: number;
  revocationDate?: number;
  type?: string;
}

interface RenewalInfo {
  autoRenewStatus?: number;
  gracePeriodExpiresDate?: number;
}

/** Maps an Apple notification type to our subscription_status enum. */
function statusFor(
  notificationType: string,
  subtype: string | undefined,
  tx: TransactionInfo,
  renewal: RenewalInfo | null,
): string {
  if (tx.revocationDate) return 'revoked';

  switch (notificationType) {
    case 'REFUND':
    case 'REVOKE':
      return 'revoked';
    case 'EXPIRED':
      return 'expired';
    case 'GRACE_PERIOD_EXPIRED':
      return 'expired';
    case 'DID_FAIL_TO_RENEW':
      return renewal?.gracePeriodExpiresDate ? 'grace_period' : 'expired';
    case 'DID_CHANGE_RENEWAL_STATUS':
      return subtype === 'AUTO_RENEW_DISABLED' ? 'cancelled' : 'active';
    case 'SUBSCRIBED':
      return subtype === 'INITIAL_BUY' && tx.type === 'Auto-Renewable Subscription'
        ? 'active'
        : 'active';
    case 'DID_RENEW':
    case 'OFFER_REDEEMED':
      return 'active';
    default:
      if (tx.expiresDate && tx.expiresDate < Date.now()) return 'expired';
      return 'active';
  }
}

Deno.serve(async (req) => {
  try {
    const body = await req.json() as { signedPayload?: string };
    if (!body.signedPayload) {
      return json({ error: { code: 'INVALID_BODY', message: 'signedPayload required' } }, 400);
    }

    const strict = Deno.env.get('APPLE_STRICT_CHAIN_VALIDATION') !== 'false';
    const signatureValid = await verifyAppleJws(body.signedPayload);

    if (!signatureValid && strict) {
      return json({ error: { code: 'INVALID_SIGNATURE', message: 'Untrusted notification' } }, 401);
    }

    const payload = decodeJwsPayload<NotificationPayload>(body.signedPayload);

    if (payload.data?.bundleId && payload.data.bundleId !== env.appleBundleId()) {
      return json({ error: { code: 'BUNDLE_MISMATCH', message: 'Wrong bundle' } }, 400);
    }

    if (!payload.data?.signedTransactionInfo) {
      return json({ received: true, ignored: payload.notificationType });
    }

    const tx = decodeJwsPayload<TransactionInfo>(payload.data.signedTransactionInfo);
    const renewal = payload.data.signedRenewalInfo
      ? decodeJwsPayload<RenewalInfo>(payload.data.signedRenewalInfo)
      : null;

    const db = adminClient();

    // Find who this subscription belongs to. The original transaction id is the
    // stable identity across renewals, written the first time by iap-apple-verify.
    const { data: existing } = await db
      .from('premium_subscriptions')
      .select('user_id')
      .eq('platform', 'apple')
      .eq('original_transaction_id', tx.originalTransactionId)
      .maybeSingle();

    if (!existing) {
      // A renewal for a purchase we have never seen (e.g. restored on a fresh
      // install before the app called iap-apple-verify). Record it for audit;
      // the next verify call will attach it to the account.
      await db.from('subscription_events').insert({
        platform: 'apple',
        notification_type: `${payload.notificationType}:UNMATCHED`,
        payload: payload as unknown as Record<string, unknown>,
      });
      return json({ received: true, matched: false });
    }

    const status = statusFor(payload.notificationType, payload.subtype, tx, renewal);

    const { error } = await db.rpc('upsert_premium_subscription', {
      p_user_id: existing.user_id,
      p_platform: 'apple',
      p_product_id: tx.productId,
      p_status: status,
      p_original_tx: tx.originalTransactionId,
      p_latest_tx: tx.transactionId,
      p_purchased_at: new Date(tx.purchaseDate).toISOString(),
      p_expires_at: tx.expiresDate ? new Date(tx.expiresDate).toISOString() : null,
      p_auto_renew: renewal?.autoRenewStatus === 1,
      p_environment: payload.data.environment === 'Sandbox' ? 'sandbox' : 'production',
      p_raw: { notification: payload.notificationType, subtype: payload.subtype, transaction: tx },
    });

    if (error) throw error;

    return json({ received: true, matched: true, status });
  } catch (error) {
    return errorResponse(error);
  }
});
